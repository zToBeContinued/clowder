/**
 * Callback task routes — MCP post_message 回传的任务更新端点
 *
 * 修复记录：
 * - 症状一修复：freshness gate stale/replayed 使用 HTTP 409/200 而非默认 200，
 *   让 MCP 工具层能区分「写失败」和「成功」。
 * - 症状二修复：引入状态机验证，拒绝非法转换（如 done→doing）。
 * - 症状三修复：添加 delegateActorId 代切机制（需留审计痕迹）。
 */

import type { CatId } from '@cat-cafe/shared';
import { catRegistry, createCatId, validateStatusTransition, detectStatusFlapping } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { claimCallbackSideEffect } from './callback-freshness-side-effect.js';
import { deriveCallbackActor, resolveScopedThreadId } from './callback-scope-helpers.js';
import { ensureTaskDiscussionThread } from './task-discussion-thread.js';

const updateTaskSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(['todo', 'doing', 'in_review', 'blocked', 'done', 'failed']).optional(),
  failureClass: z
    .enum(['agent_error', 'build_failed', 'test_failed', 'timeout', 'budget_exhausted', 'infra_error', 'manual_fail'])
    .optional(),
  failureReason: z.string().max(2000).optional(),
  why: z.string().max(1000).optional(),
  /** 代切权限：当 owner 失联时，总负责人/派工方可用此字段代为切换状态 */
  delegateActorId: z.string().min(1).optional(),
  /** 交付证据：猫可在切 done/in_review 时同步填写 */
  evidence: z.object({
    tests: z.string().max(2000).optional(),
    build: z.string().max(2000).optional(),
    screenshot: z.string().max(2000).optional(),
    review: z.string().max(2000).optional(),
    lesson: z.string().max(2000).optional(),
  }).optional(),
});

const claimTaskSchema = z.object({
  taskId: z.string().min(1),
  why: z.string().max(1000).optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  why: z.string().max(1000).optional().default(''),
  ownerCatId: z.string().min(1).optional(),
});

const listTasksQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  catId: z.string().min(1).optional(),
  status: z.enum(['todo', 'doing', 'in_review', 'blocked', 'done', 'failed']).optional(),
  kind: z.enum(['work', 'pr_tracking']).optional(),
});

export function registerCallbackTaskRoutes(
  app: FastifyInstance,
  deps: {
    taskStore: ITaskStore;
    socketManager: SocketManager;
    messageStore?: IMessageStore;
    threadStore?: IThreadStore;
    freshnessGate?: FreshnessEgressGate;
    registry: Pick<InvocationRegistry, 'isLatest'>;
  },
): void {
  const { taskStore, socketManager, messageStore, threadStore } = deps;

  function emitTaskAttention(
    previousStatus: string | undefined,
    task: { kind?: string; status: string; userId?: string },
  ): void {
    if (task.kind === 'pr_tracking') return;
    if (!task.userId) return;
    if (previousStatus === task.status) return;
    if (task.status !== 'in_review' && task.status !== 'blocked' && task.status !== 'failed') return;
    socketManager.emitToUser(task.userId, 'task_attention', task);
  }

  app.post('/api/callbacks/update-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = updateTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { taskId, status, failureClass, failureReason, why, delegateActorId, evidence } = parsed.data;

    const existing = await taskStore.get(taskId);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (existing.threadId !== actor.threadId) {
      reply.status(403);
      return { error: 'Task belongs to a different thread' };
    }

    // 症状三修复：owner 检查支持代切
    // 如果提供了 delegateActorId，允许非 owner 代切（需要是同 thread 的猫）
    const isOwner = !existing.ownerCatId || existing.ownerCatId === actor.catId;
    const isDelegating = Boolean(delegateActorId);
    if (!isOwner && !isDelegating) {
      reply.status(403);
      return { error: 'Task is owned by another cat. Use delegateActorId to override (audited).' };
    }
    // 代切 actor 必须是已注册的猫
    if (isDelegating && !catRegistry.has(delegateActorId!)) {
      reply.status(400);
      return { error: `Unknown delegateActorId: ${delegateActorId}. Must be a registered cat.` };
    }

    // 症状二修复：状态机验证
    if (status && existing.status) {
      const transition = validateStatusTransition(existing.status, status);
      if (!transition.valid) {
        reply.status(409);
        return {
          error: 'Invalid status transition',
          reason: transition.reason,
          currentStatus: existing.status,
          requestedStatus: status,
        };
      }
    }

    // 抖动告警：blocked ↔ doing 频繁切换时返回 warning
    let flappingWarning: string | undefined;
    if (status && existing.events) {
      const flapping = detectStatusFlapping(existing.events);
      if (flapping) {
        flappingWarning = `Warning: task ${taskId} has high status-change frequency in the last 30 minutes. Consider investigating root cause.`;
        app.log.warn({ taskId, from: existing.status, to: status }, flappingWarning);
      }
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: deps.freshnessGate,
      registry: deps.registry,
      record,
      route: 'update-task',
      requestBody: parsed.data,
    });
    // 症状一修复：stale/replayed 使用明确的非 200 状态码
    if (freshness.outcome === 'stale') {
      reply.status(409);
      return { ...freshness.response, error: 'Invocation is stale — update was NOT applied. Retry with a fresh invocation.' };
    }
    if (freshness.outcome === 'replayed') {
      // 幂等重放，数据已写过，返回 200 但标记 replayed
      return { ...freshness.response, replayed: true };
    }

    const updateData: Record<string, unknown> = {};
    if (status) updateData.status = status;
    if (failureClass) updateData.failureClass = failureClass;
    if (failureReason) updateData.failureReason = failureReason;
    if (why) updateData.why = why;
    if (evidence) updateData.evidence = { ...evidence, updatedAt: Date.now() };
    // 代切时记录真实 actor 和代切者
    if (isDelegating) {
      updateData.eventCatId = delegateActorId;
    } else {
      updateData.eventCatId = actor.catId;
    }

    const updated = await taskStore.update(taskId, updateData);
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to update task' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    emitTaskAttention(existing.status, updated);

    const result: Record<string, unknown> = { status: 'ok', task: updated };
    if (isDelegating) {
      result.delegatedBy = actor.catId;
      result.delegateActor = delegateActorId;
    }
    if (flappingWarning) {
      result.warning = flappingWarning;
    }
    return result;
  });

  app.post('/api/callbacks/claim-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = claimTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { taskId, why } = parsed.data;
    const existing = await taskStore.get(taskId);
    if (!existing) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (existing.threadId !== actor.threadId) {
      reply.status(403);
      return { error: 'Task belongs to a different thread' };
    }
    if (existing.ownerCatId && existing.ownerCatId !== actor.catId) {
      reply.status(409);
      return { error: 'Task is already claimed by another cat', ownerCatId: existing.ownerCatId };
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: deps.freshnessGate,
      registry: deps.registry,
      record,
      route: 'claim-task',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale') {
      reply.status(409);
      return { ...freshness.response, error: 'Invocation is stale — claim was NOT applied.' };
    }
    if (freshness.outcome === 'replayed') return freshness.response;

    // 状态机校验：claim 隐含 current → doing 转换
    if (existing.status !== 'todo' && existing.status !== 'blocked') {
      const transition = validateStatusTransition(existing.status, 'doing');
      if (!transition.valid) {
        reply.status(409);
        return {
          error: 'Cannot claim task in current status',
          reason: transition.reason,
          currentStatus: existing.status,
        };
      }
    }

    const updated = await taskStore.update(taskId, {
      ownerCatId: actor.catId,
      status: 'doing',
      eventCatId: actor.catId,
      ...(why ? { why } : {}),
    });
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to claim task' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    return { status: 'ok', task: updated };
  });

  // F160: create-task — kind forced to 'work' (KD-4)
  app.post('/api/callbacks/create-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = createTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { title, why, ownerCatId } = parsed.data;

    // F182 AC-C2: B class — validate ownerCatId is available (contract 400 on disabled)
    let resolvedOwnerCatId: CatId | null = null;
    if (ownerCatId) {
      const resolved = resolveCatTarget(ownerCatId);
      if ('error' in resolved) {
        reply.status(400);
        return resolved.error;
      }
      resolvedOwnerCatId = createCatId(resolved.ok);
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: deps.freshnessGate,
      registry: deps.registry,
      record,
      route: 'create-task',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return freshness.response;

    const created = await taskStore.create({
      threadId: actor.threadId,
      title,
      why: why ?? '',
      createdBy: actor.catId,
      kind: 'work',
      subjectKey: null,
      ownerCatId: resolvedOwnerCatId,
      userId: actor.userId,
    });
    const task =
      threadStore && messageStore
        ? (
            await ensureTaskDiscussionThread(
              created,
              { taskStore, threadStore, messageStore, socketManager },
              { userId: actor.userId, broadcastUpdate: false },
            )
          ).task
        : created;

    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);
    reply.status(201);
    return { status: 'ok', task };
  });

  app.get('/api/callbacks/list-tasks', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = listTasksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { threadId, catId, status, kind } = parsed.data;

    if (catId && !catRegistry.has(catId)) {
      reply.status(400);
      return { error: `Unknown catId: ${catId}` };
    }

    let scopedThreadIds: string[] = [];
    if (threadId) {
      const scoped = await resolveScopedThreadId(actor, threadId, {
        threadStore,
        threadStoreMissingError: 'Thread store not configured for cross-thread task query',
        accessDeniedError: 'Thread access denied',
      });
      if (!scoped.ok) {
        reply.status(scoped.statusCode);
        return { error: scoped.error };
      }
      scopedThreadIds = [scoped.threadId];
    } else if (threadStore) {
      const userThreads = await threadStore.list(actor.userId);
      scopedThreadIds = userThreads.map((item) => item.id);
    } else {
      app.log.warn(
        { userId: actor.userId, invocationId: actor.invocationId },
        '[callbacks/list-tasks] threadStore unavailable, falling back to current thread only',
      );
      scopedThreadIds = [actor.threadId];
    }

    const perThreadTasks = await Promise.all(scopedThreadIds.map((id) => taskStore.listByThread(id)));
    let tasks = perThreadTasks.flat();
    if (catId) tasks = tasks.filter((item) => item.ownerCatId === catId);
    if (status) tasks = tasks.filter((item) => item.status === status);
    if (kind) tasks = tasks.filter((item) => item.kind === kind);
    tasks.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || b.id.localeCompare(a.id));

    return { tasks };
  });

  // 症状四修复：轻量活动心跳
  // 猫可以在不建任务的情况下告知面板「我还在活动」
  // 面板可据此区分「无任务」和「无活动」
  app.post('/api/callbacks/activity-heartbeat', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const schema = z.object({
      summary: z.string().max(200).optional(),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const heartbeat = {
      catId: actor.catId,
      threadId: actor.threadId,
      userId: actor.userId,
      summary: parsed.data.summary ?? null,
      timestamp: Date.now(),
    };

    // 广播到 thread room 和 user room，让面板实时更新
    socketManager.broadcastToRoom(`thread:${actor.threadId}`, 'cat_activity_heartbeat', heartbeat);
    if (actor.userId) {
      socketManager.emitToUser(actor.userId, 'cat_activity_heartbeat', heartbeat);
    }

    return { status: 'ok', heartbeat };
  });
}
