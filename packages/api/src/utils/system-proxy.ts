/**
 * Windows 系统代理读取 —— 把「Clash 开了系统代理」翻译成 CLI 子进程认得的环境变量。
 *
 * 为什么需要它（2026-08-17 实测）：
 * - grok（xAI Grok Build，Rust）**只认** HTTP_PROXY/HTTPS_PROXY 环境变量，
 *   不读 Windows 系统代理。喂死代理会失败、喂真代理 2 秒过。而它要拉
 *   storage.googleapis.com，直连极慢（一次版本检查 69s）。
 * - kiro-cli / cursor-agent 反过来：完全无视 HTTP_PROXY（喂死代理照样成功），
 *   它们的服务端直连本来就通。所以注入这些变量对它们无影响。
 *
 * 硬约束：**只读注册表，绝不修改系统代理设置**。铲屎官的代理由 Clash 独占管理。
 */

import { execFileSync } from 'node:child_process';

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 读一次注册表约几十毫秒；派工可能密集，用短 TTL 缓存兼顾「Clash 中途开关」与开销。 */
const CACHE_TTL_MS = 5_000;

export interface SystemProxyEnv {
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  ALL_PROXY?: string;
  NO_PROXY?: string;
}

let cache: { at: number; value: SystemProxyEnv } | null = null;

/** 测试用：清空缓存。 */
export function resetSystemProxyCacheForTests(): void {
  cache = null;
}

function queryRegistry(valueName: string, runner: RegQueryRunner): string | null {
  try {
    const stdout = runner(['query', INTERNET_SETTINGS_KEY, '/v', valueName]);
    // 形如：    ProxyServer    REG_SZ    127.0.0.1:7890
    const match = stdout.match(new RegExp(`${valueName}\\s+REG_\\w+\\s+(.+)`, 'i'));
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 ProxyServer 值里取出可用的 host:port。
 * 可能是裸 `127.0.0.1:7890`，也可能是 `http=host:1;https=host:2;ftp=...` 的分协议形式。
 */
export function parseProxyServerValue(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (!value.includes('=')) return value;
  const parts = value.split(';').map((part) => part.trim());
  for (const key of ['https', 'http']) {
    const hit = parts.find((part) => part.toLowerCase().startsWith(`${key}=`));
    if (hit) return hit.slice(key.length + 1).trim() || null;
  }
  return null;
}

/** 把 Windows 的 ProxyOverride（`<local>;*.corp.com`）转成 NO_PROXY 形式。 */
export function parseProxyOverride(raw: string | null): string | null {
  if (!raw) return null;
  const items = raw
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item && item !== '<local>');
  const hasLocal = /<local>/i.test(raw);
  if (hasLocal) items.push('localhost', '127.0.0.1');
  return items.length > 0 ? items.join(',') : null;
}

type RegQueryRunner = (args: readonly string[]) => string;

const defaultRunner: RegQueryRunner = (args) =>
  execFileSync('reg', [...args], { encoding: 'utf-8', timeout: 3_000, windowsHide: true });

export interface SystemProxyOptions {
  readonly platform?: NodeJS.Platform;
  /** 父进程已有的环境；已显式配过代理时一律不覆盖。 */
  readonly env?: NodeJS.ProcessEnv;
  readonly runner?: RegQueryRunner;
  readonly now?: () => number;
  readonly useCache?: boolean;
}

/**
 * 返回应注入子进程的代理环境变量。拿不到或未启用时返回空对象。
 *
 * 优先级：父进程已有 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY 时直接放弃 ——
 * 显式配置（CLI runtime profile 的 envVars、账号 env、启动脚本）永远赢过自动探测。
 */
/** 父进程是否已显式配过代理（大小写两种写法都算）。 */
function hasExplicitProxy(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.HTTP_PROXY || env.HTTPS_PROXY || env.ALL_PROXY || env.http_proxy || env.https_proxy);
}

/** 真正读注册表那一段。未启用或读不到时返回空对象。 */
function readProxyFromRegistry(runner: RegQueryRunner): SystemProxyEnv {
  // ProxyEnable 是 REG_DWORD，reg query 打印成 0x1 / 0x0
  const enabled = queryRegistry('ProxyEnable', runner);
  if (!enabled || Number.parseInt(enabled, 16) === 0) return {};

  const server = queryRegistry('ProxyServer', runner);
  const hostPort = server ? parseProxyServerValue(server) : null;
  if (!hostPort) return {};

  const url = /^\w+:\/\//.test(hostPort) ? hostPort : `http://${hostPort}`;
  // grok 的 Rust HTTP 栈也读 ALL_PROXY；统一给 http 形式（Clash 混合端口同时收 http/socks）
  const result: SystemProxyEnv = { HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url };
  const noProxy = parseProxyOverride(queryRegistry('ProxyOverride', runner));
  if (noProxy) result.NO_PROXY = noProxy;
  return result;
}

export function getSystemProxyEnv(options: SystemProxyOptions = {}): SystemProxyEnv {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform !== 'win32' && !options.runner) return {};
  if (hasExplicitProxy(env)) return {};

  const now = options.now ?? Date.now;
  const useCache = options.useCache ?? true;
  if (useCache && cache && now() - cache.at < CACHE_TTL_MS) return { ...cache.value };

  const result = readProxyFromRegistry(options.runner ?? defaultRunner);
  if (useCache) cache = { at: now(), value: { ...result } };
  return result;
}
