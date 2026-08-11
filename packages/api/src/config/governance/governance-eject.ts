/**
 * Governance Eject Service — the inverse of GovernanceBootstrapService.
 *
 * Removes every artifact Clowder may have written into an external project:
 *   1. Managed blocks in CLAUDE.md / AGENTS.md / GEMINI.md / KIMI.md
 *      (file is deleted when nothing but the block remains).
 *   2. Skill symlinks under .claude/skills, .codex/skills, .gemini/skills,
 *      .kimi/skills — both per-skill symlinks (ADR-025) and legacy
 *      directory-level symlinks. Only links that point into the Cat Cafe
 *      repo or a `cat-cafe-skills` directory are touched; user-owned real
 *      files/dirs are left alone. Emptied dirs are pruned.
 *   3. Hooks symlinks (.{provider}/hooks) pointing into the Cat Cafe repo.
 *   4. `.cat-cafe/` governance state (bootstrap report, skills-state.json);
 *      the directory itself is pruned only when empty (memory/handoff
 *      scaffolds are preserved unless `purgeTemplates` matches them).
 *   5. Optionally (`purgeTemplates`), methodology skeleton files that are
 *      byte-identical to the shipped templates (modulo creation date) —
 *      i.e. never actually used by the project.
 *   6. The project's entry in the Cat Cafe governance registry.
 *
 * A standalone mirror for use without the API server lives at
 * `scripts/governance-eject.mjs` (keep behaviors in sync).
 */

import { lstat, readdir, readFile, readlink, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathsEqual } from '../../utils/project-path.js';
import { PROVIDER_FILES, PROVIDER_HOOKS_DIRS, PROVIDER_SKILLS_DIRS } from './governance-bootstrap.js';
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from './governance-pack.js';
import { GovernanceRegistry } from './governance-registry.js';
import { getRawMethodologyTemplates } from './methodology-templates.js';

export interface EjectAction {
  file: string;
  action: 'removed' | 'stripped' | 'skipped';
  reason: string;
}

export interface EjectReport {
  projectPath: string;
  timestamp: number;
  dryRun: boolean;
  actions: EjectAction[];
}

export interface EjectOptions {
  dryRun?: boolean;
  /** Also delete methodology skeleton files that are still untouched templates. */
  purgeTemplates?: boolean;
}

function joinAroundBlock(before: string, after: string): string {
  if (!before && !after) return '';
  if (!before) return after;
  if (!after) return `${before}\n`;
  return `${before}\n\n${after}`;
}

/**
 * Strip ALL managed blocks from a file's content.
 * Returns null when no block is present; '' when nothing but blocks remained.
 */
export function stripManagedBlocks(content: string): string | null {
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

/** Template content (with {{DATE}}) → matcher that accepts any concrete date. */
function templateMatcher(templateContent: string): (fileContent: string) => boolean {
  const escaped = templateContent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = `^${escaped.replace(/\\\{\\\{DATE\\\}\\\}/g, '\\d{4}-\\d{2}-\\d{2}')}$`;
  const re = new RegExp(pattern);
  return (fileContent: string) => re.test(fileContent.replace(/\r\n/g, '\n'));
}

export class GovernanceEjectService {
  constructor(private readonly catCafeRoot: string) {}

  async eject(targetProject: string, opts: EjectOptions = {}): Promise<EjectReport> {
    const dryRun = opts.dryRun ?? false;
    const actions: EjectAction[] = [];

    await this.ejectInstructionFiles(targetProject, dryRun, actions);
    await this.ejectSymlinks(targetProject, dryRun, actions);
    await this.ejectStateFiles(targetProject, dryRun, actions);

    if (opts.purgeTemplates) {
      await this.ejectUntouchedTemplates(targetProject, dryRun, actions);
    }

    // Prune .cat-cafe subdirs + root when emptied
    for (const dir of ['.cat-cafe/memory', '.cat-cafe/handoff', '.cat-cafe/projects', '.cat-cafe']) {
      await this.pruneEmptyDirs(targetProject, dir, dryRun);
    }

    await this.ejectRegistryEntry(targetProject, dryRun, actions);

    return { projectPath: targetProject, timestamp: Date.now(), dryRun, actions };
  }

  /** 1. Managed blocks in provider instruction files. */
  private async ejectInstructionFiles(targetProject: string, dryRun: boolean, actions: EjectAction[]): Promise<void> {
    for (const filename of Object.values(PROVIDER_FILES)) {
      actions.push(await this.stripBlockFromFile(targetProject, filename, dryRun));
    }
  }

  /** 2+3. Skill symlinks, hooks symlinks, legacy root-level cat-cafe-skills symlink. */
  private async ejectSymlinks(targetProject: string, dryRun: boolean, actions: EjectAction[]): Promise<void> {
    for (const skillsDir of Object.values(PROVIDER_SKILLS_DIRS)) {
      actions.push(...(await this.removeSkillLinks(targetProject, skillsDir, dryRun)));
    }

    for (const linkPath of [...Object.values(PROVIDER_HOOKS_DIRS), 'cat-cafe-skills']) {
      const action = await this.removeLinkIfCatCafe(targetProject, linkPath, dryRun);
      if (action) actions.push(action);
    }

    // Prune emptied provider dirs (.claude, .codex, …)
    for (const skillsDir of Object.values(PROVIDER_SKILLS_DIRS)) {
      await this.pruneEmptyDirs(targetProject, skillsDir, dryRun);
    }
  }

  /** 4. Governance state under .cat-cafe/. */
  private async ejectStateFiles(targetProject: string, dryRun: boolean, actions: EjectAction[]): Promise<void> {
    for (const stateFile of ['.cat-cafe/governance-bootstrap-report.json', '.cat-cafe/skills-state.json']) {
      const action = await this.removeFileIfExists(targetProject, stateFile, dryRun);
      if (action) actions.push(action);
    }
  }

  /** 5. Untouched methodology skeleton files (opt-in via purgeTemplates). */
  private async ejectUntouchedTemplates(targetProject: string, dryRun: boolean, actions: EjectAction[]): Promise<void> {
    for (const template of getRawMethodologyTemplates()) {
      const action = await this.removeUntouchedTemplate(targetProject, template.relativePath, template.content, dryRun);
      if (action) actions.push(action);
    }
    for (const dir of ['docs/features', 'docs/decisions', 'docs/discussions', 'docs']) {
      await this.pruneEmptyDirs(targetProject, dir, dryRun);
    }
  }

  /** 6. Registry entry in the Cat Cafe root. */
  private async ejectRegistryEntry(targetProject: string, dryRun: boolean, actions: EjectAction[]): Promise<void> {
    if (dryRun) return;
    const removed = await new GovernanceRegistry(this.catCafeRoot).remove(targetProject);
    actions.push({
      file: '.cat-cafe/governance-registry.json (Cat Cafe root)',
      action: removed ? 'removed' : 'skipped',
      reason: removed ? 'registry entry removed' : 'no registry entry found',
    });
  }

  private async stripBlockFromFile(targetProject: string, filename: string, dryRun: boolean): Promise<EjectAction> {
    const filePath = resolve(targetProject, filename);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return { file: filename, action: 'skipped', reason: 'file does not exist' };
    }

    const stripped = stripManagedBlocks(content);
    if (stripped === null) {
      return { file: filename, action: 'skipped', reason: 'no managed block found' };
    }

    if (stripped.trim() === '') {
      if (!dryRun) await unlink(filePath);
      return { file: filename, action: 'removed', reason: 'file contained only the managed block' };
    }

    if (!dryRun) await writeFile(filePath, stripped, 'utf-8');
    return { file: filename, action: 'stripped', reason: 'managed block removed, user content preserved' };
  }

  /** True when a symlink target belongs to Cat Cafe (repo root or a cat-cafe-skills dir). */
  private isCatCafeTarget(linkDir: string, linkTarget: string): boolean {
    const resolved = isAbsolute(linkTarget) ? resolve(linkTarget) : resolve(linkDir, linkTarget);
    const rel = relative(resolve(this.catCafeRoot), resolved);
    const underRoot = rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
    if (underRoot) return true;
    if (basename(dirname(resolved)) === 'cat-cafe-skills') return true;
    if (basename(resolved) === 'cat-cafe-skills') return true;
    return false;
  }

  private async removeSkillLinks(targetProject: string, skillsDir: string, dryRun: boolean): Promise<EjectAction[]> {
    const dirPath = resolve(targetProject, skillsDir);
    const actions: EjectAction[] = [];

    let dirStat: Awaited<ReturnType<typeof lstat>>;
    try {
      dirStat = await lstat(dirPath);
    } catch {
      return actions; // dir doesn't exist — nothing to do
    }

    // Legacy: the skills dir itself is a symlink
    if (dirStat.isSymbolicLink()) {
      const target = await readlink(dirPath).catch(() => '');
      if (this.isCatCafeTarget(dirname(dirPath), target)) {
        if (!dryRun) await unlink(dirPath);
        actions.push({ file: skillsDir, action: 'removed', reason: 'legacy directory-level skills symlink' });
      } else {
        actions.push({ file: skillsDir, action: 'skipped', reason: 'symlink does not point to Cat Cafe' });
      }
      return actions;
    }

    if (!dirStat.isDirectory()) return actions;

    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const action = await this.removeOneSkillLink(dirPath, skillsDir, entry.name, dryRun);
      if (action) actions.push(action);
    }

    return actions;
  }

  /** Remove a single per-skill symlink when it points to Cat Cafe; never touch real files/dirs. */
  private async removeOneSkillLink(
    dirPath: string,
    skillsDir: string,
    entryName: string,
    dryRun: boolean,
  ): Promise<EjectAction | null> {
    const linkPath = join(dirPath, entryName);
    let st: Awaited<ReturnType<typeof lstat>>;
    try {
      st = await lstat(linkPath);
    } catch {
      return null;
    }
    if (!st.isSymbolicLink()) return null; // user's real file/dir — never touch

    const target = await readlink(linkPath).catch(() => '');
    if (!this.isCatCafeTarget(dirPath, target)) {
      return { file: `${skillsDir}/${entryName}`, action: 'skipped', reason: 'symlink does not point to Cat Cafe' };
    }
    if (!dryRun) await unlink(linkPath);
    return { file: `${skillsDir}/${entryName}`, action: 'removed', reason: 'cat-cafe skill symlink' };
  }

  private async removeLinkIfCatCafe(
    targetProject: string,
    relPath: string,
    dryRun: boolean,
  ): Promise<EjectAction | null> {
    const linkPath = resolve(targetProject, relPath);
    try {
      const st = await lstat(linkPath);
      if (!st.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    const target = await readlink(linkPath).catch(() => '');
    if (!this.isCatCafeTarget(dirname(linkPath), target)) {
      return { file: relPath, action: 'skipped', reason: 'symlink does not point to Cat Cafe' };
    }
    if (!dryRun) await unlink(linkPath);
    return { file: relPath, action: 'removed', reason: 'cat-cafe hooks symlink' };
  }

  private async removeFileIfExists(
    targetProject: string,
    relPath: string,
    dryRun: boolean,
  ): Promise<EjectAction | null> {
    const filePath = resolve(targetProject, relPath);
    try {
      const st = await lstat(filePath);
      if (!st.isFile()) return null;
    } catch {
      return null;
    }
    if (!dryRun) await rm(filePath, { force: true });
    return { file: relPath, action: 'removed', reason: 'governance state file' };
  }

  private async removeUntouchedTemplate(
    targetProject: string,
    relPath: string,
    templateContent: string,
    dryRun: boolean,
  ): Promise<EjectAction | null> {
    const filePath = resolve(targetProject, relPath);
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const matches = templateContent === '' ? content === '' : templateMatcher(templateContent)(content);
    if (!matches) {
      return { file: relPath, action: 'skipped', reason: 'modified since bootstrap — kept' };
    }
    if (!dryRun) await unlink(filePath);
    return { file: relPath, action: 'removed', reason: 'untouched methodology template' };
  }

  /** Remove `relPath` and then each parent (up to project root) while empty. */
  private async pruneEmptyDirs(targetProject: string, relPath: string, dryRun: boolean): Promise<void> {
    if (dryRun) return;
    const root = resolve(targetProject);
    let current = resolve(targetProject, relPath);
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
}
