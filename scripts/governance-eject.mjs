#!/usr/bin/env node
/**
 * Standalone governance eject — remove all Clowder/Cat Cafe footprint from a
 * target project WITHOUT needing the API server to be running.
 *
 * Mirrors `packages/api/src/config/governance/governance-eject.ts`
 * (keep behaviors in sync). Removes:
 *   - CAT-CAFE managed blocks from CLAUDE.md / AGENTS.md / GEMINI.md / KIMI.md
 *     (deletes the file when nothing but the block remains)
 *   - skill symlinks under .claude/.codex/.gemini/.kimi skills dirs that point
 *     into the Cat Cafe repo or any `cat-cafe-skills` directory (user-owned
 *     real files/dirs are never touched); legacy directory-level symlinks too
 *   - hooks symlinks and a legacy root-level `cat-cafe-skills` symlink
 *   - .cat-cafe/governance-bootstrap-report.json and .cat-cafe/skills-state.json
 *   - the project's entry in this repo's .cat-cafe/governance-registry.json
 *   - emptied directories left behind
 *
 * Untouched methodology templates (BACKLOG.md, docs/SOP.md, …) are NOT deleted
 * here — use the API route POST /api/governance/eject with purgeTemplates for
 * exact template matching, or delete them manually.
 *
 * Usage:
 *   node scripts/governance-eject.mjs <projectPath> [--dry-run] [--cat-cafe-root <path>]
 */

import { lstat, readdir, readFile, readlink, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANAGED_BLOCK_START = '<!-- CAT-CAFE-GOVERNANCE-START -->';
const MANAGED_BLOCK_END = '<!-- CAT-CAFE-GOVERNANCE-END -->';
const PROVIDER_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'KIMI.md'];
const PROVIDER_SKILLS_DIRS = ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills'];
const PROVIDER_HOOKS_DIRS = ['.claude/hooks', '.codex/hooks', '.gemini/hooks', '.kimi/hooks'];
const STATE_FILES = ['.cat-cafe/governance-bootstrap-report.json', '.cat-cafe/skills-state.json'];

function parseArgs(argv) {
  const args = { projectPath: undefined, dryRun: false, catCafeRoot: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--cat-cafe-root') args.catCafeRoot = argv[++i];
    else if (!a.startsWith('-') && !args.projectPath) args.projectPath = a;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function joinAroundBlock(before, after) {
  if (!before && !after) return '';
  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

function stripManagedBlocks(content) {
  let current = content;
  let found = false;
  for (;;) {
    const start = current.indexOf(MANAGED_BLOCK_START);
    if (start < 0) break;
    const end = current.indexOf(MANAGED_BLOCK_END, start);
    if (end < 0) break;
    found = true;
    const before = current.slice(0, start).replace(/\s+$/, '');
    const after = current.slice(end + MANAGED_BLOCK_END.length).replace(/^\s+/, '');
    current = joinAroundBlock(before, after);
  }
  if (!found) return null;
  if (current && !current.endsWith('\n')) current += '\n';
  return current;
}

function pathsEqual(a, b) {
  const na = resolve(a).replace(/[\\/]+$/, '');
  const nb = resolve(b).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isCatCafeTarget(catCafeRoot, linkDir, linkTarget) {
  const resolved = isAbsolute(linkTarget) ? resolve(linkTarget) : resolve(linkDir, linkTarget);
  const rel = relative(resolve(catCafeRoot), resolved);
  const underRoot = rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
  if (underRoot) return true;
  if (basename(dirname(resolved)) === 'cat-cafe-skills') return true;
  if (basename(resolved) === 'cat-cafe-skills') return true;
  return false;
}

let removedCount = 0;
function report(file, action, reason) {
  if (action !== 'skipped') removedCount++;
  console.log(`${action.padEnd(9)} ${file}  (${reason})`);
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

async function pruneEmptyDirs(projectRoot, relPath, dryRun) {
  if (dryRun) return;
  const root = resolve(projectRoot);
  let current = resolve(projectRoot, relPath);
  while (!pathsEqual(current, root)) {
    const rel = relative(root, current);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return;
    try {
      const st = await lstat(current);
      if (!st.isDirectory() || st.isSymbolicLink()) return;
      const entries = await readdir(current);
      if (entries.length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

async function ejectManagedBlocks(projectRoot, dryRun) {
  for (const filename of PROVIDER_FILES) {
    const filePath = join(projectRoot, filename);
    let content;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    const stripped = stripManagedBlocks(content);
    if (stripped === null) continue;
    if (stripped.trim() === '') {
      if (!dryRun) await unlink(filePath);
      report(filename, 'removed', 'file contained only the managed block');
    } else {
      if (!dryRun) await writeFile(filePath, stripped, 'utf-8');
      report(filename, 'stripped', 'managed block removed, user content preserved');
    }
  }
}

async function ejectSkillLinksInDir(projectRoot, catCafeRoot, skillsDir, dryRun) {
  const dirPath = join(projectRoot, skillsDir);
  const dirStat = await lstatOrNull(dirPath);
  if (!dirStat) return;

  if (dirStat.isSymbolicLink()) {
    const target = await readlink(dirPath).catch(() => '');
    if (isCatCafeTarget(catCafeRoot, dirname(dirPath), target)) {
      if (!dryRun) await unlink(dirPath);
      report(skillsDir, 'removed', 'legacy directory-level skills symlink');
    }
    return;
  }
  if (!dirStat.isDirectory()) return;

  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const linkPath = join(dirPath, entry.name);
    const st = await lstatOrNull(linkPath);
    if (!st?.isSymbolicLink()) continue;
    const target = await readlink(linkPath).catch(() => '');
    if (!isCatCafeTarget(catCafeRoot, dirPath, target)) {
      report(`${skillsDir}/${entry.name}`, 'skipped', 'symlink does not point to Cat Cafe');
      continue;
    }
    if (!dryRun) await unlink(linkPath);
    report(`${skillsDir}/${entry.name}`, 'removed', 'cat-cafe skill symlink');
  }
}

async function ejectStandaloneLinks(projectRoot, catCafeRoot, dryRun) {
  for (const relPath of [...PROVIDER_HOOKS_DIRS, 'cat-cafe-skills']) {
    const linkPath = join(projectRoot, relPath);
    const st = await lstatOrNull(linkPath);
    if (!st?.isSymbolicLink()) continue;
    const target = await readlink(linkPath).catch(() => '');
    if (!isCatCafeTarget(catCafeRoot, dirname(linkPath), target)) continue;
    if (!dryRun) await unlink(linkPath);
    report(relPath, 'removed', 'cat-cafe symlink');
  }
}

async function ejectStateFiles(projectRoot, dryRun) {
  for (const stateFile of STATE_FILES) {
    const filePath = join(projectRoot, stateFile);
    const st = await lstatOrNull(filePath);
    if (!st?.isFile()) continue;
    if (!dryRun) await rm(filePath, { force: true });
    report(stateFile, 'removed', 'governance state file');
  }
}

async function ejectRegistryEntry(projectRoot, catCafeRoot, dryRun) {
  const registryPath = join(catCafeRoot, '.cat-cafe', 'governance-registry.json');
  try {
    const raw = await readFile(registryPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.entries)) return;
    const before = data.entries.length;
    data.entries = data.entries.filter((e) => !pathsEqual(e.projectPath ?? '', projectRoot));
    if (data.entries.length === before) return;
    if (!dryRun) await writeFile(registryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    report('.cat-cafe/governance-registry.json (Cat Cafe root)', 'removed', 'registry entry removed');
  } catch {
    // No registry — fine
  }
}

async function resolveAndValidateArgs() {
  const { projectPath, dryRun, catCafeRoot: rootArg } = parseArgs(process.argv.slice(2));
  if (!projectPath) {
    console.error('Usage: node scripts/governance-eject.mjs <projectPath> [--dry-run] [--cat-cafe-root <path>]');
    process.exit(2);
  }
  const projectRoot = resolve(projectPath);
  const catCafeRoot = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

  if (pathsEqual(projectRoot, catCafeRoot)) {
    console.error('Refusing to eject governance from the Cat Cafe repo itself.');
    process.exit(2);
  }
  const st = await lstatOrNull(projectRoot);
  if (!st?.isDirectory()) {
    console.error(`Project path does not exist or is not a directory: ${projectRoot}`);
    process.exit(2);
  }
  return { projectRoot, catCafeRoot, dryRun };
}

async function main() {
  const { projectRoot, catCafeRoot, dryRun } = await resolveAndValidateArgs();
  console.log(`Ejecting Clowder governance from: ${projectRoot}${dryRun ? '  [DRY RUN]' : ''}\n`);

  await ejectManagedBlocks(projectRoot, dryRun);
  for (const skillsDir of PROVIDER_SKILLS_DIRS) {
    await ejectSkillLinksInDir(projectRoot, catCafeRoot, skillsDir, dryRun);
  }
  await ejectStandaloneLinks(projectRoot, catCafeRoot, dryRun);
  for (const dir of [...PROVIDER_SKILLS_DIRS, ...PROVIDER_HOOKS_DIRS]) {
    await pruneEmptyDirs(projectRoot, dir, dryRun);
  }
  await ejectStateFiles(projectRoot, dryRun);
  await pruneEmptyDirs(projectRoot, '.cat-cafe', dryRun);
  await ejectRegistryEntry(projectRoot, catCafeRoot, dryRun);

  console.log(`\nDone. ${removedCount} item(s) ${dryRun ? 'would be ' : ''}cleaned.`);
  console.log(
    'Note: methodology templates (BACKLOG.md, docs/SOP.md, …) are left in place.\n' +
      'If the project never used them, remove manually or call POST /api/governance/eject with purgeTemplates:true.',
  );
}

await main();
