/**
 * Audit Route
 * GET /api/audit/thread/:threadId — 返回指定 thread 的审计事件
 *
 * 安全:
 * - logPath 绝对路径仅在 EXPOSE_LOG_PATH=true 或 NODE_ENV!=production 时返回
 *   (铲屎官需要 VSCode 跳转; 生产部署应关闭以避免路径泄露)
 * - 通过 resolveUserId 解析身份 (header > query fallback)
 * - 校验 userId 与 thread.createdBy 一致 (ownership guard)
 */

import type { FastifyPluginAsync } from 'fastify';
import {
  type AuditEvent,
  AuditEventTypes,
  type EventAuditLog,
  getEventAuditLog,
} from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface AuditRoutesOptions {
  threadStore: IThreadStore;
  auditLog?: EventAuditLog;
}

export const auditRoutes: FastifyPluginAsync<AuditRoutesOptions> = async (app, opts) => {
  const { threadStore } = opts;
  const auditLog = opts.auditLog ?? getEventAuditLog();

  app.get<{
    Querystring: {
      date?: string;
      days?: string;
      action?: string;
      result?: string;
      limit?: string;
    };
  }>('/api/audit/dangerous-actions', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const date = typeof request.query.date === 'string' ? request.query.date.trim() : '';
    const action = typeof request.query.action === 'string' ? request.query.action.trim() : '';
    const result = typeof request.query.result === 'string' ? request.query.result.trim() : '';
    const days = clampInt(request.query.days, 7, 1, 30);
    const limit = clampInt(request.query.limit, 200, 1, 500);

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      reply.status(400);
      return { error: 'date must be YYYY-MM-DD' };
    }

    const sourceEvents = date ? await auditLog.readByDate(date) : await readRecentAuditEvents(auditLog, days);
    const filtered = sourceEvents
      .filter((event) => event.type === AuditEventTypes.DANGEROUS_ACTION)
      .filter((event) => !action || String(event.data['action'] ?? '') === action)
      .filter((event) => !result || String(event.data['result'] ?? '') === result)
      .sort((a, b) => b.timestamp - a.timestamp);

    const actions = uniqueSorted(
      sourceEvents
        .filter((event) => event.type === AuditEventTypes.DANGEROUS_ACTION)
        .map((event) => String(event.data['action'] ?? ''))
        .filter(Boolean),
    );
    const results = uniqueSorted(
      sourceEvents
        .filter((event) => event.type === AuditEventTypes.DANGEROUS_ACTION)
        .map((event) => String(event.data['result'] ?? ''))
        .filter(Boolean),
    );

    return {
      events: filtered.slice(0, limit),
      total: filtered.length,
      actions,
      results,
      files: await auditLog.listFiles(),
      query: {
        date: date || null,
        days: date ? null : days,
        action: action || null,
        result: result || null,
        limit,
      },
    };
  });

  app.get<{ Params: { threadId: string } }>('/api/audit/thread/:threadId', async (request, reply) => {
    const { threadId } = request.params;
    const userId = resolveUserId(request);

    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (thread.createdBy !== userId && (!ownerId || userId !== ownerId)) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const events = await auditLog.readByThread(threadId, { days: 7 });
    const logFiles = await auditLog.listFiles();

    // logPath 仅在开发环境或显式开关下暴露 (避免生产路径泄露)
    const env = process.env;
    const exposePath = env.EXPOSE_LOG_PATH === 'true' || env.NODE_ENV !== 'production';
    const logPath = exposePath ? auditLog.getLogPath() : null;

    return { events, logPath, logFiles };
  });
};

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function readRecentAuditEvents(auditLog: EventAuditLog, days: number): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    events.push(...(await auditLog.readByDate(date)));
  }
  return events;
}
