#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function runGit(argsForGit, cwd = process.cwd()) {
  return spawnSync('git', argsForGit, {
    cwd,
    encoding: 'utf8',
  });
}

function findClowderRepoRoot(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(resolve(current, 'pnpm-workspace.yaml')) && existsSync(resolve(current, 'ecosystem.config.cjs'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function isSensitiveUntrackedPath(filePath) {
  return (
    filePath === 'package.json' ||
    filePath === 'pnpm-lock.yaml' ||
    filePath === 'pnpm-workspace.yaml' ||
    filePath === 'ecosystem.config.cjs' ||
    filePath.startsWith('packages/') ||
    filePath.startsWith('scripts/') ||
    filePath.startsWith('cat-cafe-skills/')
  );
}

export function parseDirtyEntries(rawStatus) {
  return rawStatus
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const code = line.slice(0, 2);
      const rawPath = line.slice(3);
      if (code === '??') {
        return isSensitiveUntrackedPath(rawPath) ? [{ code, path: rawPath }] : [];
      }
      return [{ code, path: rawPath }];
    });
}

/* ── CLI-only guard: side effects only run when executed directly ── */
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (isMain) {
  const args = process.argv.slice(2);
  const artifacts = [];
  let checkOnly = false;
  let commandIndex = -1;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      commandIndex = index;
      break;
    }
    if (arg === '--artifact') {
      const artifact = args[index + 1];
      if (!artifact) {
        console.error('[live-build-gate] --artifact requires a relative path');
        process.exit(2);
      }
      artifacts.push(artifact);
      index += 1;
      continue;
    }
    if (arg === '--check-only') {
      checkOnly = true;
      continue;
    }
    console.error(`[live-build-gate] unknown argument: ${arg}`);
    process.exit(2);
  }

  const command = commandIndex >= 0 ? args.slice(commandIndex + 1) : [];

  const markerRoot = findClowderRepoRoot(process.cwd());
  const rootResult = markerRoot ? null : runGit(['rev-parse', '--show-toplevel']);
  if (!markerRoot && rootResult?.status !== 0) {
    console.error('[live-build-gate] current directory is not inside a git worktree');
    process.exit(1);
  }

  const repoRoot = markerRoot ?? rootResult.stdout.trim();
  const statusResult = spawnSync('git', ['status', '--porcelain=v1', '-uall'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (statusResult.status !== 0) {
    console.error(statusResult.stderr || '[live-build-gate] failed to read git status');
    process.exit(1);
  }

  const dirtyEntries = parseDirtyEntries(statusResult.stdout);

  function missingArtifacts() {
    return artifacts.filter((artifact) => !existsSync(resolve(process.cwd(), artifact)));
  }

  function printDirtySummary() {
    console.warn('[live-build-gate] worktree has uncommitted runtime-sensitive changes; skipping live rebuild');
    for (const entry of dirtyEntries.slice(0, 12)) {
      console.warn(`[live-build-gate] ${entry.code} ${entry.path}`);
    }
    if (dirtyEntries.length > 12) {
      console.warn(`[live-build-gate] ... ${dirtyEntries.length - 12} more`);
    }
  }

  if (dirtyEntries.length > 0) {
    printDirtySummary();
    const missing = missingArtifacts();
    if (missing.length > 0) {
      console.error(
        `[live-build-gate] refusing to start from a dirty tree because required good artifact(s) are missing: ${missing.join(', ')}`,
      );
      process.exit(1);
    }
    console.warn('[live-build-gate] using existing committed build artifact(s)');
    process.exit(checkOnly ? 10 : 0);
  }

  console.log(`[live-build-gate] clean worktree at ${relative(process.cwd(), repoRoot) || '.'}; live rebuild allowed`);

  if (checkOnly || command.length === 0) {
    process.exit(0);
  }

  const child = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  process.exit(child.status ?? 1);
}
