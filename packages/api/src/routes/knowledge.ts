import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { findMonorepoRoot } from '../utils/monorepo-root.js';

const knowledgeTypeSchema = z.enum(['feature', 'lesson', 'decision']);

const createKnowledgeSchema = z
  .object({
    type: knowledgeTypeSchema,
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(8000),
    sourceThreadId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

type KnowledgeType = z.infer<typeof knowledgeTypeSchema>;

export interface CreateKnowledgeInput {
  type: KnowledgeType;
  title: string;
  summary: string;
  sourceThreadId?: string;
}

export interface CreateKnowledgeResult {
  type: KnowledgeType;
  path: string;
  id: string;
}

function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'knowledge';
}

function yamlString(input: string): string {
  return JSON.stringify(input);
}

async function nextNumberFromFiles(dir: string, pattern: RegExp): Promise<number> {
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir);
  let max = 0;
  for (const file of files) {
    const match = basename(file).match(pattern);
    if (!match?.[1]) continue;
    max = Math.max(max, Number.parseInt(match[1], 10));
  }
  return max + 1;
}

export async function createKnowledgeDoc(
  input: CreateKnowledgeInput,
  root = findMonorepoRoot(),
): Promise<CreateKnowledgeResult> {
  const created = new Date().toISOString().slice(0, 10);
  const sourceLine = input.sourceThreadId ? `source_refs: [${yamlString(`thread:${input.sourceThreadId}`)}]\n` : '';

  if (input.type === 'feature') {
    const featuresDir = join(root, 'docs', 'features');
    const next = await nextNumberFromFiles(featuresDir, /^F(\d{3})/i);
    const id = `F${String(next).padStart(3, '0')}`;
    const filename = `${id}-${slugify(input.title)}.md`;
    const relativePath = `docs/features/${filename}`;
    const content = `---\nfeature_ids: [${id}]\nrelated_features: []\ntopics: [knowledge-capture]\ndoc_kind: spec\ncreated: ${created}\n${sourceLine}---\n\n# ${id}: ${input.title}\n\n> **Status**: idea | **Owner**: 待定 | **Priority**: TBD\n>\n> 由 Clowder “沉淀为知识”入口生成。正式开发前需补齐 AC、依赖、风险和验收证据。\n\n## Why\n\n${input.summary}\n\n## What\n\n待补充。\n\n## Acceptance Criteria\n\n- [ ] AC-A1: 明确最终产物和完成标准。\n- [ ] AC-A2: 补齐实现范围、依赖和风险。\n\n## Dependencies\n\n- **Evolved from**: ${input.sourceThreadId ? `thread:${input.sourceThreadId}` : 'none'}\n- **Blocked by**: CVO scope confirmation\n- **Related**: none\n\n## Risk\n\n| 风险 | 缓解 |\n|------|------|\n| 由聊天摘要生成，范围可能不完整 | 进入 spec 前由 owner 复核并补齐 AC |\n\n## Key Decisions\n\n| # | 决策 | 理由 | 日期 |\n|---|------|------|------|\n| KD-1 | 先创建知识锚点 | 保留讨论入口，避免结论散落在聊天中 | ${created} |\n`;
    await writeFile(join(root, relativePath), content, 'utf8');
    return { type: input.type, path: relativePath, id };
  }

  if (input.type === 'decision') {
    const decisionsDir = join(root, 'docs', 'decisions');
    const next = await nextNumberFromFiles(decisionsDir, /^(\d{3})-/);
    const id = String(next).padStart(3, '0');
    const filename = `${id}-${slugify(input.title)}.md`;
    const relativePath = `docs/decisions/${filename}`;
    const content = `---\nfeature_ids: []\ntopics: [knowledge-capture]\ndoc_kind: decision\ncreated: ${created}\n${sourceLine}---\n\n# ADR-${id}: ${input.title}\n\nDate: ${created}\nStatus: Proposed\n\n## Context\n\n${input.summary}\n\n## Decision\n\n待补充。\n\n## Consequences\n\n- Positive: 讨论结论有稳定入口，可被后续检索和复查。\n- Negative: 由聊天摘要生成，进入 accepted 前需要 owner 复核。\n\n## Source\n\n${input.sourceThreadId ? `- thread:${input.sourceThreadId}` : '- manual knowledge capture'}\n`;
    await writeFile(join(root, relativePath), content, 'utf8');
    return { type: input.type, path: relativePath, id: `ADR-${id}` };
  }

  const lessonsPath = join(root, 'docs', 'public-lessons.md');
  const lessonsDir = join(root, 'docs');
  await mkdir(lessonsDir, { recursive: true });
  const existing = await readFile(lessonsPath, 'utf8').catch(() => '');
  const lessonMax = [...existing.matchAll(/### LL-(\d{3}):/g)].reduce(
    (max, match) => Math.max(max, Number.parseInt(match[1]!, 10)),
    0,
  );
  const id = `LL-${String(lessonMax + 1).padStart(3, '0')}`;
  const block = `\n\n### ${id}: ${input.title}\n- 状态：draft\n- 更新时间：${created}\n\n- 坑：${input.summary}\n- 根因：待补充。\n- 触发条件：待补充。\n- 修复：待补充。\n- 防护：待补充。\n- 来源锚点：${input.sourceThreadId ? `thread:${input.sourceThreadId}` : 'manual knowledge capture'}\n- 原理（可选）：待补充。\n\n- 关联：待补充。\n`;
  await appendFile(lessonsPath, block, 'utf8');
  return { type: input.type, path: 'docs/public-lessons.md', id };
}

export const knowledgeRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/knowledge', async (request, reply) => {
    const parsed = createKnowledgeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid knowledge payload', details: parsed.error.flatten() };
    }

    try {
      return await createKnowledgeDoc(parsed.data);
    } catch (err) {
      request.log.error({ err }, '[knowledge] failed to create knowledge doc');
      reply.status(500);
      return { error: err instanceof Error ? err.message : 'Failed to create knowledge doc' };
    }
  });
};
