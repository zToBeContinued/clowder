/**
 * 目录身份比较 —— 判断两个路径是否指向同一个目录。
 *
 * 不能直接比路径字符串。Windows 上同一个目录可以有多种写法，实测过的一例：
 * 主仓库里 `git rev-parse --git-common-dir` 返回相对路径 `.git`，拼上调用方传入的
 * cwd 后保留了 8.3 短名（`C:\Users\ADMINI~1\...`）；同一仓库的 worktree 里 git 返回
 * 的是它自己记录的绝对路径，用的是长名（`C:\Users\Administrator\...`）。
 * `realpathSync` 只解析符号链接/junction，不展开 8.3 短名，于是两个字符串不相等，
 * 同一个仓库被判成两个仓库 —— 这会让本仓库被误当成外部项目，触发治理门禁，
 * 也会让 marker 写错知识库。
 *
 * 改用 dev+ino 比较文件系统身份：短名、长名、junction 都得到同一个值。ino 拿不到
 * 时（少数文件系统返回 0）退回规范化路径比较，与旧的字符串比较行为等价。
 */

import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DirIdentity {
  /** `dev:ino` 文件系统身份；文件系统不提供 ino 时为 null。 */
  readonly inode: string | null;
  /** 规范化路径，inode 不可用时的兜底比较依据。 */
  readonly path: string;
}

function normalizePath(path: string): string {
  const unified = resolve(path).replace(/\\/g, '/');
  // Windows 路径大小写不敏感，NTFS 上同一目录可以有不同大小写写法。
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/**
 * 规范化真实路径。
 *
 * 优先 `realpathSync.native`：它走 Windows 的 GetFinalPathNameByHandle，会把 8.3
 * 短名展开成长名（实测 `C:\Users\ADMINI~1\...` → `C:\Users\Administrator\...`），
 * 而 JS 版的 `realpathSync` 不会。native 在个别平台/句柄场景下会失败，故保留回退。
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return realpathSync(path);
  }
}

/**
 * 解析目录身份。目录不存在或不可读时不失败，退回规范化输入路径 —— 这样调用方
 * 拿到的语义始终是「可比较」的，且退化路径与旧的纯字符串比较保持一致。
 */
export function dirIdentity(path: string): DirIdentity {
  try {
    const real = realPath(path);
    const st = statSync(real);
    return { inode: st.ino ? `${st.dev}:${st.ino}` : null, path: normalizePath(real) };
  } catch {
    return { inode: null, path: normalizePath(path) };
  }
}

/** 两个目录身份是否指向同一目录。任一侧缺 inode 时按规范化路径比较。 */
export function sameDir(a: DirIdentity | null, b: DirIdentity | null): boolean {
  if (!a || !b) return false;
  if (a.inode && b.inode) return a.inode === b.inode;
  return a.path === b.path;
}

/** 便捷形式：直接比较两个路径是否指向同一目录。 */
export function isSameDirPath(a: string, b: string): boolean {
  return sameDir(dirIdentity(a), dirIdentity(b));
}
