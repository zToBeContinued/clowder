/**
 * Skills Route
 * GET /api/skills — Clowder AI 共享 Skills 看板数据 + staleness/conflicts (ADR-025 Phase 2)
 * POST /api/skills/sync — Re-sync managed symlinks
 * POST /api/skills/resolve-conflict — Resolve user/project skill conflict
 */

import { existsSync } from 'node:fs';
import { readdir, readFile, lstat, mkdir, symlink, readlink, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { parse as parseYaml } from 'yaml';
import type { SkillConflict } from '../config/governance/skill-conflict.js';
import { detectConflicts } from '../config/governance/skill-conflict.js';
import { resolveConflict, syncSkills, validateSkillName } from '../config/governance/skill-sync.js';
import type { SkillsStaleness } from '../config/governance/skills-state.js';
import { checkStaleness, readSkillsState, writeSkillsState } from '../config/governance/skills-state.js';
import {
  type PersonalSkillIndexEntry,
  readPersonalSkillIndexFromEnv,
  rebuildPersonalSkillIndexFromEnv,
} from '../config/skills/personal-skill-scanner.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import {
  buildProviderSkillDirCandidates,
  isSkillMountedForProvider,
  resolveMainRepoPath,
} from '../utils/skill-mount.js';
import {
  listSkillDirs,
  parseBootstrap,
  parseManifestSkillMeta,
  resolveSkillMcpStatuses,
  type SkillMcpDependency,
} from '../utils/skill-parse.js';

interface SkillMount {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
}

interface SkillEntry {
  name: string;
  category: string;
  trigger: string;
  mounts: SkillMount;
  source?: 'personal';
  visible?: boolean;
  requiresMcp?: SkillMcpDependency[];
}

interface SkillsSummary {
  total: number;
  allMounted: boolean;
  registrationConsistent: boolean;
  personalTotal?: number;
  personalVisible?: number;
  personalHidden?: number;
}

interface SkillsResponse {
  skills: SkillEntry[];
  summary: SkillsSummary;
  staleness: SkillsStaleness | null;
  conflicts: SkillConflict[];
}

interface LocalSkillFrontmatter {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  triggers?: unknown;
}

/** Resolve Clowder AI skills source from module location (stable across cwd/project). */
function resolveCatCafeSkillsSourceDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'cat-cafe-skills', 'manifest.yaml');
    if (existsSync(candidate)) return join(dir, 'cat-cafe-skills');
    dir = dirname(dir);
  }
  return resolve(process.cwd(), 'cat-cafe-skills');
}

const CAT_CAFE_SKILLS_SRC = resolveCatCafeSkillsSourceDir();
const SKILL_MANAGEMENT_DIR = resolve(homedir(), 'Documents/03 life/AI design/产品项目/skill管理');
const SKILL_DASHBOARD_PATH = join(SKILL_MANAGEMENT_DIR, 'skills-dashboard.html');

function extractSkillFrontmatter(content: string): LocalSkillFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return null;
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as LocalSkillFrontmatter) : null;
  } catch {
    return null;
  }
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function toLocalSkillEntry(frontmatter: LocalSkillFrontmatter): SkillEntry | null {
  if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) return null;
  const name = frontmatter.name.trim();
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  const triggers = toStringList(frontmatter.triggers);
  return {
    name,
    category:
      typeof frontmatter.category === 'string' && frontmatter.category.trim() ? frontmatter.category.trim() : 'gstack',
    trigger: triggers.length > 0 ? triggers.join('、') : description,
    mounts: { claude: true, codex: true, gemini: true, kimi: true },
  };
}

async function listLocalClaudeSkills(skillsDir: string): Promise<SkillEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills = await Promise.all(
    entries.map(async (entry) => {
      try {
        const content = await readFile(join(skillsDir, entry, 'SKILL.md'), 'utf-8');
        const frontmatter = extractSkillFrontmatter(content);
        return frontmatter ? toLocalSkillEntry(frontmatter) : null;
      } catch {
        return null;
      }
    }),
  );

  return skills.filter((skill): skill is SkillEntry => Boolean(skill)).sort((a, b) => a.name.localeCompare(b.name));
}

function toPersonalSkillEntry(entry: PersonalSkillIndexEntry): SkillEntry | null {
  if (typeof entry.name !== 'string' || !entry.name.trim()) return null;
  const triggers = Array.isArray(entry.triggers) ? entry.triggers.filter(Boolean) : [];
  return {
    name: entry.name.trim(),
    category: entry.category || 'personal',
    trigger: triggers.length > 0 ? triggers.join('、') : entry.description,
    mounts: { claude: false, codex: false, gemini: false, kimi: false },
    source: 'personal',
    visible: entry.visible,
  };
}

function toProjectRelativePath(projectRoot: string, targetPath: string): string {
  const rel = relative(projectRoot, targetPath);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(/[\\/]+/).join('/');
  return targetPath;
}

export const skillsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/skills/dashboard', async (_request, reply) => {
    try {
      const html = await readFile(SKILL_DASHBOARD_PATH, 'utf-8');
      reply.type('text/html; charset=utf-8');
      return html;
    } catch {
      reply.status(404);
      return {
        error: 'Skill dashboard not found',
        path: SKILL_DASHBOARD_PATH,
      };
    }
  });

  app.get('/api/skills', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const repoRoot = dirname(skillsSrc);
    const bootstrapPath = join(skillsSrc, 'BOOTSTRAP.md');
    const query = request.query as { projectPath?: string };
    let projectRoot = repoRoot;
    if (query.projectPath) {
      const validated = await validateProjectPath(query.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }
    const home = homedir();
    const providerDirCandidates = buildProviderSkillDirCandidates(projectRoot, home);
    const mainRepo = await resolveMainRepoPath();
    const mainSkillsSrc = join(mainRepo, 'cat-cafe-skills');
    const personalSkillIndex = await readPersonalSkillIndexFromEnv(projectRoot, process.env);
    const personalSkills = (personalSkillIndex.index?.skills ?? [])
      .map(toPersonalSkillEntry)
      .filter((skill): skill is SkillEntry => Boolean(skill));
    const personalSkillNames = new Set(personalSkills.map((skill) => skill.name));

    const [sourceSkills, bootstrapEntries, manifestMeta] = await Promise.all([
      listSkillDirs(skillsSrc),
      parseBootstrap(bootstrapPath),
      parseManifestSkillMeta(skillsSrc),
    ]);
    const mcpStatuses = await resolveSkillMcpStatuses(projectRoot, manifestMeta);

    // Build mount status lookup for each source skill
    const sourceSet = new Set(sourceSkills);
    const mountLookup = new Map<string, SkillEntry>();
    await Promise.all(
      sourceSkills.map(async (name) => {
        const [claude, codex, gemini, kimi] = await Promise.all([
          isSkillMountedForProvider(providerDirCandidates.claude, skillsSrc, name, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.codex, skillsSrc, name, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.gemini, skillsSrc, name, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.kimi, skillsSrc, name, mainSkillsSrc),
        ]);
        const entry = bootstrapEntries.get(name);
        const meta = manifestMeta.get(name);
        const trigger = meta?.triggers?.length ? meta.triggers.join('、') : (entry?.trigger ?? '');
        mountLookup.set(name, {
          name,
          category: entry?.category ?? '未分类',
          trigger,
          mounts: { claude, codex, gemini, kimi },
          ...(meta?.requiresMcp?.length
            ? {
                requiresMcp: meta.requiresMcp.map((id) => mcpStatuses.get(id) ?? { id, status: 'missing' }),
              }
            : {}),
        });
      }),
    );

    // Order: BOOTSTRAP insertion order first, then local user skills, then unregistered built-ins.
    // Local skills are real user-facing skills, but should not affect cat-cafe registration checks.
    const registeredOrdered: string[] = [];
    const unregisteredOrdered: string[] = [];
    const bootstrapOrdered = new Set<string>();
    for (const bsName of bootstrapEntries.keys()) {
      if (sourceSet.has(bsName)) {
        registeredOrdered.push(bsName);
        bootstrapOrdered.add(bsName);
      }
    }
    for (const name of sourceSkills) {
      if (!bootstrapOrdered.has(name)) unregisteredOrdered.push(name);
    }
    const registeredSkills = registeredOrdered.map((n) => mountLookup.get(n)!).filter(Boolean);
    const unregisteredSkills = unregisteredOrdered.map((n) => mountLookup.get(n)!).filter(Boolean);
    const builtinSkillNames = new Set(sourceSkills);
    const localClaudeSkills = (await listLocalClaudeSkills(join(home, '.claude', 'skills'))).filter(
      (skill) => !builtinSkillNames.has(skill.name) && !personalSkillNames.has(skill.name),
    );
    const skills = [...registeredSkills, ...localClaudeSkills, ...personalSkills, ...unregisteredSkills];

    // Registration consistency check
    const sourceNames = new Set(sourceSkills);
    const bootstrapNames = new Set(bootstrapEntries.keys());
    const unregistered = sourceSkills.filter((n) => !bootstrapNames.has(n));
    const phantom = [...bootstrapNames].filter((n) => !sourceNames.has(n));
    const registrationConsistent = unregistered.length === 0 && phantom.length === 0;
    const mountCheckedSkills = skills.filter((skill) => skill.source !== 'personal');
    const allMounted = mountCheckedSkills.every(
      (s) => s.mounts.claude && s.mounts.codex && s.mounts.gemini && s.mounts.kimi,
    );

    // ADR-025 Phase 2: staleness + conflicts
    const state = await readSkillsState(projectRoot);
    const managedNames = state?.managedSkillNames ?? sourceSkills;
    const [staleness, conflicts] = await Promise.all([
      checkStaleness(projectRoot, skillsSrc),
      detectConflicts(projectRoot, home, managedNames),
    ]);

    const response: SkillsResponse = {
      skills,
      summary: {
        total: skills.length,
        allMounted,
        registrationConsistent,
        personalTotal: personalSkills.length,
        personalVisible: personalSkills.filter((skill) => skill.visible).length,
        personalHidden: personalSkills.filter((skill) => !skill.visible).length,
      },
      staleness,
      conflicts,
    };

    return response;
  });

  app.post('/api/skills/personal/rebuild', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const body = (request.body ?? {}) as { projectPath?: string };
    const repoRoot = dirname(CAT_CAFE_SKILLS_SRC);
    let projectRoot = repoRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    const result = await rebuildPersonalSkillIndexFromEnv(projectRoot, process.env);
    return {
      enabled: result.enabled,
      total: result.total,
      visible: result.visible,
      duplicates: result.duplicates,
      ignored: result.ignoredHiddenDirs,
      indexPath: toProjectRelativePath(projectRoot, result.indexPath),
    };
  });

  app.post('/api/skills/sync', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const body = (request.body ?? {}) as { projectPath?: string };
    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const repoRoot = dirname(skillsSrc);
    let projectRoot = repoRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    const result = await syncSkills(projectRoot, skillsSrc);
    return result;
  });

  app.post('/api/skills/resolve-conflict', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const body = (request.body ?? {}) as {
      skillName?: string;
      choice?: 'official' | 'mine';
      projectPath?: string;
    };
    if (!body.skillName || !body.choice) {
      reply.status(400);
      return { error: 'skillName and choice are required' };
    }
    if (body.choice !== 'official' && body.choice !== 'mine') {
      reply.status(400);
      return { error: "choice must be 'official' or 'mine'" };
    }
    try {
      validateSkillName(body.skillName);
    } catch {
      reply.status(400);
      return { error: 'Invalid skill name: must be lowercase letters, digits, and hyphens' };
    }
    const repoRoot = dirname(CAT_CAFE_SKILLS_SRC);
    let projectRoot = repoRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    await resolveConflict(projectRoot, homedir(), body.skillName, body.choice);
    return { ok: true, skillName: body.skillName, choice: body.choice };
  });

  // ── Mount: add individual skills on-demand (hot-reload, no restart needed) ──
  app.post('/api/skills/mount', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const body = (request.body ?? {}) as {
      skillNames?: string[];
      projectPath?: string;
      providers?: string[];
    };

    if (!Array.isArray(body.skillNames) || body.skillNames.length === 0) {
      reply.status(400);
      return { error: 'skillNames is required and must be a non-empty array' };
    }

    // Validate all skill names
    for (const name of body.skillNames) {
      try {
        validateSkillName(name);
      } catch {
        reply.status(400);
        return { error: `Invalid skill name: "${name}". Must be lowercase letters, digits, and hyphens.` };
      }
    }

    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const repoRoot = dirname(skillsSrc);
    let projectRoot = repoRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    // Determine which providers to mount for (default: claude only)
    const allProviders = ['claude', 'codex', 'gemini', 'kimi'] as const;
    const requestedProviders = body.providers?.length
      ? body.providers.filter((p): p is typeof allProviders[number] => (allProviders as readonly string[]).includes(p))
      : (['claude'] as const);

    const mounted: string[] = [];
    const skipped: string[] = [];
    const notFound: string[] = [];

    const IS_WIN32 = process.platform === 'win32';

    for (const skillName of body.skillNames) {
      const sourceSkillDir = join(skillsSrc, skillName);
      // Check source skill exists
      try {
        const s = await lstat(join(sourceSkillDir, 'SKILL.md'));
        if (!s.isFile()) { notFound.push(skillName); continue; }
      } catch {
        notFound.push(skillName);
        continue;
      }

      let anyMounted = false;
      for (const provider of requestedProviders) {
        const providerSkillsDir = join(projectRoot, `.${provider}`, 'skills');
        await mkdir(providerSkillsDir, { recursive: true });
        const linkPath = join(providerSkillsDir, skillName);

        // Check if already correct
        try {
          const stat = await lstat(linkPath);
          if (stat.isSymbolicLink()) {
            const target = await readlink(linkPath);
            const resolvedTarget = resolve(dirname(linkPath), target);
            if (resolvedTarget === sourceSkillDir || target === sourceSkillDir) {
              continue; // Already correctly mounted
            }
            await rm(linkPath); // Wrong target, remove first
          }
        } catch {
          // Doesn't exist — good, we'll create
        }

        const linkTarget = IS_WIN32 ? sourceSkillDir : relative(dirname(linkPath), sourceSkillDir);
        await symlink(linkTarget, linkPath, IS_WIN32 ? 'junction' : undefined);
        anyMounted = true;
      }
      if (anyMounted) mounted.push(skillName); else skipped.push(skillName);
    }

    // Update skills-state.json to reflect new mounted skills
    const state = await readSkillsState(projectRoot);
    if (state) {
      const managedSet = new Set(state.managedSkillNames);
      for (const name of mounted) managedSet.add(name);
      await writeSkillsState(projectRoot, {
        ...state,
        managedSkillNames: [...managedSet].sort(),
        lastSyncedAt: new Date().toISOString(),
      });
    }

    return { ok: true, mounted, skipped, notFound, providers: requestedProviders };
  });

  // ── Unmount: remove individual skills ──
  app.delete('/api/skills/unmount', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const body = (request.body ?? {}) as {
      skillNames?: string[];
      projectPath?: string;
      providers?: string[];
    };

    if (!Array.isArray(body.skillNames) || body.skillNames.length === 0) {
      reply.status(400);
      return { error: 'skillNames is required and must be a non-empty array' };
    }

    for (const name of body.skillNames) {
      try {
        validateSkillName(name);
      } catch {
        reply.status(400);
        return { error: `Invalid skill name: "${name}". Must be lowercase letters, digits, and hyphens.` };
      }
    }

    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const repoRoot = dirname(skillsSrc);
    let projectRoot = repoRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    const allProviders = ['claude', 'codex', 'gemini', 'kimi'] as const;
    const requestedProviders = body.providers?.length
      ? body.providers.filter((p): p is typeof allProviders[number] => (allProviders as readonly string[]).includes(p))
      : (['claude', 'codex', 'gemini', 'kimi'] as const);

    const unmounted: string[] = [];

    for (const skillName of body.skillNames) {
      let anyRemoved = false;
      for (const provider of requestedProviders) {
        const linkPath = join(projectRoot, `.${provider}`, 'skills', skillName);
        try {
          const stat = await lstat(linkPath);
          if (stat.isSymbolicLink()) {
            await rm(linkPath);
            anyRemoved = true;
          }
        } catch {
          // Doesn't exist — fine
        }
      }
      if (anyRemoved) unmounted.push(skillName);
    }

    // Update skills-state.json to remove unmounted skills
    const state = await readSkillsState(projectRoot);
    if (state) {
      const unmountedSet = new Set(unmounted);
      await writeSkillsState(projectRoot, {
        ...state,
        managedSkillNames: state.managedSkillNames.filter((n) => !unmountedSet.has(n)),
        lastSyncedAt: new Date().toISOString(),
      });
    }

    return { ok: true, unmounted, providers: requestedProviders };
  });
};
