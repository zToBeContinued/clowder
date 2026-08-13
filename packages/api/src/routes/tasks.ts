/**
 * Task CRUD Routes (毛线球)
 *
 * POST   /api/tasks         → 创建任务 (201)
 * GET    /api/tasks?threadId → 列出线程任务
 * GET    /api/tasks/:id     → 获取单个 / 404
 * PATCH  /api/tasks/:id     → 更新状态/标题/owner
 * DELETE /api/tasks/:id     → 删除 (204)
 */

import type { CatId, ConnectorSource, CreateTaskInput, TaskEvent, TaskItem, UpdateTaskInput } from '@cat-cafe/shared';
import { catIdSchema, validateStatusTransition } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveUserId } from '../utils/request-identity.js';
import { ensureTaskDiscussionThread } from './task-discussion-thread.js';

export interface TasksRoutesOptions {
  taskStore: ITaskStore;
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
}

const VALID_STATUSES = ['todo', 'doing', 'in_review', 'blocked', 'done', 'failed'] as const;
const VALID_FAILURE_CLASSES = [
  'agent_error',
  'build_failed',
  'test_failed',
  'timeout',
  'budget_exhausted',
  'infra_error',
  'manual_fail',
] as const;
type TaskSystemNoticeEventType =
  | 'task_created'
  | 'task_claimed'
  | 'task_unclaimed'
  | 'task_status_changed'
  | 'task_completed'
  | 'task_capability_authorized';

/** createdBy accepts any registered catId OR 'user' */
const createdBySchema = z.union([catIdSchema(), z.literal('user')]);

const evidenceSchema = z
  .object({
    tests: z.string().max(2000).optional(),
    build: z.string().max(2000).optional(),
    screenshot: z.string().max(2000).optional(),
    review: z.string().max(2000).optional(),
    lesson: z.string().max(2000).optional(),
    updatedAt: z.number().optional(),
  })
  .optional();

const createSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1).max(200),
  why: z.string().max(1000).default(''),
  createdBy: createdBySchema,
  userId: z.string().min(1).max(100).optional(),
  ownerCatId: catIdSchema().nullable().optional(),
  sourceMessageId: z.string().optional(),
  sourceSummaryId: z.string().optional(),
  taskThreadId: z.string().optional(),
  evidence: evidenceSchema,
  parentTaskId: z.string().optional(),
  retryOf: z.string().optional(),
  branchOf: z.string().optional(),
});

const updateSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    ownerCatId: catIdSchema().nullable().optional(),
    status: z.enum(VALID_STATUSES).optional(),
    failureClass: z.enum(VALID_FAILURE_CLASSES).optional(),
    failureReason: z.string().max(2000).optional(),
    why: z.string().max(1000).optional(),
    sourceMessageId: z.string().optional(),
    taskThreadId: z.string().optional(),
    evidence: evidenceSchema,
    parentTaskId: z.string().optional(),
    retryOf: z.string().optional(),
    branchOf: z.string().optional(),
    eventCatId: z.string().min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

/** Build CreateTaskInput from zod output (bridges string→CatId branded types) */
function toCreateInput(data: z.infer<typeof createSchema>): CreateTaskInput {
  const input: CreateTaskInput = {
    threadId: data.threadId,
    title: data.title,
    why: data.why,
    createdBy: data.createdBy as CatId | 'user',
  };
  if (data.ownerCatId != null) {
    input.ownerCatId = data.ownerCatId as CatId;
  }
  if (data.userId) input.userId = data.userId;
  if (data.sourceMessageId) input.sourceMessageId = data.sourceMessageId;
  if (data.sourceSummaryId) input.sourceSummaryId = data.sourceSummaryId;
  if (data.taskThreadId) input.taskThreadId = data.taskThreadId;
  if (data.evidence !== undefined) input.evidence = { ...data.evidence, updatedAt: Date.now() };
  if (data.parentTaskId) input.parentTaskId = data.parentTaskId;
  if (data.retryOf) input.retryOf = data.retryOf;
  if (data.branchOf) input.branchOf = data.branchOf;
  return input;
}

/** Build UpdateTaskInput from zod output (filters undefined, bridges branded types) */
function toUpdateInput(data: z.infer<typeof updateSchema>): UpdateTaskInput {
  const input: UpdateTaskInput = {};
  if (data.title !== undefined) input.title = data.title;
  if (data.status !== undefined) input.status = data.status;
  if (data.failureClass !== undefined) input.failureClass = data.failureClass;
  if (data.failureReason !== undefined) input.failureReason = data.failureReason;
  if (data.why !== undefined) input.why = data.why;
  if (data.sourceMessageId !== undefined) input.sourceMessageId = data.sourceMessageId;
  if (data.taskThreadId !== undefined) input.taskThreadId = data.taskThreadId;
  if (data.ownerCatId !== undefined) input.ownerCatId = data.ownerCatId as CatId | null;
  if (data.evidence !== undefined) input.evidence = { ...data.evidence, updatedAt: Date.now() };
  if (data.parentTaskId !== undefined) input.parentTaskId = data.parentTaskId;
  if (data.retryOf !== undefined) input.retryOf = data.retryOf;
  if (data.branchOf !== undefined) input.branchOf = data.branchOf;
  if (data.eventCatId !== undefined) input.eventCatId = data.eventCatId;
  return input;
}

const taskEventSchema = z.object({
  ts: z.string().datetime().optional(),
  catId: z.string().min(1),
  type: z.enum([
    'claimed',
    'unclaimed',
    'status_changed',
    'completed',
    'failed',
    'handoff',
    'artifact',
    'usage',
    'capability_authorized',
    'capability_usage',
    'tool_usage',
    'compact_boundary',
    'fast_lane_decision',
    'fast_lane_started',
    'fast_lane_completed',
    'fast_lane_failed',
  ]),
  invocationId: z.string().min(1).optional(),
  data: z.record(z.unknown()).optional(),
});

const capabilityTypeSchema = z.enum(['mcp', 'skill', 'limb']);

const capabilityAuthorizationSchema = z.object({
  capabilityId: z.string().min(1).max(120),
  capabilityType: capabilityTypeSchema.default('mcp'),
  reason: z.string().max(500).optional(),
  expiresAt: z.number().int().positive().optional(),
});

const capabilityUsageSchema = z.object({
  capabilityId: z.string().min(1).max(120),
  capabilityType: capabilityTypeSchema.default('mcp'),
  toolName: z.string().min(1).max(120).optional(),
  status: z.enum(['started', 'succeeded', 'failed']).default('succeeded'),
  durationMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  summary: z.string().max(500).optional(),
});

const taskThreadSchema = z.object({
  userId: z.string().min(1).max(100).optional(),
});

function shouldEmitTaskAttention(previous: TaskItem | null, current: TaskItem): boolean {
  if (current.kind === 'pr_tracking') return false;
  if (!current.userId) return false;
  if (previous?.status === current.status) return false;
  return current.status === 'in_review' || current.status === 'blocked' || current.status === 'failed';
}

function emitTaskAttention(socketManager: SocketManager, previous: TaskItem | null, current: TaskItem): void {
  if (!shouldEmitTaskAttention(previous, current) || !current.userId) return;
  socketManager.emitToUser(current.userId, 'task_attention', current);
}

export const tasksRoutes: FastifyPluginAsync<TasksRoutesOptions> = async (app, opts) => {
  const { taskStore, threadStore, messageStore, socketManager } = opts;

  const taskSystemNoticeSource = (
    eventType: TaskSystemNoticeEventType,
    tone: 'info' | 'success' | 'warning' = 'info',
  ): ConnectorSource => ({
    connector: 'task-system',
    label: 'Task',
    icon: '📋',
    meta: { presentation: 'system_notice', noticeTone: tone, eventType },
  });

  const taskStatusLabel = (status: TaskItem['status']): string => {
    switch (status) {
      case 'todo':
        return '待办';
      case 'doing':
        return '进行中';
      case 'in_review':
        return '待验收';
      case 'done':
        return '已完成';
      case 'blocked':
        return '阻塞';
      case 'failed':
        return '失败';
      default:
        return status;
    }
  };

  async function getTaskInThread(threadId: string, taskId: string): Promise<TaskItem | null> {
    const task = await taskStore.get(taskId);
    if (!task || task.threadId !== threadId) return null;
    return task;
  }

  async function buildLineage(task: TaskItem): Promise<TaskItem[]> {
    const lineage: TaskItem[] = [];
    const visited = new Set<string>([task.id]);
    let cursor: TaskItem | null = task;
    for (let depth = 0; depth < 20; depth += 1) {
      const nextId = cursor.parentTaskId ?? cursor.retryOf ?? cursor.branchOf;
      if (!nextId || visited.has(nextId)) break;
      visited.add(nextId);
      const next = await taskStore.get(nextId);
      if (!next) break;
      lineage.push(next);
      cursor = next;
    }
    return lineage;
  }

  async function getTaskLabel(task: TaskItem): Promise<string> {
    const tasks = (await taskStore.listByThread(task.threadId)).filter((item) => item.kind !== 'pr_tracking');
    const index = tasks.findIndex((item) => item.id === task.id);
    return index >= 0 ? `task #${index + 1}` : 'task';
  }

  async function appendTaskSystemNotice(
    task: TaskItem,
    content: string,
    eventType: TaskSystemNoticeEventType,
    tone: 'info' | 'success' | 'warning' = 'info',
  ): Promise<void> {
    if (!messageStore) return;
    try {
      const source = taskSystemNoticeSource(eventType, tone);
      const stored = await messageStore.append({
        userId: 'system',
        catId: null,
        content,
        mentions: [],
        timestamp: Date.now(),
        threadId: task.threadId,
        source,
      });
      socketManager.broadcastToRoom(`thread:${task.threadId}`, 'connector_message', {
        threadId: task.threadId,
        message: {
          id: stored.id,
          type: 'connector',
          content: stored.content,
          source,
          timestamp: stored.timestamp,
        },
      });
    } catch (err) {
      app.log.warn({ err, taskId: task.id }, '[tasks] failed to append task system notice');
    }
  }

  async function appendTaskCreateNotice(task: TaskItem, options: { fromSourceMessage?: boolean } = {}): Promise<void> {
    const label = await getTaskLabel(task);
    const verb = options.fromSourceMessage ? '已从消息创建' : '已创建';
    await appendTaskSystemNotice(task, `${verb} ${label}：${task.title}`, 'task_created');
  }

  async function appendTaskUpdateNotices(previous: TaskItem | null, current: TaskItem): Promise<void> {
    if (!previous) return;
    const label = await getTaskLabel(current);

    if (previous.ownerCatId !== current.ownerCatId) {
      if (current.ownerCatId) {
        await appendTaskSystemNotice(current, `${label} 已由 ${current.ownerCatId} 认领。`, 'task_claimed');
      } else if (previous.ownerCatId) {
        await appendTaskSystemNotice(current, `${label} 已取消认领。`, 'task_unclaimed');
      }
    }

    if (previous.status !== current.status) {
      if (current.status === 'done') {
        await appendTaskSystemNotice(current, `${label} 已完成：${current.title}`, 'task_completed', 'success');
      } else if (current.status === 'blocked' || current.status === 'failed') {
        await appendTaskSystemNotice(
          current,
          `${label} 状态：${taskStatusLabel(previous.status)} → ${taskStatusLabel(current.status)}。`,
          'task_status_changed',
          'warning',
        );
      } else {
        await appendTaskSystemNotice(
          current,
          `${label} 状态：${taskStatusLabel(previous.status)} → ${taskStatusLabel(current.status)}。`,
          'task_status_changed',
        );
      }
    }
  }

  async function getTaskOr404(taskId: string, reply: import('fastify').FastifyReply): Promise<TaskItem | null> {
    const task = await taskStore.get(taskId);
    if (!task) {
      reply.status(404);
      return null;
    }
    return task;
  }

  function requireUserId(
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
  ): string | null {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return null;
    }
    return userId;
  }

  // POST /api/tasks
  app.post('/api/tasks', async (request, reply) => {
    const result = createSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const created = await taskStore.create(toCreateInput(result.data));
    const task =
      created.kind === 'work'
        ? (
            await ensureTaskDiscussionThread(
              created,
              { taskStore, threadStore, messageStore, socketManager },
              { userId: result.data.userId, broadcastUpdate: false },
            )
          ).task
        : created;
    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_created', task);
    await appendTaskCreateNotice(task, { fromSourceMessage: Boolean(result.data.sourceMessageId) });

    reply.status(201);
    return task;
  });

  // GET /api/tasks?threadId=xxx[&kind=work|pr_tracking]
  // GET /api/tasks?scope=all[&kind=work|pr_tracking][&status=in_review]
  app.get('/api/tasks', async (request, reply) => {
    const { threadId, kind, scope, status } = request.query as {
      threadId?: string;
      kind?: string;
      scope?: string;
      status?: string;
    };
    if (scope === 'all') {
      const taskKind = kind === 'pr_tracking' ? 'pr_tracking' : 'work';
      let tasks = await taskStore.listByKind(taskKind);
      if (status) tasks = tasks.filter((t) => t.status === status);
      return { tasks };
    }

    if (!threadId) {
      reply.status(400);
      return { error: 'Missing threadId query parameter' };
    }

    let tasks = await taskStore.listByThread(threadId);
    if (kind) tasks = tasks.filter((t) => t.kind === kind);
    if (status) tasks = tasks.filter((t) => t.status === status);
    return { tasks };
  });

  // GET /api/tasks/:id
  app.get('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const task = await taskStore.get(id);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    return task;
  });

  // GET /api/threads/:threadId/tasks/:taskId — 获取线程内任务详情（含 lineage 字段）
  app.get('/api/threads/:threadId/tasks/:taskId', async (request, reply) => {
    const { threadId, taskId } = request.params as { threadId: string; taskId: string };
    const task = await getTaskInThread(threadId, taskId);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    return task;
  });

  // GET /api/threads/:threadId/tasks/:taskId/events — 查询任务事件账本
  app.get('/api/threads/:threadId/tasks/:taskId/events', async (request, reply) => {
    const { threadId, taskId } = request.params as { threadId: string; taskId: string };
    const { type } = request.query as { type?: TaskEvent['type'] };
    const task = await getTaskInThread(threadId, taskId);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    const events = task.events ?? [];
    return { events: type ? events.filter((event) => event.type === type) : events };
  });

  // POST /api/threads/:threadId/tasks/:taskId/events — 手动追加事件（审计/迁移兜底）
  app.post('/api/threads/:threadId/tasks/:taskId/events', async (request, reply) => {
    const { threadId, taskId } = request.params as { threadId: string; taskId: string };
    const task = await getTaskInThread(threadId, taskId);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    const parsed = taskEventSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const event: TaskEvent = {
      ts: parsed.data.ts ?? new Date().toISOString(),
      catId: parsed.data.catId,
      type: parsed.data.type,
      ...(parsed.data.data ? { data: parsed.data.data } : {}),
    };
    const updated = await taskStore.update(task.id, { events: [event] });
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to append task event' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    reply.status(201);
    return { events: updated.events ?? [] };
  });

  // POST /api/tasks/:id/capability-authorizations — task-scoped external tool authorization.
  app.post('/api/tasks/:id/capability-authorizations', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return { error: 'Identity required' };

    const { id } = request.params as { id: string };
    const task = await getTaskOr404(id, reply);
    if (!task) return { error: 'Task not found' };

    const parsed = capabilityAuthorizationSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const event: TaskEvent = {
      ts: new Date().toISOString(),
      catId: 'user',
      type: 'capability_authorized',
      data: {
        capabilityId: parsed.data.capabilityId,
        capabilityType: parsed.data.capabilityType,
        authorizedBy: userId,
        authorizedAt: Date.now(),
        ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        ...(parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : {}),
      },
    };
    const updated = await taskStore.update(task.id, { events: [event] });
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to authorize capability' };
    }
    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    const label = await getTaskLabel(updated);
    await appendTaskSystemNotice(
      updated,
      `${label} 已授权外部工具 ${parsed.data.capabilityId} 仅用于本任务。`,
      'task_capability_authorized',
    );
    return { task: updated, authorization: event };
  });

  // POST /api/tasks/:id/capability-usage — usage/audit callback for task-scoped tools.
  app.post('/api/tasks/:id/capability-usage', async (request, reply) => {
    const userId = requireUserId(request, reply);
    if (!userId) return { error: 'Identity required' };

    const { id } = request.params as { id: string };
    const task = await getTaskOr404(id, reply);
    if (!task) return { error: 'Task not found' };

    const parsed = capabilityUsageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const event: TaskEvent = {
      ts: new Date().toISOString(),
      catId: 'system',
      type: 'capability_usage',
      data: {
        capabilityId: parsed.data.capabilityId,
        capabilityType: parsed.data.capabilityType,
        recordedBy: userId,
        status: parsed.data.status,
        ...(parsed.data.toolName ? { toolName: parsed.data.toolName } : {}),
        ...(parsed.data.durationMs != null ? { durationMs: parsed.data.durationMs } : {}),
        ...(parsed.data.costUsd != null ? { costUsd: parsed.data.costUsd } : {}),
        ...(parsed.data.summary ? { summary: parsed.data.summary } : {}),
      },
    };
    const updated = await taskStore.update(task.id, { events: [event] });
    if (!updated) {
      reply.status(500);
      return { error: 'Failed to record capability usage' };
    }
    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    return { task: updated, usage: event };
  });

  // GET /api/threads/:threadId/tasks/:taskId/lineage — 返回父链/重试/分支关联
  app.get('/api/threads/:threadId/tasks/:taskId/lineage', async (request, reply) => {
    const { threadId, taskId } = request.params as { threadId: string; taskId: string };
    const task = await getTaskInThread(threadId, taskId);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    return {
      task,
      lineage: await buildLineage(task),
    };
  });

  // POST /api/tasks/:id/thread — ensure and return the task discussion thread.
  app.post('/api/tasks/:id/thread', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = taskThreadSchema.safeParse(request.body ?? {});
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }

    const task = await taskStore.get(id);
    if (!task) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    return ensureTaskDiscussionThread(
      task,
      { taskStore, threadStore, messageStore, socketManager },
      { userId: body.data.userId },
    );
  });

  // PATCH /api/tasks/:id
  app.patch('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const previous = await taskStore.get(id);
    if (!previous) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    // 状态机验证
    if (result.data.status && previous.status) {
      const transition = validateStatusTransition(previous.status, result.data.status);
      if (!transition.valid) {
        reply.status(409);
        return {
          error: 'Invalid status transition',
          reason: transition.reason,
          currentStatus: previous.status,
          requestedStatus: result.data.status,
        };
      }
    }

    const updateInput = toUpdateInput(result.data);
    // Deep-merge evidence: partial evidence updates (e.g. adding only `tests`)
    // must NOT wipe previously-recorded fields (e.g. `review`). Delivery evidence
    // is filled incrementally, so overwrite-whole would silently drop 交付证据.
    if (updateInput.evidence && previous.evidence) {
      updateInput.evidence = { ...previous.evidence, ...updateInput.evidence };
    }
    const updated = await taskStore.update(id, updateInput);
    if (!updated) {
      reply.status(404);
      return { error: 'Task not found' };
    }

    socketManager.broadcastToRoom(`thread:${updated.threadId}`, 'task_updated', updated);
    emitTaskAttention(socketManager, previous, updated);
    await appendTaskUpdateNotices(previous, updated);

    return updated;
  });

  // DELETE /api/tasks/:id
  app.delete('/api/tasks/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    // Capture threadId before delete so the UI can drop the card in real time
    // (previously DELETE emitted nothing, so lists/badges kept a stale entry).
    const existing = await taskStore.get(id);
    const deleted = await taskStore.delete(id);
    if (!deleted) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    if (existing) {
      socketManager.broadcastToRoom(`thread:${existing.threadId}`, 'task_deleted', {
        id,
        threadId: existing.threadId,
      });
    }
    reply.status(204);
  });
};
