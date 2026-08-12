#!/usr/bin/env node
/**
 * 聊天记录导出同步（跨平台 Node 版；原 thread-exports-sync.sh 依赖
 * find/cmp/shasum，Windows 不可用）。
 *
 * 把下载的 thread markdown 导出同步到：
 * 1) 仓库规范目录 docs/discussions/exported-threads
 * 2) 离线备份目录（macOS 上有 iCloud 时用 iCloud，否则 ~/.cat-cafe/thread-exports）
 *
 * Usage: node scripts/thread-exports-sync.mjs <sync|status>
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const action = process.argv[2] ?? 'status';
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sourceRoot = process.env.THREAD_EXPORT_SOURCE_ROOT ?? join(homedir(), 'Downloads');
const legacySourceRoot = process.env.THREAD_EXPORT_LEGACY_SOURCE_ROOT ?? join(projectDir, 'docs', 'discussions');
const includeLegacy = (process.env.THREAD_EXPORT_INCLUDE_LEGACY ?? '1') === '1';
const repoDir = process.env.THREAD_EXPORT_REPO_DIR ?? join(projectDir, 'docs', 'discussions', 'exported-threads');

const icloudRoot = join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
const defaultOffsite = existsSync(icloudRoot)
  ? join(icloudRoot, 'CatCafeThreadExports')
  : join(homedir(), '.cat-cafe', 'thread-exports');
const offsiteRoot = process.env.THREAD_EXPORT_OFFSITE_DIR ?? defaultOffsite;
const keepSnapshots = Number(process.env.THREAD_EXPORT_KEEP_SNAPSHOTS ?? 30);

const EXPORT_RE = /^thread-thread_.*\.md$/;

function ensureDirs() {
  for (const dir of [sourceRoot, repoDir, join(offsiteRoot, 'latest'), join(offsiteRoot, 'snapshots')]) {
    mkdirSync(dir, { recursive: true });
  }
}

function listFilesShallow(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && EXPORT_RE.test(e.name))
    .map((e) => join(dir, e.name));
}

function listFilesRecursive(dir, excludeDir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (excludeDir && resolve(current) === resolve(excludeDir)) continue;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && EXPORT_RE.test(entry.name)) out.push(full);
    }
  }
  return out;
}

function listSourceFiles() {
  const files = [...listFilesShallow(sourceRoot)];
  if (includeLegacy) files.push(...listFilesRecursive(legacySourceRoot, repoDir));
  return [...new Set(files)].sort();
}

function listRepoFiles() {
  return listFilesRecursive(repoDir).sort();
}

function sameContent(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sync() {
  ensureDirs();
  for (const src of listSourceFiles()) {
    const canon = join(repoDir, basename(src));
    if (resolve(src) !== resolve(canon) && !(existsSync(canon) && sameContent(src, canon))) {
      copyFileSync(src, canon);
    }
  }

  const snapshot = join(offsiteRoot, 'snapshots', timestamp());
  mkdirSync(snapshot, { recursive: true });
  const manifestLines = [];
  let copied = 0;
  for (const file of listRepoFiles()) {
    const base = basename(file);
    copyFileSync(file, join(offsiteRoot, 'latest', base));
    copyFileSync(file, join(snapshot, base));
    const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
    manifestLines.push(`${digest}  ${base}`);
    copied++;
  }
  writeFileSync(join(snapshot, 'manifest.txt'), `${manifestLines.join('\n')}\n`);

  // prune snapshots
  const snapshotsDir = join(offsiteRoot, 'snapshots');
  const snapshots = readdirSync(snapshotsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const stale of snapshots.slice(keepSnapshots)) {
    rmSync(join(snapshotsDir, stale), { recursive: true, force: true });
  }

  console.log(`[thread-exports] synced files: ${copied}`);
  console.log(`[thread-exports] repo dir:     ${repoDir}`);
  console.log(`[thread-exports] offsite latest:${join(offsiteRoot, 'latest')}`);
  console.log(`[thread-exports] snapshot:     ${snapshot}`);
}

function status() {
  ensureDirs();
  const srcCount = listSourceFiles().length;
  const repoCount = listRepoFiles().length;
  const latestCount = listFilesShallow(join(offsiteRoot, 'latest')).length;
  const snapshots = existsSync(join(offsiteRoot, 'snapshots'))
    ? readdirSync(join(offsiteRoot, 'snapshots')).sort()
    : [];
  console.log(`[thread-exports] inbox root:  ${sourceRoot}`);
  console.log(`[thread-exports] legacy src:  ${includeLegacy ? `${legacySourceRoot} (enabled)` : 'disabled'}`);
  console.log(`[thread-exports] repo dir:    ${repoDir}`);
  console.log(`[thread-exports] offsite:     ${offsiteRoot}`);
  console.log(`[thread-exports] source files:${srcCount}`);
  console.log(`[thread-exports] repo files:  ${repoCount}`);
  console.log(`[thread-exports] latest files:${latestCount}`);
  if (snapshots.length > 0) {
    console.log(`[thread-exports] newest snapshot: ${join(offsiteRoot, 'snapshots', snapshots.at(-1))}`);
  }
}

if (action === 'sync') sync();
else if (action === 'status') status();
else {
  console.error('Usage: node scripts/thread-exports-sync.mjs <sync|status>');
  process.exit(2);
}
