import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('requireDangerousActionConfirmation accepts explicit UI confirmation header', async () => {
  const { requireDangerousActionConfirmation } = await import('../dist/utils/dangerous-action-guard.js');
  const result = requireDangerousActionConfirmation(
    {
      headers: { 'x-clowder-dangerous-action-confirmed': 'queue.clear' },
      body: undefined,
    },
    'queue.clear',
    '清空队列',
  );

  assert.deepEqual(result, { ok: true, confirmation: 'ui_confirmed' });
});

test('requireDangerousActionConfirmation blocks when confirmation is missing', async () => {
  const { requireDangerousActionConfirmation } = await import('../dist/utils/dangerous-action-guard.js');
  const result = requireDangerousActionConfirmation(
    { headers: { origin: 'http://localhost:3003' }, body: undefined },
    'thread.soft_delete',
    '删除频道',
  );

  assert.equal(result.ok, false);
  assert.equal(result.confirmation, 'not_required');
  assert.equal(result.code, 'DANGEROUS_ACTION_CONFIRMATION_REQUIRED');
});

test('auditDangerousAction writes a traceable dangerous_action audit event', async () => {
  const auditDir = join(tmpdir(), `dangerous-action-audit-${randomUUID()}`);
  const previousAuditDir = process.env.AUDIT_LOG_DIR;
  process.env.AUDIT_LOG_DIR = auditDir;

  try {
    const { auditDangerousAction } = await import('../dist/utils/dangerous-action-guard.js');
    const { AuditEventTypes, getEventAuditLog } = await import(
      '../dist/domains/cats/services/orchestration/EventAuditLog.js'
    );

    await auditDangerousAction({
      actorId: 'alice',
      action: 'message.hard_delete',
      targetType: 'message',
      targetId: 'msg-1',
      threadId: 'thread-1',
      severity: 'high',
      result: 'succeeded',
      confirmation: 'existing_confirm_field',
      metadata: { confirmTitleProvided: true },
    });

    const events = await getEventAuditLog().readByType(AuditEventTypes.DANGEROUS_ACTION, { days: 1 });
    assert.equal(events.length, 1);
    assert.equal(events[0].threadId, 'thread-1');
    assert.deepEqual(events[0].data, {
      actorId: 'alice',
      action: 'message.hard_delete',
      targetType: 'message',
      targetId: 'msg-1',
      severity: 'high',
      result: 'succeeded',
      confirmation: 'existing_confirm_field',
      metadata: { confirmTitleProvided: true },
    });
  } finally {
    if (previousAuditDir === undefined) delete process.env.AUDIT_LOG_DIR;
    else process.env.AUDIT_LOG_DIR = previousAuditDir;
    await rm(auditDir, { recursive: true, force: true });
  }
});
