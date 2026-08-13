import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const NOW = 1_780_000_000_000;

function makeInvocation(overrides = {}) {
  return {
    id: 'inv-1',
    threadId: 'thread-1',
    userId: 'alice',
    userMessageId: 'msg-user',
    targetCats: ['codex'],
    intent: 'execute',
    status: 'succeeded',
    phase: 'done',
    idempotencyKey: 'idem-1',
    createdAt: NOW,
    updatedAt: NOW + 2_000,
    usageByCat: {
      codex: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
        costUsd: 0.0123,
        deliveryOnlyMode: 'degraded',
        deliveryOnlyDegradedIssue: 'missing_summary',
      },
    },
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    id: 'msg-assistant',
    threadId: 'thread-1',
    userId: 'alice',
    catId: 'codex',
    content: '正文不应该出现在 Run Ledger 响应里',
    mentions: [],
    timestamp: NOW + 1_000,
    extra: { stream: { invocationId: 'inv-1' } },
    toolEvents: [],
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: null,
    title: 'Fix something',
    ownerCatId: 'codex',
    status: 'done',
    why: 'test',
    createdBy: 'user',
    createdAt: NOW,
    updatedAt: NOW + 2_000,
    sourceMessageId: 'msg-user',
    events: [
      {
        ts: new Date(NOW + 1_500).toISOString(),
        catId: 'codex',
        type: 'usage',
        data: {
          provider: 'openai',
          inputTokens: 100,
          outputTokens: 20,
          deliveryOnlyMode: 'degraded',
          deliveryOnlyDegradedIssue: 'missing_summary',
        },
      },
    ],
    ...overrides,
  };
}

function makeInvocationStore(records, withScanAll = true) {
  return {
    create: () => ({ outcome: 'created', invocationId: 'unused' }),
    get: async (id) => records.find((record) => record.id === id) ?? null,
    update: async () => null,
    getByIdempotencyKey: async () => null,
    ...(withScanAll ? { scanAll: async () => records } : {}),
  };
}

function makeMessageStore(messages) {
  return {
    append: async () => messages[0],
    getById: async (id) => messages.find((message) => message.id === id) ?? null,
    getByThread: async (threadId) => messages.filter((message) => message.threadId === threadId),
    update: async () => null,
    deleteThread: async () => 0,
    scanAll: async () => messages,
  };
}

function makeTaskStore(tasks) {
  return {
    create: async () => tasks[0],
    get: async (id) => tasks.find((task) => task.id === id) ?? null,
    update: async () => null,
    listByThread: async (threadId) => tasks.filter((task) => task.threadId === threadId),
    delete: async () => false,
    deleteByThread: async () => 0,
    getBySubject: async () => null,
    upsertBySubject: async () => tasks[0],
    listByKind: async (kind) => tasks.filter((task) => task.kind === kind),
    patchAutomationState: async () => null,
  };
}

async function buildApp({ records, messages, tasks = [], traceStore = null, withScanAll = true }) {
  const { default: Fastify } = await import('fastify');
  const { runLedgerRoutes } = await import('../dist/routes/run-ledger.js');
  const app = Fastify();
  await app.register(runLedgerRoutes, {
    invocationRecordStore: makeInvocationStore(records, withScanAll),
    messageStore: makeMessageStore(messages),
    taskStore: makeTaskStore(tasks),
    traceStore,
  });
  await app.ready();
  return app;
}

describe('run ledger route', () => {
  test('returns a succeeded invocation timeline without leaking message content', async () => {
    const records = [makeInvocation()];
    const messages = [
      makeMessage({
        id: 'msg-user',
        catId: null,
        content: '用户原文不应该泄漏',
        extra: undefined,
        timestamp: NOW - 10,
      }),
      makeMessage({
        toolEvents: [
          {
            id: 'tool-1',
            type: 'tool_use',
            label: 'shell',
            detail: 'Bearer very-secret-token',
            timestamp: NOW + 900,
          },
        ],
      }),
    ];
    const app = await buildApp({ records, messages, traceStore: { query: () => [] } });

    const res = await app.inject({ method: 'GET', url: '/api/run-ledger/inv-1' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.events.map((event) => event.type),
      ['created', 'queued', 'runtime_starting', 'tool_started', 'first_token', 'message_persisted', 'succeeded'],
    );
    assert.equal(body.summary.status, 'succeeded');
    assert.equal(body.summary.assistantMessageId, 'msg-assistant');
    assert.equal(body.sources.messages, 2);
    assert.equal(body.sources.trace, false);
    assert.match(body.degraded.reason, /trace/);
    assert.equal(body.summary.usage.inputTokens, 100);
    assert.equal(body.summary.usage.deliveryOnlyMode, 'degraded');
    assert.equal(body.summary.usage.deliveryOnlyDegradedIssue, 'missing_summary');

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('正文不应该'), false);
    assert.equal(serialized.includes('用户原文'), false);
    assert.equal(serialized.includes('very-secret-token'), false);
    assert.equal(serialized.includes('Bearer <redacted>'), true);

    await app.close();
  });

  test('returns a failed invocation with sanitized failure details and degraded trace source', async () => {
    const records = [
      makeInvocation({
        id: 'inv-failed',
        status: 'failed',
        phase: 'done',
        error: 'runtime spawn failed sk_agent_supersecret',
      }),
    ];
    const app = await buildApp({ records, messages: [], traceStore: { query: () => [] } });

    const res = await app.inject({ method: 'GET', url: '/api/run-ledger/inv-failed' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.summary.failureClass, 'runtime_spawn_failed');
    assert.equal(body.events.at(-1).type, 'failed');
    assert.equal(JSON.stringify(body).includes('sk_agent_supersecret'), false);
    assert.equal(JSON.stringify(body).includes('sk_agent_<redacted>'), true);
    assert.deepEqual(body.degraded.missingSources, ['trace', 'assistant_message']);

    await app.close();
  });

  test('classifies permission cancellation as a tool failure instead of a user cancellation', async () => {
    const records = [
      makeInvocation({
        id: 'inv-permission-cancelled',
        status: 'failed',
        phase: 'done',
        error: 'permission_cancelled: Grok 终端工具权限未获批准',
      }),
    ];
    const app = await buildApp({ records, messages: [], traceStore: { query: () => [] } });

    const res = await app.inject({ method: 'GET', url: '/api/run-ledger/inv-permission-cancelled' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.summary.status, 'failed');
    assert.equal(body.summary.failureClass, 'tool_failed');
    assert.equal(body.events.at(-1).data.failureClass, 'tool_failed');

    await app.close();
  });

  test('surfaces compact boundary task events without leaking raw control data', async () => {
    const records = [
      makeInvocation({
        id: 'inv-compact',
        updatedAt: NOW + 2_100,
      }),
    ];
    const messages = [
      makeMessage({ id: 'msg-user', catId: null, content: 'continue after compact', extra: undefined }),
    ];
    const tasks = [
      makeTask({
        events: [
          {
            ts: new Date(NOW + 1_400).toISOString(),
            catId: 'codex',
            invocationId: 'inv-compact',
            type: 'usage',
            data: {
              deliveryOnlyMode: 'degraded',
              deliveryOnlyDegradedIssue: 'missing_summary',
            },
          },
          {
            ts: new Date(NOW + 1_500).toISOString(),
            catId: 'codex',
            invocationId: 'inv-compact',
            type: 'compact_boundary',
            data: {
              boundary: 'compact_boundary',
              source: 'provider',
              preTokens: 42000,
              sessionId: 'sess-sk_agent_supersecret',
            },
          },
        ],
      }),
    ];
    const app = await buildApp({ records, messages, tasks, traceStore: { query: () => [] } });

    const res = await app.inject({ method: 'GET', url: '/api/run-ledger/inv-compact' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const compactEvent = body.events.find((event) => event.type === 'compact_boundary');
    const usageEvent = body.events.find((event) => event.type === 'usage_recorded');

    assert.ok(compactEvent);
    assert.ok(usageEvent);
    assert.equal(usageEvent.data.deliveryOnlyMode, 'degraded');
    assert.equal(usageEvent.data.deliveryOnlyDegradedIssue, 'missing_summary');
    assert.equal(compactEvent.actor, 'codex');
    assert.equal(compactEvent.data.boundary, 'compact_boundary');
    assert.equal(compactEvent.data.source, 'provider');
    assert.equal(compactEvent.data.preTokens, 42000);
    assert.equal(compactEvent.data.sessionId, 'sess-sk_agent_<redacted>');
    assert.equal(res.body.includes('sk_agent_supersecret'), false);

    await app.close();
  });

  test('lists task-bound run ledgers by associated source message', async () => {
    const records = [makeInvocation(), makeInvocation({ id: 'inv-other', userMessageId: 'other-message' })];
    const messages = [makeMessage({ id: 'msg-user', catId: null, extra: undefined }), makeMessage()];
    const tasks = [makeTask()];
    const app = await buildApp({ records, messages, tasks, traceStore: { query: () => [] } });

    const res = await app.inject({ method: 'GET', url: '/api/tasks/task-1/run-ledgers' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.taskId, 'task-1');
    assert.equal(body.count, 1);
    assert.equal(body.ledgers[0].invocationId, 'inv-1');
    assert.equal(body.ledgers[0].taskId, 'task-1');
    assert.equal(body.ledgers[0].usage.deliveryOnlyMode, 'degraded');
    assert.equal(body.ledgers[0].usage.deliveryOnlyDegradedIssue, 'missing_summary');

    await app.close();
  });

  test('thread list requires scanAll support', async () => {
    const app = await buildApp({
      records: [makeInvocation()],
      messages: [],
      withScanAll: false,
    });

    const res = await app.inject({ method: 'GET', url: '/api/run-ledger?threadId=thread-1' });
    assert.equal(res.statusCode, 501);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'INVOCATION_SCAN_UNAVAILABLE');

    await app.close();
  });
});
