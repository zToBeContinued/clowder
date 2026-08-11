import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';
import { pathsEqual } from '../../../../../utils/project-path.js';
import { AGENT_MEMORY_MAX_CHARS, getAgentMemoryPath, getAgentProjectMemoryPath } from './AgentMemoryStore.js';

export const MEMORY_AUTO_WRITE_MIN_INTERVAL_MS = 60_000;
const MAX_SUMMARY_CHARS = 500;
const MAX_RECENT_VALIDATION_ITEMS = 20;

const lastWriteAtByMemoryPath = new Map<string, number>();
const writeLockByMemoryPath = new Map<string, Promise<void>>();
let tempFileSequence = 0;

export interface AgentMemoryInvocationSummary {
  catId: string;
  invocationId: string;
  threadId: string;
  currentUserMessageId?: string | undefined;
  assistantText?: string | undefined;
  error?: string | undefined;
  completedAt?: number | undefined;
}

export interface AgentMemoryAutoWriteResult {
  status: 'updated' | 'skipped';
  reason?: 'rate_limited' | 'empty_summary' | 'write_disabled';
  path?: string;
  content?: string;
}

export interface AgentMemoryAutoWriterOptions {
  projectRoot?: string;
  /**
   * Path of the project the cat was working in. When set, the write goes to the
   * per-project shard memory/{catId}/{projectSlug}.md (kept in the Clowder root,
   * NOT inside the external project) so parallel work on different projects no
   * longer overwrites the same「当前状态/最近交付」lines.
   */
  projectPath?: string;
  now?: () => number;
  minIntervalMs?: number;
  force?: boolean;
}

interface ParsedMemory {
  title: string;
  sections: { heading: string; body: string }[];
}

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function trimOneLine(input: string, maxChars: number): string {
  return input
    .replace(/\s+/g, ' ')
    .replace(/[`*_#>]/g, '')
    .trim()
    .slice(0, maxChars);
}

function buildInvocationSummary(summary: AgentMemoryInvocationSummary): string {
  const text = trimOneLine(summary.assistantText ?? '', MAX_SUMMARY_CHARS);
  if (!text) return '';
  const taskHint = summary.currentUserMessageId
    ? `message ${summary.currentUserMessageId}`
    : `thread ${summary.threadId}`;
  return `${taskHint} / invocation ${summary.invocationId}: ${text}`;
}

function parseMemory(content: string, catId: string): ParsedMemory {
  const normalized = content.trim();
  if (!normalized) {
    return {
      title: `# ${catId} 记忆`,
      sections: [
        { heading: '当前状态', body: '' },
        { heading: '已关闭决策（别再提了）', body: '' },
        { heading: '行为偏好（用户纠正过的）', body: '' },
        { heading: '环境 gotcha', body: '' },
        { heading: '最近验证', body: '' },
      ],
    };
  }

  const lines = normalized.split(/\r?\n/);
  const title = lines[0]?.startsWith('# ') ? lines[0] : `# ${catId} 记忆`;
  const bodyLines = lines[0]?.startsWith('# ') ? lines.slice(1) : lines;
  const sections: ParsedMemory['sections'] = [];
  let current: { heading: string; bodyLines: string[] } | null = null;

  for (const line of bodyLines) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      if (current) sections.push({ heading: current.heading, body: current.bodyLines.join('\n').trim() });
      current = { heading: headingMatch[1] ?? '', bodyLines: [] };
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.bodyLines.join('\n').trim() });

  return { title, sections };
}

function getSection(parsed: ParsedMemory, keyword: string): { heading: string; body: string } | undefined {
  return parsed.sections.find((section) => section.heading.includes(keyword));
}

function setSection(parsed: ParsedMemory, preferredHeading: string, body: string): void {
  const keyword = preferredHeading.replace(/（.*?）/g, '').trim();
  const existing = getSection(parsed, keyword);
  if (existing) {
    existing.body = body.trim();
    return;
  }
  parsed.sections.push({ heading: preferredHeading, body: body.trim() });
}

function updateCurrentStatusBody(existingBody: string, date: string, delivery: string): string {
  const lines = existingBody
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const next: string[] = [];
  let wroteLastActive = false;
  let wroteLastDelivery = false;

  for (const line of lines) {
    if (/^-\s*最后活跃[:：]/.test(line)) {
      next.push(`- 最后活跃：${date}`);
      wroteLastActive = true;
      continue;
    }
    if (/^-\s*上次交付[:：]/.test(line)) {
      next.push(`- 上次交付：${delivery}`);
      wroteLastDelivery = true;
      continue;
    }
    next.push(line);
  }

  if (!wroteLastActive) next.unshift(`- 最后活跃：${date}`);
  if (!next.some((line) => /^-\s*正在处理[:：]/.test(line))) {
    next.splice(1, 0, '- 正在处理：最近一次成功 invocation 后自动回写，等待人工确认具体任务状态。');
  }
  if (!wroteLastDelivery) next.push(`- 上次交付：${delivery}`);

  return next.join('\n');
}

function updateRecentValidationBody(existingBody: string, date: string, summary: AgentMemoryInvocationSummary): string {
  const invocationLine = `- ${date} auto-writer：成功完成 invocation ${summary.invocationId}（thread ${summary.threadId}），已自动刷新当前状态。`;
  const existing = existingBody
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.includes(`invocation ${summary.invocationId}`));
  return [invocationLine, ...existing].slice(0, MAX_RECENT_VALIDATION_ITEMS).join('\n');
}

function renderMemory(parsed: ParsedMemory): string {
  const chunks = [parsed.title.trim()];
  for (const section of parsed.sections) {
    chunks.push(`## ${section.heading.trim()}`);
    chunks.push(section.body.trim());
  }
  const rendered = `${chunks
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
  return rendered.length > AGENT_MEMORY_MAX_CHARS
    ? `${rendered.slice(0, AGENT_MEMORY_MAX_CHARS - 40)}\n\n[Agent Memory 内容过长，已截断]\n`
    : rendered;
}

async function withMemoryWriteLock<T>(memoryPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = writeLockByMemoryPath.get(memoryPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLockByMemoryPath.set(memoryPath, current);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (writeLockByMemoryPath.get(memoryPath) === current) {
      writeLockByMemoryPath.delete(memoryPath);
    }
  }
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${tempFileSequence++}.tmp`;
  try {
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function updateAgentMemoryContent(oldContent: string, summary: AgentMemoryInvocationSummary): string {
  const completedAt = summary.completedAt ?? Date.now();
  const date = formatDate(completedAt);
  const delivery = buildInvocationSummary(summary);
  if (!delivery) return oldContent;

  const parsed = parseMemory(oldContent, summary.catId);
  const current = getSection(parsed, '当前状态')?.body ?? '';
  const recent = getSection(parsed, '最近验证')?.body ?? '';
  setSection(parsed, '当前状态', updateCurrentStatusBody(current, date, delivery));
  setSection(parsed, '最近验证', updateRecentValidationBody(recent, date, summary));
  return renderMemory(parsed);
}

export async function autoUpdateAgentMemory(
  summary: AgentMemoryInvocationSummary,
  options: AgentMemoryAutoWriterOptions = {},
): Promise<AgentMemoryAutoWriteResult> {
  if (process.env.CAT_CAFE_DISABLE_MEMORY_AUTO_WRITE === '1') {
    return { status: 'skipped', reason: 'write_disabled' };
  }

  const now = options.now?.() ?? Date.now();
  const minIntervalMs = options.minIntervalMs ?? MEMORY_AUTO_WRITE_MIN_INTERVAL_MS;

  const delivery = buildInvocationSummary({ ...summary, completedAt: now });
  if (!delivery) {
    return { status: 'skipped', reason: 'empty_summary' };
  }

  const projectRoot = options.projectRoot ?? findMonorepoRoot();
  // Project shard when the invocation ran in an EXTERNAL project; the Clowder
  // host project itself keeps writing the global file (it is "home", not a
  // side gig). Rate-limit + write lock are keyed by path, so shards throttle
  // independently and parallel projects never clobber each other's state.
  const useProjectShard = Boolean(options.projectPath && !pathsEqual(options.projectPath, findMonorepoRoot()));
  const memoryPath = useProjectShard
    ? getAgentProjectMemoryPath(summary.catId, options.projectPath!, projectRoot)
    : getAgentMemoryPath(summary.catId, projectRoot);
  const memoryDir = dirname(memoryPath);
  return withMemoryWriteLock(memoryPath, async () => {
    const lastWriteAt = lastWriteAtByMemoryPath.get(memoryPath) ?? 0;
    if (!options.force && now - lastWriteAt < minIntervalMs) {
      return { status: 'skipped', reason: 'rate_limited' };
    }

    const oldContent = existsSync(memoryPath) ? await readFile(memoryPath, 'utf-8') : '';
    const nextContent = updateAgentMemoryContent(oldContent, { ...summary, completedAt: now });

    await mkdir(memoryDir, { recursive: true });
    await writeFileAtomically(memoryPath, nextContent);
    lastWriteAtByMemoryPath.set(memoryPath, now);

    return {
      status: 'updated',
      path: join(memoryDir, basename(memoryPath)),
      content: nextContent,
    };
  });
}

export function resetAgentMemoryAutoWriterForTests(): void {
  lastWriteAtByMemoryPath.clear();
  writeLockByMemoryPath.clear();
  tempFileSequence = 0;
}
