import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_PERSONAL_SKILL_INDEX_PATH,
  DEFAULT_PERSONAL_SKILL_ROOTS,
  DEFAULT_PERSONAL_SKILL_VISIBLE_NAMES,
  expandTildePath,
  isPersonalSkillsEnabled,
  resolvePersonalSkillIndexPath,
} from '../../../../config/skills/personal-skill-scanner.js';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';

const DEFAULT_SKILL_MANAGEMENT_DIR = resolve(homedir(), 'Documents/03 life/AI design/产品项目/skill管理');
const DEFAULT_SKILL_MANIFEST_PATH = `${DEFAULT_SKILL_MANAGEMENT_DIR}/skills-manifest.json`;
const MAX_TRIGGERS_PER_SKILL = 5;
const MAX_MATCHED_SKILLS = 2;
const CJK_TEXT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ROUTER_TRIGGER_ALIASES: Record<string, string[]> = {
  // External skills often carry natural-language "when to use" text but no
  // frontmatter triggers. Keep these aliases explicit and cheap; semantic
  // embedding fallback belongs to a later phase only if this layer is not enough.
  'content-research-writer': [
    '写文档',
    '写个文档',
    '写报告',
    '写个报告',
    '写 blog',
    '写 newsletter',
    '写内容',
    '技术文档',
    '内容写作',
  ],
  'doc-coauthoring': ['写文档', '写报告', '写 proposal', '写 spec', 'PRD 文档', '需求文档'],
  'khazix-writer': ['写文章', '写稿子', '续写', '扩写', '公众号文章', '长文', '写篇文章'],
  summarize: ['总结', '总结文章', '帮我总结', '提炼', '摘要', '总结这篇文章'],
  'dbs-content': ['写文案', '写内容', '内容怎么做', '文案', '内容诊断'],
  brainstorm: ['头脑风暴', '发散思路', '想创意', '想点子', '发散一下'],
};

interface SkillManifest {
  skills?: SkillManifestEntry[];
}

interface SkillManifestEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
  source?: unknown;
  risk_level?: unknown;
  source_path?: unknown;
  clowder_available?: unknown;
}

interface SkillFrontmatter {
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
}

interface RepoSkillManifest {
  skills?: Record<string, RepoSkillManifestEntry>;
}

interface RepoSkillManifestEntry {
  description?: unknown;
  triggers?: unknown;
}

interface SkillRouterCatalogEntry {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  riskLevel: string;
  sourcePath: string;
  relativePath: string;
  content: string;
  source: 'cat-cafe' | 'personal';
  menuVisible: boolean;
}

interface PersonalSkillIndex {
  version?: unknown;
  skills?: PersonalSkillIndexEntry[];
}

interface PersonalSkillIndexEntry {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  triggers?: unknown;
  category?: unknown;
  sourcePath?: unknown;
  relativePath?: unknown;
  visible?: unknown;
}

export interface SkillRouterContext {
  promptBlock: string;
  matchedSkillNames: string[];
  menuSkillCount: number;
}

let catalogCache: {
  cacheKey: string;
  entries: SkillRouterCatalogEntry[];
} | null = null;

function resolveSkillManifestPath(): string {
  return process.env.CAT_CAFE_SKILL_MANIFEST_PATH || DEFAULT_SKILL_MANIFEST_PATH;
}

function flattenText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeForLiteralMatch(value: string): string {
  return flattenText(value).toLocaleLowerCase();
}

function shouldUseCjkLooseMatch(message: string, trigger: string): boolean {
  return CJK_TEXT_RE.test(message) || CJK_TEXT_RE.test(trigger);
}

function normalizeForCjkLooseMatch(value: string): string {
  return normalizeForLiteralMatch(value).replace(/\s+/g, '');
}

function includesTrigger(message: string, trigger: string): boolean {
  const normalizedMessage = normalizeForLiteralMatch(message);
  const normalizedTrigger = normalizeForLiteralMatch(trigger);
  if (normalizedMessage.includes(normalizedTrigger)) return true;
  if (!shouldUseCjkLooseMatch(normalizedMessage, normalizedTrigger)) return false;
  return normalizeForCjkLooseMatch(normalizedMessage).includes(normalizeForCjkLooseMatch(normalizedTrigger));
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

function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  try {
    const parsed = parseYaml(match[1]) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SkillFrontmatter) : {};
  } catch {
    return {};
  }
}

function safeReadJson(path: string): SkillManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SkillManifest) : null;
  } catch {
    return null;
  }
}

function safeReadPersonalIndex(path: string): PersonalSkillIndex | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const index = parsed as PersonalSkillIndex;
    if (index.version !== 1 || !Array.isArray(index.skills)) return null;
    return index;
  } catch {
    return null;
  }
}

function safeReadRepoManifest(path: string): RepoSkillManifest | null {
  try {
    const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as RepoSkillManifest) : null;
  } catch {
    return null;
  }
}

function resolveRepoSkillRoot(): string {
  return resolve(findMonorepoRoot(), 'cat-cafe-skills');
}

// Windows 暗礁:path.resolve 产出反斜杠路径,拼死 '/' 做前后缀判断会全军覆没
// (isSafeCatCafeSkillPath 恒 false → 目录为空 → SkillRouter 在 Windows 整体失效,
// 2026-08-13 skill-router-context 8 个失败的根因)。统一用 path.sep。
function isSafeCatCafeSkillPath(path: string): boolean {
  const resolvedPath = resolve(path);
  const skillRoot = resolveRepoSkillRoot();
  return resolvedPath.startsWith(`${skillRoot}${sep}`) && resolvedPath.endsWith(`${sep}SKILL.md`);
}

function toRelativeRepoPath(path: string): string {
  const root = findMonorepoRoot();
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(`${root}${sep}`)) return resolvedPath;
  // 展示用统一正斜杠,跨平台稳定(Windows 解析正斜杠路径也没问题)。
  return relative(root, resolvedPath).split(sep).join('/');
}

function readSkillContent(sourcePath: string): string | null {
  if (!isSafeCatCafeSkillPath(sourcePath) || !existsSync(sourcePath)) return null;
  try {
    return readFileSync(sourcePath, 'utf8');
  } catch {
    return null;
  }
}

function frontmatterName(frontmatter: SkillFrontmatter, fallback: string): string {
  return typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim() : fallback.trim();
}

function frontmatterDescription(frontmatter: SkillFrontmatter): string {
  return typeof frontmatter.description === 'string' ? flattenText(frontmatter.description) : '';
}

function skillTriggers(frontmatter: SkillFrontmatter, manifestTriggers: unknown, name: string): string[] {
  return Array.from(
    new Set(
      [
        ...toStringList(frontmatter.triggers),
        ...toStringList(manifestTriggers),
        ...(ROUTER_TRIGGER_ALIASES[name] ?? []),
        name,
      ].map((value) => value.trim()),
    ),
  ).filter(Boolean);
}

function makeCatalogEntry(params: {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  riskLevel: string;
  sourcePath: string;
  content: string;
  source?: 'cat-cafe' | 'personal';
  menuVisible?: boolean;
}): SkillRouterCatalogEntry {
  return {
    ...params,
    relativePath: toRelativeRepoPath(params.sourcePath),
    source: params.source ?? 'cat-cafe',
    menuVisible: params.menuVisible ?? true,
  };
}

function normalizeCatalogEntry(entry: SkillManifestEntry): SkillRouterCatalogEntry | null {
  if (entry.source !== 'cat-cafe' || entry.clowder_available === false) return null;
  if (typeof entry.name !== 'string' || !entry.name.trim()) return null;
  if (typeof entry.source_path !== 'string' || !entry.source_path.trim()) return null;

  const sourcePath = resolve(entry.source_path);
  const content = readSkillContent(sourcePath);
  if (!content) return null;

  const frontmatter = parseSkillFrontmatter(content);
  const name = frontmatterName(frontmatter, entry.name);
  const frontmatterDescription =
    typeof frontmatter.description === 'string' ? flattenText(frontmatter.description) : '';
  const manifestDescription =
    typeof entry.description === 'string' && entry.description.trim() !== '>' ? flattenText(entry.description) : '';

  return makeCatalogEntry({
    id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `cat-cafe:${name}`,
    name,
    description: frontmatterDescription || manifestDescription || name,
    triggers: skillTriggers(frontmatter, entry.triggers, name),
    riskLevel: typeof entry.risk_level === 'string' && entry.risk_level.trim() ? entry.risk_level.trim() : 'unknown',
    sourcePath,
    content,
  });
}

function normalizeRepoManifestEntry(name: string, entry: RepoSkillManifestEntry): SkillRouterCatalogEntry | null {
  if (!name.trim()) return null;

  const sourcePath = resolve(resolveRepoSkillRoot(), name, 'SKILL.md');
  const content = readSkillContent(sourcePath);
  if (!content) return null;

  const frontmatter = parseSkillFrontmatter(content);
  const skillName = frontmatterName(frontmatter, name);
  const manifestDescription = typeof entry.description === 'string' ? flattenText(entry.description) : '';

  return makeCatalogEntry({
    id: `cat-cafe:${skillName}`,
    name: skillName,
    description: frontmatterDescription(frontmatter) || manifestDescription || skillName,
    triggers: skillTriggers(frontmatter, entry.triggers, skillName),
    riskLevel: 'repo',
    sourcePath,
    content,
  });
}

function loadExternalManifestEntries(manifestPath: string): SkillRouterCatalogEntry[] {
  const manifest = safeReadJson(manifestPath);
  return (manifest?.skills ?? [])
    .map(normalizeCatalogEntry)
    .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry));
}

function loadRepoManifestEntries(): SkillRouterCatalogEntry[] {
  const manifestPath = resolve(resolveRepoSkillRoot(), 'manifest.yaml');
  const manifest = safeReadRepoManifest(manifestPath);
  return Object.entries(manifest?.skills ?? {})
    .map(([name, entry]) => normalizeRepoManifestEntry(name, entry))
    .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry));
}

function listExternalSkillDirs(): string[] {
  const externalRoot = resolve(resolveRepoSkillRoot(), 'external');
  if (!existsSync(externalRoot)) return [];
  try {
    return readdirSync(externalRoot, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
      .map((entry) => resolve(externalRoot, entry.name))
      .filter((dirPath) => existsSync(resolve(dirPath, 'SKILL.md')));
  } catch {
    return [];
  }
}

function normalizeExternalSkillEntry(sourcePath: string): SkillRouterCatalogEntry | null {
  const content = readSkillContent(sourcePath);
  if (!content) return null;

  const frontmatter = parseSkillFrontmatter(content);
  const dirName = basename(dirname(sourcePath));
  const skillName = frontmatterName(frontmatter, dirName);

  return makeCatalogEntry({
    id: `external:${skillName}`,
    name: skillName,
    description: frontmatterDescription(frontmatter) || skillName,
    triggers: skillTriggers(frontmatter, undefined, skillName),
    riskLevel: 'external',
    sourcePath,
    content: '',
    source: 'personal',
    menuVisible: true,
  });
}

function loadExternalSkillDirectoryEntries(): SkillRouterCatalogEntry[] {
  return listExternalSkillDirs()
    .map((dirPath) => normalizeExternalSkillEntry(resolve(dirPath, 'SKILL.md')))
    .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry));
}

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) return [...fallback];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolvePersonalIndexPath(): string {
  return resolvePersonalSkillIndexPath(
    findMonorepoRoot(),
    process.env.CAT_CAFE_PERSONAL_SKILL_INDEX_PATH,
    process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
  );
}

function resolvePersonalRoots(): string[] {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  return splitCsv(process.env.CAT_CAFE_PERSONAL_SKILL_ROOTS, DEFAULT_PERSONAL_SKILL_ROOTS).map((root) =>
    resolve(expandTildePath(root, homeDir)),
  );
}

function resolvePersonalVisibleNames(): Set<string> {
  return new Set(splitCsv(process.env.CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES, DEFAULT_PERSONAL_SKILL_VISIBLE_NAMES));
}

function fileFingerprint(path: string): string {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.mtimeNs.toString()}:${stats.size.toString()}`;
  } catch {
    return '0:0';
  }
}

function externalSkillDirFingerprint(): string {
  try {
    const dirs = listExternalSkillDirs();
    return dirs
      .map((dirPath) => `${dirPath}:${fileFingerprint(resolve(dirPath, 'SKILL.md'))}`)
      .sort()
      .join('|');
  } catch {
    return '';
  }
}

function skillRouterCatalogCacheKey(manifestPath: string, repoManifestPath: string): string {
  const personalEnabled = isPersonalSkillsEnabled(process.env.CAT_CAFE_PERSONAL_SKILLS_ENABLED);
  const personalIndexPath = resolvePersonalIndexPath();
  return JSON.stringify({
    manifestPath,
    manifest: fileFingerprint(manifestPath),
    repoManifestPath,
    repoManifest: fileFingerprint(repoManifestPath),
    personalEnabled,
    personalIndexPath,
    personalIndex: personalEnabled ? fileFingerprint(personalIndexPath) : 'disabled',
    personalRoots: resolvePersonalRoots(),
    personalVisibleNames: [...resolvePersonalVisibleNames()].sort(),
    externalSkillDir: externalSkillDirFingerprint(),
  });
}

function normalizePersonalIndexEntry(entry: PersonalSkillIndexEntry): SkillRouterCatalogEntry | null {
  if (typeof entry.name !== 'string' || !entry.name.trim()) return null;
  const name = entry.name.trim();
  const sourcePath = typeof entry.sourcePath === 'string' && entry.sourcePath.trim() ? resolve(entry.sourcePath) : '';
  const relativePath =
    typeof entry.relativePath === 'string' && entry.relativePath.trim() ? entry.relativePath.trim() : sourcePath;
  const description = typeof entry.description === 'string' ? flattenText(entry.description) : name;
  const category = typeof entry.category === 'string' && entry.category.trim() ? entry.category.trim() : 'personal';

  return {
    id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `personal:${name}`,
    name,
    description,
    triggers: skillTriggers({ triggers: toStringList(entry.triggers) }, undefined, name),
    riskLevel: category,
    sourcePath,
    relativePath,
    // Personal skill bodies must not enter automatic router context.
    content: '',
    source: 'personal',
    menuVisible: entry.visible === true,
  };
}

function loadPersonalIndexEntries(): SkillRouterCatalogEntry[] {
  if (!isPersonalSkillsEnabled(process.env.CAT_CAFE_PERSONAL_SKILLS_ENABLED)) return [];
  const index = safeReadPersonalIndex(resolvePersonalIndexPath());
  return (index?.skills ?? [])
    .map(normalizePersonalIndexEntry)
    .filter((entry): entry is SkillRouterCatalogEntry => Boolean(entry));
}

function mergeSkillEntries(entries: SkillRouterCatalogEntry[]): SkillRouterCatalogEntry[] {
  const byName = new Map<string, SkillRouterCatalogEntry>();
  for (const entry of entries) {
    byName.set(entry.name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export function loadSkillRouterCatalog(): SkillRouterCatalogEntry[] {
  const manifestPath = resolveSkillManifestPath();
  const repoManifestPath = resolve(resolveRepoSkillRoot(), 'manifest.yaml');
  const cacheKey = skillRouterCatalogCacheKey(manifestPath, repoManifestPath);

  if (catalogCache?.cacheKey === cacheKey) {
    return catalogCache.entries;
  }

  try {
    const entries = mergeSkillEntries([
      ...loadPersonalIndexEntries(),
      ...loadExternalManifestEntries(manifestPath),
      ...loadRepoManifestEntries(),
      ...loadExternalSkillDirectoryEntries(),
    ]);

    catalogCache = { cacheKey, entries };
    return entries;
  } catch {
    catalogCache = null;
    return [];
  }
}

function scoreSkillMatch(message: string, skill: SkillRouterCatalogEntry): number {
  let score = 0;
  for (const trigger of skill.triggers) {
    const normalizedTrigger = normalizeForLiteralMatch(trigger);
    if (normalizedTrigger.length < 2) continue;
    if (includesTrigger(message, trigger)) {
      score += normalizedTrigger.length >= 4 ? 3 : 2;
    }
  }
  if (includesTrigger(message, skill.name)) score += 4;
  return score;
}

function matchExplicitCommand(message: string, skills: SkillRouterCatalogEntry[]): SkillRouterCatalogEntry | null {
  if (!message.startsWith('/')) return null;
  const command = message.slice(1).split(/\s+/)[0].toLowerCase();
  if (!command) return null;
  return (
    skills.find((s) => s.name.toLowerCase() === command) ??
    skills.find((s) => s.triggers.some((trigger) => trigger.toLowerCase() === `/${command}`)) ??
    null
  );
}

function matchSkills(userMessageText: string, skills: SkillRouterCatalogEntry[]): SkillRouterCatalogEntry[] {
  const message = userMessageText.trim();
  if (!message) return [];

  // 显式 /command 优先
  const explicit = matchExplicitCommand(message, skills);
  if (explicit) return [explicit];

  const fuzzyMatchableSkills = skills.filter((skill) => skill.source !== 'personal' || skill.menuVisible);
  return fuzzyMatchableSkills
    .map((skill) => ({ skill, score: scoreSkillMatch(message, skill) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name, 'zh-Hans-CN'))
    .slice(0, MAX_MATCHED_SKILLS)
    .map((item) => item.skill);
}

export function resolveSkillRouterContext(userMessageText: string | undefined): SkillRouterContext | null {
  const skills = loadSkillRouterCatalog();
  if (skills.length === 0) return null;

  const matchedSkills = matchSkills(userMessageText ?? '', skills);
  const lines = [
    '## Skill Router',
    '你可以使用 cat-cafe skills 来辅助任务。用 `cat_cafe_list_skills` 查看可用 skill 列表，用 `cat_cafe_read_skill` 查看具体内容。',
    '',
    '## Workflow Reuse Gate',
    '1. 命中 slash command、快车道或已有 skill 时，优先复用已命中的 workflow/skill；先读对应 SKILL.md 或 manifest，再执行。',
    '2. 未命中明确 skill 时，进入探索模式：先明确目标、风险和验证方式，不重复造已有轮子。',
    '3. 探索完成后，仅当重复、高频、步骤稳定、异常可枚举时，提示是否沉淀为 skill/workflow；一次性任务不要强行固化。',
  ];

  if (matchedSkills.length > 0) {
    lines.push(
      '',
      '## Skill Router 命中',
      `本轮根据用户消息命中 skill: ${matchedSkills.map((skill) => skill.name).join(', ')}`,
      '请用 `cat_cafe_read_skill` 查看对应 SKILL.md 后执行；如果 skill 与用户明确要求冲突，以用户要求和安全边界为准。',
    );
  }

  return {
    promptBlock: lines.join('\n'),
    matchedSkillNames: matchedSkills.map((skill) => skill.name),
    menuSkillCount: skills.filter((skill) => skill.menuVisible).length,
  };
}
