/**
 * Windows 系统代理自动注入。
 *
 * Kiro/VSCode 这类 Electron 应用自动继承 WinINET 系统代理，而 Node CLI
 * （cursor-agent / claude / codex …）只认 HTTP(S)_PROXY 环境变量。用户开着
 * 系统代理（如 Clash 127.0.0.1:7890）时，不带 env 的 CLI 直连出网，轻则拿到
 * 残缺的模型目录（cursor-agent models 少一大半），重则直接超时。
 *
 * 这里在 API 启动时读一次注册表，把系统代理写进 process.env；所有 provider
 * 子进程经 buildChildEnv 克隆 process.env 自动继承。显式配置永远优先：
 * .env 或外部环境已设任一代理变量时不做任何注入。
 */
import { execFileSync } from 'node:child_process';

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

/** ProxyServer 注册表值 → 代理 URL。支持 "host:port" 与 "http=…;https=…;socks=…" 两种形态。 */
export function parseProxyServerValue(server: string): string | null {
  const trimmed = server.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('=')) {
    return trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  }
  const byScheme = new Map<string, string>();
  for (const part of trimmed.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    byScheme.set(part.slice(0, idx).trim().toLowerCase(), part.slice(idx + 1).trim());
  }
  const addr = byScheme.get('https') ?? byScheme.get('http');
  if (addr) return addr.includes('://') ? addr : `http://${addr}`;
  const socks = byScheme.get('socks');
  if (socks) return socks.includes('://') ? socks : `socks5://${socks}`;
  return null;
}

function readWinInetProxy(): string | null {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 3_000, windowsHide: true },
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out)) return null;
    const m = out.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
    if (!m?.[1]) return null;
    return parseProxyServerValue(m[1]);
  } catch {
    return null;
  }
}

export function injectWindowsSystemProxy(): void {
  if (process.platform !== 'win32') return;
  // 显式配置优先：.env 或外部环境已有任一代理变量时，完全不动
  if (PROXY_ENV_KEYS.some((k) => Boolean(process.env[k]))) return;
  const proxyUrl = readWinInetProxy();
  if (!proxyUrl) return;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  // 本机回环必须直连：MCP 回调（127.0.0.1:3004）与本地服务不得进代理
  process.env.NO_PROXY ??= 'localhost,127.0.0.1,::1';
  console.log(
    `[system-proxy] 检测到 Windows 系统代理 ${proxyUrl}，已注入 CLI 子进程环境（NO_PROXY=${process.env.NO_PROXY}）`,
  );
}
