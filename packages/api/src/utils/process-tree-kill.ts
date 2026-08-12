/**
 * Process-tree termination (Windows 僵尸写手根因修复, 2026-08-12 quant 事故).
 *
 * Windows 上 `child.kill()` 只终止直接子进程。CLI provider 常经包装进程启动
 * （.cmd/.ps1 shim → powershell.exe / cmd.exe / git-bash），超时或取消时只杀掉
 * 包装层，真正的 CLI 孙进程沦为孤儿——它继续执行任务、继续写项目工作树，而
 * 上游已把 invocation 标记为结束并释放了 (thread, cat) 槽位，随后同一只猫被
 * 二次派工拉起第二个进程（甚至 resume 同一会话）→「同一个模型、两个进程干
 * 同一件事」。
 *
 * `taskkill /pid <pid> /T /F` 会枚举并击杀整棵进程树。POSIX 不走本模块：
 * 那里 CLI 直接 spawn，直接子进程就是 agent 本体，原信号路径已足够。
 */

import { execFile, spawnSync } from 'node:child_process';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('process-tree-kill');

const TASKKILL_TIMEOUT_MS = 10_000;

type ExecFileFn = (
  command: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean },
  callback: (error: Error | null) => void,
) => unknown;

type SpawnSyncFn = (
  command: string,
  args: readonly string[],
  options: { timeout?: number; windowsHide?: boolean },
) => { status: number | null };

export interface TreeKillDeps {
  platform?: NodeJS.Platform;
  execFileFn?: ExecFileFn;
  spawnSyncFn?: SpawnSyncFn;
}

/**
 * 击杀 pid 及其全部后代。成功 resolve true；失败 resolve false（调用方回退
 * 到直接 child.kill）。永不 reject——击杀路径上抛错只会制造更多孤儿。
 */
export function killProcessTree(pid: number, deps?: TreeKillDeps): Promise<boolean> {
  const platform = deps?.platform ?? process.platform;
  if (platform !== 'win32') return Promise.resolve(false);
  const run = deps?.execFileFn ?? (execFile as unknown as ExecFileFn);
  return new Promise((resolve) => {
    run('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: TASKKILL_TIMEOUT_MS, windowsHide: true }, (error) => {
      if (error) {
        log.warn({ pid, error: error.message }, 'taskkill process-tree kill failed');
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

/**
 * 同步变体，供 process 'exit' handler 使用（退出钩子里异步 spawn 不保证执行）。
 */
export function killProcessTreeSync(pid: number, deps?: TreeKillDeps): boolean {
  const platform = deps?.platform ?? process.platform;
  if (platform !== 'win32') return false;
  const run = deps?.spawnSyncFn ?? (spawnSync as unknown as SpawnSyncFn);
  try {
    const result = run('taskkill', ['/pid', String(pid), '/T', '/F'], {
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
