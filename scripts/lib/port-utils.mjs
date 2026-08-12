/**
 * 跨平台端口/进程工具（Windows netstat / Unix lsof）。
 * runtime-doctor、stop 等维护命令共用；此前直接调 lsof 在 Windows 上恒空。
 */
import { execFileSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** 监听指定 TCP 端口的进程 PID（无监听返回 ''）。 */
export function listenerPid(port) {
  if (isWindows) {
    // netstat -ano -p TCP 输出:  TCP    0.0.0.0:3004    0.0.0.0:0    LISTENING    31300
    const out = run('netstat', ['-ano', '-p', 'TCP']);
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? '';
      if (local.endsWith(`:${port}`)) return cols.at(-1) ?? '';
    }
    return '';
  }
  const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return out.split(/\s+/).filter(Boolean)[0] || '';
}

/** 进程命令行（用于杀端口前的归属校验；拿不到返回 ''）。 */
export function commandLineOfPid(pid) {
  if (!pid) return '';
  if (isWindows) {
    const out = run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`,
    ]);
    return out;
  }
  return run('ps', ['-p', String(pid), '-o', 'command=']);
}

/** 进程工作目录（Windows 上系统不提供，返回 null 表示「无法判定」而非失败）。 */
export function cwdOfPid(pid) {
  if (!pid) return '';
  if (isWindows) return null;
  const out = run('lsof', ['-p', String(pid)]);
  const line = out.split(/\r?\n/).find((entry) => /\scwd\s/.test(entry));
  if (!line) return '';
  return line.trim().split(/\s+/).at(-1) || '';
}

/** 进程是否存活（signal 0 探测；EPERM 表示活着但无权限）。 */
function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** 杀掉进程树（Windows taskkill /T；Unix 先 TERM 后 KILL）。 */
export function killPidTree(pid, { forceAfterMs = 3000 } = {}) {
  if (!pid) return false;
  if (isWindows) {
    // taskkill 输出是本地化文本（中文系统还常带编码劣化），不可用来判断成败；
    // 以「目标进程是否已消失」为准。
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
    const deadline = Date.now() + forceAfterMs;
    while (pidAlive(pid) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    return !pidAlive(pid);
  }
  try {
    process.kill(Number(pid), 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + forceAfterMs;
  const alive = () => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };
  while (alive() && Date.now() < deadline) {
    // 忙等窗口很短（≤3s），维护脚本可接受
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (alive()) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  return !alive();
}
