/**
 * 平台进程探针 —— 给 acp-child-registry 的孤儿回收提供「这个 pid 现在是谁」。
 *
 * 单独成文件是为了让回收逻辑本身保持可测：registry 只依赖 ReapDeps 接口，
 * 测试注入假探针，不碰真实进程；这里才是唯一需要 spawn 外部命令的地方。
 *
 * 只在 API 启动时调用一次（批量查询全部候选 pid），不在热路径上。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LiveProcessInfo, ReapDeps } from './acp-child-registry.js';

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === 'win32';
const PROBE_TIMEOUT_MS = 10_000;

/** Win32_Process 查询：一次拿到 pid / 创建时间(epoch ms) / 映像名。 */
async function probeWindows(pids: readonly number[]): Promise<LiveProcessInfo[]> {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' or ');
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue`,
    '$epoch = [datetime]::SpecifyKind([datetime]"1970-01-01", "Utc")',
    '$out = @($p | ForEach-Object {',
    '  [pscustomobject]@{',
    '    pid = [int]$_.ProcessId',
    '    startedAtMs = [long]($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds',
    '    image = if ($_.ExecutablePath) { $_.ExecutablePath } else { $_.Name }',
    '  }',
    '})',
    'ConvertTo-Json -InputObject $out -Compress',
  ].join('; ');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
  );
  return parseProbeJson(stdout);
}

/** POSIX：etimes 是已运行秒数，start ≈ now - etimes（秒级精度，容差足够覆盖）。 */
async function probePosix(pids: readonly number[]): Promise<LiveProcessInfo[]> {
  const { stdout } = await execFileAsync('ps', ['-o', 'pid=,etimes=,comm=', '-p', pids.join(',')], {
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  }).catch((err: NodeJS.ErrnoException & { stdout?: string }) => {
    // 所有 pid 都不存在时 ps 以非 0 退出 —— 这是正常情况，不是故障。
    if (typeof err.stdout === 'string') return { stdout: err.stdout };
    if (err.code === 'ENOENT') throw err; // 没有 ps 才是真故障
    return { stdout: '' };
  });

  const now = Date.now();
  const infos: LiveProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    infos.push({
      pid: Number(m[1]),
      startedAtMs: now - Number(m[2]) * 1000,
      image: m[3]!.trim(),
    });
  }
  return infos;
}

function parseProbeJson(stdout: string): LiveProcessInfo[] {
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const infos: LiveProcessInfo[] = [];
  for (const row of rows) {
    const r = row as { pid?: unknown; startedAtMs?: unknown; image?: unknown };
    if (typeof r?.pid === 'number' && typeof r.startedAtMs === 'number' && typeof r.image === 'string') {
      infos.push({ pid: r.pid, startedAtMs: r.startedAtMs, image: r.image });
    }
  }
  return infos;
}

export async function probeLiveProcesses(pids: readonly number[]): Promise<LiveProcessInfo[]> {
  if (pids.length === 0) return [];
  return IS_WINDOWS ? probeWindows(pids) : probePosix(pids);
}

/**
 * Windows 没有真信号：SIGTERM 会被 Node 翻译成 TerminateProcess，SIGKILL 同理。
 * 这对 carrier 来说是可接受的 —— 我们要的就是让它消失；宽限期仍然保留，
 * 以便 POSIX 上先给它自己收尾的机会。
 */
export function killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export const platformReapDeps: Pick<ReapDeps, 'probe' | 'kill'> = {
  probe: probeLiveProcesses,
  kill: killProcess,
};
