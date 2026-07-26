import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { type DirIdentity, dirIdentity, isSameDirPath, sameDir } from './dir-identity.js';

/**
 * 解析该目录所属仓库的 .git 公共目录身份。
 *
 * 用身份而不是路径字符串：主仓库与其 worktree 拿到的 `--git-common-dir` 写法可能
 * 不同（相对/绝对、8.3 短名/长名），字符串比会把同一个仓库判成两个。详见
 * dir-identity.ts 的说明。
 */
function gitCommonDirIdentity(dir: string): DirIdentity | null {
  try {
    const d = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return dirIdentity(resolve(dir, d));
  } catch {
    return null;
  }
}

let cachedRepoGitDir: DirIdentity | null | undefined;

export function initRepoIdentity(repoRoot: string): void {
  cachedRepoGitDir = gitCommonDirIdentity(repoRoot);
}

export function isSameRepo(projectPath: string, repoRoot: string): boolean {
  if (isSameDirPath(projectPath, repoRoot)) return true;
  if (cachedRepoGitDir === undefined) initRepoIdentity(repoRoot);
  if (!cachedRepoGitDir) return false;

  return sameDir(gitCommonDirIdentity(projectPath), cachedRepoGitDir);
}
