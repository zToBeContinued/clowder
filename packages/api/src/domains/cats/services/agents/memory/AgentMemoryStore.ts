import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { findMonorepoRoot } from '../../../../../utils/monorepo-root.js';

export const AGENT_MEMORY_MAX_CHARS = 24_000;

export interface AgentMemoryRecord {
  catId: string;
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
}

function assertSafeCatId(catId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(catId)) {
    throw new Error(`Invalid catId "${catId}"`);
  }
}

export function getAgentMemoryDir(projectRoot = findMonorepoRoot()): string {
  return join(projectRoot, '.cat-cafe', 'memory');
}

export function getAgentMemoryPath(catId: string, projectRoot = findMonorepoRoot()): string {
  assertSafeCatId(catId);
  return join(getAgentMemoryDir(projectRoot), `${catId}.md`);
}

/**
 * 记忆按项目分区（cat 身份全局共享，记忆按干活的项目隔离）：
 * 同一只猫在多个项目并行工作时，「当前状态/最近交付」写进各自的项目分片，
 * 不再互相覆盖串味。全局文件 memory/{catId}.md 继续承载跨项目内容
 * （行为偏好、已关闭决策等）。分片集中放在 Clowder 根下，不往外部项目落盘。
 */

/** Stable, readable, filesystem-safe slug for a project path. */
export function getProjectMemorySlug(projectPath: string): string {
  const normalized = resolve(projectPath).replace(/[\\/]+$/, '');
  const canonical = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 8);
  const base =
    basename(normalized)
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  return `${base}-${hash}`;
}

/** Per-project memory shard: .cat-cafe/memory/{catId}/{projectSlug}.md (in the Clowder root). */
export function getAgentProjectMemoryPath(
  catId: string,
  projectPath: string,
  projectRoot = findMonorepoRoot(),
): string {
  assertSafeCatId(catId);
  return join(getAgentMemoryDir(projectRoot), catId, `${getProjectMemorySlug(projectPath)}.md`);
}

export async function readAgentMemory(catId: string, projectRoot = findMonorepoRoot()): Promise<AgentMemoryRecord> {
  const path = getAgentMemoryPath(catId, projectRoot);
  if (!existsSync(path)) {
    return { catId, path, content: '', exists: false, truncated: false };
  }
  const raw = await readFile(path, 'utf-8');
  const truncated = raw.length > AGENT_MEMORY_MAX_CHARS;
  return {
    catId,
    path,
    content: truncated ? `${raw.slice(0, AGENT_MEMORY_MAX_CHARS)}\n\n[Agent Memory 内容过长，已截断]` : raw,
    exists: true,
    truncated,
  };
}

/**
 * Prompt-facing read. With a projectPath, the project shard comes FIRST so the
 * summarizer (which picks the first matching section, e.g. 「当前状态」) prefers
 * project-scoped state over global; global memory follows for cross-project
 * preferences. Without a projectPath, behaves exactly as before (global only).
 */
export async function readAgentMemoryForPrompt(catId: string, projectPath?: string): Promise<string | null> {
  try {
    const record = await readAgentMemory(catId);
    const globalContent = record.content.trim();

    let projectContent = '';
    if (projectPath) {
      try {
        const shardPath = getAgentProjectMemoryPath(catId, projectPath);
        if (existsSync(shardPath)) {
          projectContent = (await readFile(shardPath, 'utf-8')).trim();
        }
      } catch {
        // Shard read is best-effort; fall back to global-only.
      }
    }

    const merged = [projectContent, globalContent].filter(Boolean).join('\n\n');
    if (!merged) return null;
    return merged.length > AGENT_MEMORY_MAX_CHARS
      ? `${merged.slice(0, AGENT_MEMORY_MAX_CHARS)}\n\n[Agent Memory 内容过长，已截断]`
      : merged;
  } catch {
    return null;
  }
}

export async function writeAgentMemory(
  catId: string,
  content: string,
  projectRoot = findMonorepoRoot(),
): Promise<AgentMemoryRecord> {
  const path = getAgentMemoryPath(catId, projectRoot);
  await mkdir(getAgentMemoryDir(projectRoot), { recursive: true });
  await writeFile(path, content.endsWith('\n') ? content : `${content}\n`, 'utf-8');
  return readAgentMemory(catId, projectRoot);
}
