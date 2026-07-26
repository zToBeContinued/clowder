import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dirIdentity, isSameDirPath, sameDir } from './dir-identity.js';

export function findMonorepoRoot(start = process.cwd()): string {
  let dir = resolve(start);
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return resolve(start);
}

/**
 * Resolve the git common directory for a project path.
 * Handles both regular repos (.git is a directory) and
 * worktrees (.git is a file pointing to the main repo).
 */
function resolveGitCommonDirPath(projectPath: string): string | null {
  const gitPath = join(projectPath, '.git');
  try {
    const stat = statSync(gitPath);
    if (stat.isDirectory()) return resolve(gitPath);
    // Worktree: .git file contains "gitdir: <path>/worktrees/<name>"
    const content = readFileSync(gitPath, 'utf-8').trim();
    const m = content.match(/^gitdir:\s*(.+)/);
    if (!m) return null;
    const gitdir = resolve(projectPath, m[1]!);
    // .git/worktrees/<name> → .git
    return resolve(gitdir, '..', '..');
  } catch {
    return null;
  }
}

/**
 * Check if two paths belong to the same git project (handles worktrees).
 *
 * 比的是目录身份而不是路径字符串：worktree 与主仓库解析出的 .git 路径写法可能不同
 * （Windows 8.3 短名 vs 长名、大小写差异），字符串比会把同一个项目判成两个，进而
 * 让本仓库被误当成外部项目触发治理门禁。详见 dir-identity.ts。
 */
export function isSameProject(pathA: string, pathB: string): boolean {
  if (isSameDirPath(pathA, pathB)) return true;
  const dirA = resolveGitCommonDirPath(pathA);
  const dirB = resolveGitCommonDirPath(pathB);
  if (dirA === null || dirB === null) return false;
  return sameDir(dirIdentity(dirA), dirIdentity(dirB));
}
