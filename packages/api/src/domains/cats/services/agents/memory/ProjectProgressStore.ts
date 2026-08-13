import { existsSync } from 'node:fs';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextHealth, SessionRecord } from '@cat-cafe/shared';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

export const PROJECT_PROGRESS_MAX_CHARS = 12_000;
export const PROJECT_BRIEF_MAX_CHARS = 8_000;
export const PROJECT_DECISIONS_MAX_CHARS = 8_000;
export const PROJECT_HANDOFF_INDEX_MAX_CHARS = 6_000;
export const PROJECT_BOOTSTRAP_HANDOFF_INDEX_MAX_CHARS = 4_000;

export type ResumeTrust = 'trusted' | 'stale' | 'needs_revalidation';

export interface ProjectProgressRecord {
  id: string;
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
}

function assertSafeProjectId(projectId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
    throw new Error(`Invalid projectId "${projectId}"`);
  }
}

export function getProjectProgressDir(projectRoot = findMonorepoRoot()): string {
  return join(projectRoot, '.cat-cafe', 'projects');
}

export function getProjectProgressPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'progress.md');
}

export function getProjectBriefPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'brief.md');
}

export function getProjectHandoffLogPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'handoff-log.md');
}

export function getProjectDecisionsPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'decisions.md');
}

export function getProjectHandoffIndexPath(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId, 'handoff-index.md');
}

function getProjectDir(projectId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeProjectId(projectId);
  return join(getProjectProgressDir(projectRoot), projectId);
}

async function readProjectFile(
  projectId: string,
  path: string,
  maxChars: number,
  overflowLabel: string,
): Promise<ProjectProgressRecord> {
  if (!existsSync(path)) {
    return { id: projectId, path, content: '', exists: false, truncated: false };
  }
  const raw = await readFile(path, 'utf-8');
  const truncated = raw.length > maxChars;
  return {
    id: projectId,
    path,
    content: truncated ? `${raw.slice(0, maxChars)}\n\n[${overflowLabel}内容过长，已截断]` : raw,
    exists: true,
    truncated,
  };
}

export async function readProjectBrief(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectBriefPath(projectId, projectRoot);
  return readProjectFile(projectId, path, PROJECT_BRIEF_MAX_CHARS, '项目简介');
}

export async function readProjectProgress(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectProgressPath(projectId, projectRoot);
  return readProjectFile(projectId, path, PROJECT_PROGRESS_MAX_CHARS, '项目进度');
}

export async function readProjectDecisions(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectDecisionsPath(projectId, projectRoot);
  return readProjectFile(projectId, path, PROJECT_DECISIONS_MAX_CHARS, '项目决策');
}

export async function readProjectHandoffIndex(
  projectId: string,
  projectRoot = findMonorepoRoot(),
): Promise<ProjectProgressRecord> {
  const path = getProjectHandoffIndexPath(projectId, projectRoot);
  return readProjectFile(projectId, path, PROJECT_HANDOFF_INDEX_MAX_CHARS, '交接索引');
}

export async function readProjectHandoffIndexesForBootstrap(
  projectIds = getConfiguredProjectProgressIds(),
  projectRoot = findMonorepoRoot(),
): Promise<string | null> {
  if (projectIds.length === 0) return null;
  const records = await Promise.all(
    projectIds.map((id) =>
      readProjectFile(
        id,
        getProjectHandoffIndexPath(id, projectRoot),
        PROJECT_BOOTSTRAP_HANDOFF_INDEX_MAX_CHARS,
        '交接索引',
      ),
    ),
  );
  const blocks = records
    .filter((record) => record.exists && record.content.trim())
    .map((record) =>
      [
        `[Project Handoff Index — ${record.id}; durable file, reference only]`,
        record.content.trim(),
        '[/Project Handoff Index]',
      ].join('\n'),
    );
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

export async function listProjectProgressIds(projectRoot = findMonorepoRoot()): Promise<string[]> {
  const dir = getProjectProgressDir(projectRoot);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function getConfiguredProjectProgressIds(): string[] {
  return (process.env.CAT_CAFE_PROJECT_CONTEXT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export async function readProjectProgressForPrompt(
  projectIds = getConfiguredProjectProgressIds(),
  projectRoot = findMonorepoRoot(),
): Promise<string | null> {
  if (projectIds.length === 0) return null;

  try {
    const records = await Promise.all(
      projectIds.map(async (id) => ({
        id,
        brief: await readProjectBrief(id, projectRoot),
        progress: await readProjectProgress(id, projectRoot),
        decisions: await readProjectDecisions(id, projectRoot),
        handoffIndex: await readProjectHandoffIndex(id, projectRoot),
      })),
    );
    const blocks = records
      .filter(
        ({ brief, progress, decisions, handoffIndex }) =>
          (brief.exists && brief.content.trim()) ||
          (progress.exists && progress.content.trim()) ||
          (decisions.exists && decisions.content.trim()) ||
          (handoffIndex.exists && handoffIndex.content.trim()),
      )
      .map(({ id, brief, progress, decisions, handoffIndex }) => {
        const parts = [
          `<!-- project:${id} brief_path:${brief.path} progress_path:${progress.path} decisions_path:${decisions.path} handoff_index_path:${handoffIndex.path} -->`,
        ];
        if (brief.exists && brief.content.trim()) {
          parts.push('## 项目简介（brief.md）', brief.content.trim());
        }
        if (progress.exists && progress.content.trim()) {
          if (!brief.exists) {
            parts.push('⚠️ 项目状态：needs_brief（未找到 brief.md）');
          }
          parts.push('## 项目进度（progress.md）', progress.content.trim());
        }
        if (decisions.exists && decisions.content.trim()) {
          parts.push('## 项目决策（decisions.md）', decisions.content.trim());
        }
        if (handoffIndex.exists && handoffIndex.content.trim()) {
          parts.push(
            '## 交接索引（handoff-index.md）',
            '先读索引，只在当前任务命中模块、日期、关键词或风险点时再打开具体 handoff。',
            handoffIndex.content.trim(),
          );
        }
        return parts.join('\n');
      });

    return blocks.length > 0 ? blocks.join('\n\n---\n\n') : null;
  } catch {
    return null;
  }
}

export interface ProjectHandoffLogEntry {
  timestamp: string;
  fromCatId: string;
  toCatId: string;
  status: string;
  summary?: string;
}

export interface ContextHandoffEntry {
  timestamp?: string;
  threadId: string;
  catId: string;
  fromSessionId: string;
  toSessionId?: string;
  reason: string;
  trust: ResumeTrust;
  health?: ContextHealth;
  what?: string;
  why?: string;
  next?: string;
  blocker?: string;
  verify?: string;
  refs?: string[];
  source?: 'runtime-threshold' | 'precompact-hook' | 'manual';
}

export interface ContextHandoffWriteResult {
  written: number;
  skipped: number;
  projectIds: string[];
  timestamp: string;
}

function singleLine(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function multilineValue(value: string | undefined, fallback: string): string {
  return singleLine(value).slice(0, 600) || fallback;
}

export function inferResumeTrustForSessionHandoff(input: {
  reason?: string;
  session?: Pick<SessionRecord, 'status' | 'sealReason' | 'contextHealth'> | null;
  hasVerifyEvidence?: boolean;
}): ResumeTrust {
  const reason = `${input.reason ?? ''} ${input.session?.sealReason ?? ''}`.toLowerCase();
  if (/restart|interrupted|crash|error|failed|restore_failure|resume_failure/.test(reason)) {
    return input.hasVerifyEvidence ? 'stale' : 'needs_revalidation';
  }
  if (input.session && input.session.status !== 'active' && input.session.status !== 'sealing') {
    return input.hasVerifyEvidence ? 'stale' : 'needs_revalidation';
  }
  return 'trusted';
}

function formatHealth(health: ContextHealth | undefined): string {
  if (!health) return 'unknown';
  const pct = Math.round(health.fillRatio * 1000) / 10;
  return `${pct}% (${health.usedTokens}/${health.windowTokens}, ${health.source})`;
}

function formatContextHandoffIndexEntry(
  entry: Required<Pick<ContextHandoffEntry, 'timestamp'>> & ContextHandoffEntry,
): string {
  const what = multilineValue(
    entry.what,
    `Session ${entry.fromSessionId} reached context handoff boundary for @${entry.catId} in thread ${entry.threadId}.`,
  );
  const why = multilineValue(
    entry.why,
    `Context lifecycle trigger: ${entry.reason}; health=${formatHealth(entry.health)}.`,
  );
  const next = multilineValue(
    entry.next,
    'Start by reading this handoff-index entry, current task thread state, and latest verification evidence before continuing edits.',
  );
  const blocker = multilineValue(entry.blocker, 'none');
  const verify = multilineValue(
    entry.verify,
    'Re-run the active task verification commands from the task thread; for code work, first confirm `git status --short --branch`.',
  );
  const refs = [
    `from-session: ${entry.fromSessionId}`,
    `to-session: ${entry.toSessionId ?? 'next-session'}`,
    `thread: ${entry.threadId}`,
    `cat: ${entry.catId}`,
    `reason: ${entry.reason}`,
    `source: ${entry.source ?? 'runtime-threshold'}`,
    ...(entry.refs ?? []),
  ];

  return [
    '',
    '---',
    '',
    `## ${entry.timestamp} · context-handoff`,
    `- **What**: ${what}`,
    `- **Why**: ${why}`,
    `- **Next**: ${next}`,
    `- **Blocker**: ${blocker}`,
    `- **Verify**: ${verify}`,
    `- **Trust**: ${entry.trust}`,
    '- **refs**:',
    ...refs.map((ref) => `  - ${singleLine(ref)}`),
    '',
  ].join('\n');
}

function formatContextHandoffLogEntry(
  entry: Required<Pick<ContextHandoffEntry, 'timestamp'>> & ContextHandoffEntry,
): string {
  return [
    '',
    '---',
    '',
    `## ${entry.timestamp}`,
    '- **type**: context-threshold-handoff',
    `- **from-session**: ${singleLine(entry.fromSessionId)}`,
    `- **to-session**: ${singleLine(entry.toSessionId) || 'next-session'}`,
    `- **cat**: ${singleLine(entry.catId)}`,
    `- **thread**: ${singleLine(entry.threadId)}`,
    `- **reason**: ${singleLine(entry.reason)}`,
    `- **trust**: ${entry.trust}`,
    `- **health**: ${formatHealth(entry.health)}`,
    '',
  ].join('\n');
}

function initialHandoffIndexHeader(projectId: string): string {
  return [
    `# ${projectId} · handoff-index`,
    '',
    '> 自动维护的交接索引。接手时先读本文件；只在命中相关主题时再回看详细日志。',
    '',
  ].join('\n');
}

function initialHandoffLogHeader(projectId: string): string {
  return [`# ${projectId} · handoff-log`, '', '> 自动追加的交接流水，不作为默认接手入口。', ''].join('\n');
}

function resolveWritableProjectIds(projectIds: string[], projectRoot: string): string[] {
  return projectIds.filter((projectId) => existsSync(getProjectDir(projectId, projectRoot)));
}

export async function writeContextHandoffForPromptProjects(
  entry: ContextHandoffEntry,
  projectIds = getConfiguredProjectProgressIds(),
  projectRoot = findMonorepoRoot(),
): Promise<ContextHandoffWriteResult> {
  const targetProjectIds = resolveWritableProjectIds(projectIds, projectRoot);
  const timestamp = entry.timestamp ?? new Date().toISOString();
  if (targetProjectIds.length === 0) {
    return { written: 0, skipped: projectIds.length, projectIds: [], timestamp };
  }

  const normalized = { ...entry, timestamp };
  for (const projectId of targetProjectIds) {
    const indexPath = getProjectHandoffIndexPath(projectId, projectRoot);
    const logPath = getProjectHandoffLogPath(projectId, projectRoot);
    await appendFile(
      indexPath,
      `${existsSync(indexPath) ? '' : initialHandoffIndexHeader(projectId)}${formatContextHandoffIndexEntry(normalized)}`,
      'utf-8',
    );
    await appendFile(
      logPath,
      `${existsSync(logPath) ? '' : initialHandoffLogHeader(projectId)}${formatContextHandoffLogEntry(normalized)}`,
      'utf-8',
    );
  }
  return {
    written: targetProjectIds.length,
    skipped: projectIds.length - targetProjectIds.length,
    projectIds: targetProjectIds,
    timestamp,
  };
}

export async function appendProjectHandoffLogForPromptProjects(
  entry: ProjectHandoffLogEntry,
  projectIds = getConfiguredProjectProgressIds(),
  projectRoot = findMonorepoRoot(),
): Promise<number> {
  if (projectIds.length === 0) return 0;
  let appended = 0;
  for (const projectId of projectIds) {
    try {
      const path = getProjectHandoffLogPath(projectId, projectRoot);
      if (!existsSync(path)) continue;
      const summary = singleLine(entry.summary) || '未提供摘要';
      await appendFile(
        path,
        [
          '',
          '---',
          '',
          `## ${entry.timestamp}`,
          `- **from**: ${singleLine(entry.fromCatId) || 'unknown'}`,
          `- **to**: ${singleLine(entry.toCatId) || 'unknown'}`,
          `- **状态**: ${singleLine(entry.status) || 'unknown'}`,
          `- **摘要**: ${summary}`,
          '',
        ].join('\n'),
        'utf-8',
      );
      appended += 1;
    } catch {
      // Handoff log write is best-effort; invalid/missing project config must not break A2A.
    }
  }
  return appended;
}
