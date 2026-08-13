import type { FastifyRequest } from 'fastify';
import type { AuditEventInput } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { resolveUserId } from './request-identity.js';

export type DangerousActionSeverity = 'medium' | 'high' | 'critical';
export type DangerousActionResult = 'attempted' | 'succeeded' | 'failed' | 'blocked';
export type DangerousActionConfirmation =
  | 'not_required'
  | 'ui_confirmed'
  | 'header_confirmed'
  | 'existing_confirm_field';

export const DANGEROUS_ACTION_CONFIRMATION_HEADER = 'x-clowder-dangerous-action-confirmed';

export interface DangerousActionConfirmationCheck {
  ok: boolean;
  confirmation: DangerousActionConfirmation;
  error?: string;
  code?: 'DANGEROUS_ACTION_CONFIRMATION_REQUIRED';
}

export interface DangerousActionAuditInput {
  request?: FastifyRequest;
  actorId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  threadId?: string;
  severity: DangerousActionSeverity;
  result: DangerousActionResult;
  confirmation: DangerousActionConfirmation;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export function getDangerousActionActor(request: FastifyRequest, fallback = 'unknown'): string {
  return resolveUserId(request, {}) ?? fallback;
}

function normalizeConfirmationValue(value: unknown): string | null {
  if (Array.isArray(value)) return normalizeConfirmationValue(value[0]);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBodyConfirmation(request: FastifyRequest, action: string): DangerousActionConfirmation | null {
  const body = request.body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const raw = record.dangerousActionConfirmed ?? record.confirmDangerousAction;
  if (raw === true || raw === action || raw === 'true' || raw === 'ui_confirmed') return 'ui_confirmed';
  return null;
}

export function readDangerousActionConfirmation(
  request: FastifyRequest,
  action: string,
): DangerousActionConfirmation | null {
  const headerValue = normalizeConfirmationValue(request.headers[DANGEROUS_ACTION_CONFIRMATION_HEADER]);
  if (headerValue === 'true' || headerValue === 'ui_confirmed' || headerValue === action) {
    return 'ui_confirmed';
  }
  if (headerValue === 'header_confirmed') return 'header_confirmed';
  return readBodyConfirmation(request, action);
}

export function requireDangerousActionConfirmation(
  request: FastifyRequest,
  action: string,
  label = '危险操作',
): DangerousActionConfirmationCheck {
  const confirmation = readDangerousActionConfirmation(request, action);
  if (confirmation) return { ok: true, confirmation };
  // Phase 2 MVP targets browser/UI flows. Non-browser callers remain backward-compatible
  // but are still audited by the route as not_required unless they opt in via header/body.
  if (!request.headers.origin) return { ok: true, confirmation: 'not_required' };
  return {
    ok: false,
    confirmation: 'not_required',
    code: 'DANGEROUS_ACTION_CONFIRMATION_REQUIRED',
    error: `${label}需要前端二次确认`,
  };
}

export async function auditDangerousAction(input: DangerousActionAuditInput): Promise<void> {
  const actorId = input.actorId ?? (input.request ? getDangerousActionActor(input.request) : 'unknown');
  const event: AuditEventInput = {
    type: AuditEventTypes.DANGEROUS_ACTION,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    data: {
      actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      severity: input.severity,
      result: input.result,
      confirmation: input.confirmation,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  };

  await getEventAuditLog().append(event);
}

export async function auditDangerousActionBestEffort(input: DangerousActionAuditInput): Promise<void> {
  try {
    await auditDangerousAction(input);
  } catch {
    // 审计失败不应扩大事故面；调用方仍按原业务结果返回。
  }
}
