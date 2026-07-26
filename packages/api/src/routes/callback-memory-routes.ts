import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { IEvidenceStore, IMarkerQueue, IReflectionService } from '../domains/memory/interfaces.js';
import type { MarkerQueueRouter } from '../domains/memory/MarkerQueueRouter.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { claimCallbackSideEffect } from './callback-freshness-side-effect.js';

interface CallbackMemoryRoutesDeps {
  /** F102: DI — SQLite-backed services (required) */
  evidenceStore: IEvidenceStore;
  markerQueue: IMarkerQueue;
  reflectionService: IReflectionService;
  freshnessGate?: FreshnessEgressGate;
  registry: Pick<InvocationRegistry, 'isLatest'>;
  /**
   * 按 thread 所属项目路由 marker。缺省时全部落到 `markerQueue`（旧行为），
   * 那会把外部项目的知识写进本仓库的 docs/markers/。
   */
  markerQueueRouter?: MarkerQueueRouter;
  /** 解析 thread.projectPath 用；与 markerQueueRouter 同时提供才生效。 */
  threadStore?: Pick<IThreadStore, 'get'>;
}

const searchEvidenceQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

const reflectSchema = z.object({
  query: z.string().trim().min(1),
});
const retainMemorySchema = z.object({
  content: z.string().trim().min(1).max(50000),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
  metadata: z.record(z.string()).optional(),
});

/**
 * 选择该 thread 的 marker 队列：外部项目的知识写回它自己的项目，不进本仓库知识库。
 * 拿不到 thread（已删除/store 报错）时退回本地队列 —— 丢 marker 比静默失败更糟。
 */
async function resolveMarkerQueue(deps: CallbackMemoryRoutesDeps, threadId: string): Promise<IMarkerQueue> {
  if (!deps.markerQueueRouter || !deps.threadStore) return deps.markerQueue;
  const thread = await Promise.resolve(deps.threadStore.get(threadId)).catch(() => null);
  return deps.markerQueueRouter.resolve(thread?.projectPath);
}

export async function registerCallbackMemoryRoutes(
  app: FastifyInstance,
  deps: CallbackMemoryRoutesDeps,
): Promise<void> {
  app.get('/api/callbacks/search-evidence', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = searchEvidenceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parsed.error.issues };
    }
    const { q, limit } = parsed.data;

    try {
      const items = await deps.evidenceStore.search(q, { limit: limit ?? 5 });
      const results = items.map((item) => ({
        title: item.title,
        anchor: item.anchor,
        snippet: item.summary ?? '',
        confidence: 'mid' as const,
        sourceType: (item.kind === 'decision' ? 'decision' : item.kind === 'plan' ? 'phase' : 'discussion') as
          | 'decision'
          | 'phase'
          | 'discussion',
      }));
      return { results, degraded: false };
    } catch {
      return { results: [], degraded: true, degradeReason: 'evidence_store_error' };
    }
  });

  app.post('/api/callbacks/reflect', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = reflectSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { query } = parsed.data;

    try {
      const reflection = await deps.reflectionService.reflect(query);
      return { reflection, degraded: false, dispositionMode: 'off' as const };
    } catch {
      return {
        reflection: '',
        degraded: true,
        degradeReason: 'reflection_service_error',
        dispositionMode: 'off' as const,
      };
    }
  });

  app.post('/api/callbacks/retain-memory', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = retainMemorySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const { content } = parsed.data;

    const freshness = await claimCallbackSideEffect({
      freshnessGate: deps.freshnessGate,
      registry: deps.registry,
      record,
      route: 'retain-memory',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return freshness.response;

    try {
      const queue = await resolveMarkerQueue(deps, record.threadId);
      await queue.submit({
        content,
        source: `callback:${record.catId}:${record.invocationId}`,
        status: 'captured',
      });
      return { status: 'ok' };
    } catch {
      return { status: 'degraded', degradeReason: 'marker_queue_error' };
    }
  });
}
