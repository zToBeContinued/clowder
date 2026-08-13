import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createUsageService(catId, text = 'hello') {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield {
        type: 'done',
        catId,
        timestamp: Date.now(),
        metadata: {
          provider: 'unit-test',
          model: 'unit-test-model',
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      };
    },
  };
}

function createCompactBoundaryService(catId, text = 'continued') {
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'compact_boundary', catId, preTokens: 42000 }),
        timestamp: Date.now(),
      };
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield {
        type: 'done',
        catId,
        timestamp: Date.now(),
        metadata: {
          provider: 'unit-test',
          model: 'unit-test-model',
          usage: { inputTokens: 100, outputTokens: 20 },
        },
      };
    },
  };
}

function createMockDeps(services) {
  let invocationSeq = 0;
  let messageSeq = 0;

  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => ({
        ...msg,
        id: `msg-${++messageSeq}`,
        threadId: msg.threadId ?? 'thread1',
        mentions: msg.mentions ?? [],
        timestamp: msg.timestamp ?? Date.now(),
      }),
      getById: async () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

function findSystemInfoPayload(messages, type) {
  for (const msg of messages) {
    if (msg.type !== 'system_info' || typeof msg.content !== 'string') continue;
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed?.type === type) return parsed;
    } catch {
      // Ignore non-JSON system info.
    }
  }
  return null;
}

function restoreEnv(name, value) {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function secretSummaryStore(threadId = 'thread1') {
  return {
    listLatestByThread: async () => [
      {
        id: 'seg-secret',
        threadId,
        fromMessageId: '0000000000000001-000001-aaaaaaaa',
        toMessageId: '0000000000000001-000001-aaaaaaaa',
        messageCount: 1,
        summary: '范围：旧消息。风险锚点：ANTHROPIC_API_KEY=sk-ant-secret-value',
        generatedAt: '2026-07-03T12:00:00.000Z',
        modelId: 'cheap-summary-model',
        promptVersion: 'history-v1',
      },
    ],
  };
}

function validSummaryStore(threadId = 'thread1') {
  return {
    listLatestByThread: async () => [
      {
        id: 'seg-ok',
        threadId,
        fromMessageId: '0000000000000001-000001-aaaaaaaa',
        toMessageId: '0000000000000001-000001-aaaaaaaa',
        messageCount: 1,
        summary:
          '范围：旧消息。当前状态：正常接手。已确认决策/约束：保留 degraded。下一步：继续验证。风险锚点：compact boundary。',
        generatedAt: '2026-07-03T12:00:00.000Z',
        modelId: 'cheap-summary-model',
        promptVersion: 'history-v1',
      },
    ],
  };
}

function withIncrementalHistory(deps, currentUserMessageId = '0000000000000002-000001-bbbbbbbb') {
  deps.deliveryCursorStore = {
    getCursor: async () => undefined,
    ackCursor: async () => {},
  };
  deps.messageStore.getByThreadAfter = async (threadId, _afterId, _limit, userId) => [
    {
      id: '0000000000000001-000001-aaaaaaaa',
      threadId,
      userId,
      catId: null,
      content: '旧消息',
      mentions: [],
      timestamp: Date.now() - 2000,
    },
    {
      id: currentUserMessageId,
      threadId,
      userId,
      catId: null,
      content: '当前用户消息',
      mentions: [],
      timestamp: Date.now() - 1000,
    },
  ];
  return currentUserMessageId;
}

function withObservationFailureThenIncrementalHistory(deps, currentUserMessageId = '0000000000000002-000001-bbbbbbbb') {
  deps.deliveryCursorStore = {
    getCursor: async () => undefined,
    ackCursor: async () => {},
  };
  let reads = 0;
  deps.messageStore.getByThreadAfter = async (threadId, _afterId, _limit, userId) => {
    reads += 1;
    if (reads === 1) {
      throw new Error('full history unavailable');
    }
    return [
      {
        id: '0000000000000001-000001-aaaaaaaa',
        threadId,
        userId,
        catId: null,
        content: '旧消息',
        mentions: [],
        timestamp: Date.now() - 2000,
      },
      {
        id: currentUserMessageId,
        threadId,
        userId,
        catId: null,
        content: '当前用户消息',
        mentions: [],
        timestamp: Date.now() - 1000,
      },
    ];
  };
  return currentUserMessageId;
}

describe('history governance observation', () => {
  it('keeps observe-only fields absent and does not read full history when the flag is off', async () => {
    const previousObserve = process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    const previousMode = process.env.CAT_CAFE_HISTORY_GOVERNANCE;
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE;

    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const deps = createMockDeps({ opus: createUsageService('opus', 'ack') });
      let fullHistoryReads = 0;
      deps.messageStore.getByThreadAfter = async () => {
        fullHistoryReads += 1;
        return [];
      };

      const messages = [];
      for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1')) {
        messages.push(msg);
      }

      assert.equal(fullHistoryReads, 0, 'flag-off route must not scan full thread history');
      const created = findSystemInfoPayload(messages, 'invocation_created');
      assert.ok(created?.contextBudget, 'invocation_created should include contextBudget');
      assert.equal(created.contextBudget.historyMode, undefined);
      assert.equal(created.contextBudget.historyFullTokens, undefined);

      const usage = findSystemInfoPayload(messages, 'invocation_usage');
      assert.ok(usage?.usage, 'done metadata should emit invocation_usage');
      assert.equal(usage.usage.historyMode, undefined);
      assert.equal(usage.usage.historyFullTokens, undefined);
    } finally {
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE', previousObserve);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE', previousMode);
    }
  });

  it('reads full thread history in observe mode and surfaces non-zero budget ratio on real route events', async () => {
    const previousObserve = process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    const previousMode = process.env.CAT_CAFE_HISTORY_GOVERNANCE;
    process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE = '1';
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE;

    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const deps = createMockDeps({ opus: createUsageService('opus', 'ack') });
      const readCalls = [];
      deps.messageStore.getByThreadAfter = async (threadId, afterId, limit, userId) => {
        readCalls.push({ threadId, afterId, limit, userId });
        return [
          {
            id: 'm1',
            threadId,
            userId,
            catId: null,
            content: '用户历史消息'.repeat(30),
            mentions: [],
            timestamp: Date.now() - 2000,
          },
          {
            id: 'm2',
            threadId,
            userId,
            catId: 'opus',
            content: '助手历史回复'.repeat(30),
            mentions: [],
            timestamp: Date.now() - 1000,
          },
        ];
      };

      const messages = [];
      for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1')) {
        messages.push(msg);
      }

      assert.equal(readCalls.length, 1, 'observe mode should read full history once per route');
      assert.deepEqual(readCalls[0], {
        threadId: 'thread1',
        afterId: undefined,
        limit: undefined,
        userId: 'user1',
      });

      const created = findSystemInfoPayload(messages, 'invocation_created');
      const budget = created?.contextBudget;
      assert.equal(budget?.historyMode, 'observe');
      assert.ok(budget.historyFullTokens > 0, 'full history token estimate should be non-zero');
      assert.ok(budget.historyBudgetRatio > 0, 'historyBudgetRatio should show history share');
      assert.equal(budget.historyGovernanceDegraded, false);
      assert.equal(budget.historyMessages, 0, 'observe-only must not change included prompt history');

      const usage = findSystemInfoPayload(messages, 'invocation_usage');
      assert.equal(usage?.usage?.historyMode, 'observe');
      assert.equal(usage.usage.historyFullTokens, budget.historyFullTokens);
      assert.equal(usage.usage.historyBudgetRatio, budget.historyBudgetRatio);
      assert.equal(usage.usage.historyGovernanceDegraded, false);
    } finally {
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE', previousObserve);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE', previousMode);
    }
  });

  it('serial route surfaces degraded summary quality without observe history fields', async () => {
    const previousSummary = process.env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY;
    const previousObserve = process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    const previousMode = process.env.CAT_CAFE_HISTORY_GOVERNANCE;
    process.env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY = '1';
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE;

    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const deps = createMockDeps({ opus: createUsageService('opus', 'ack') });
      const currentUserMessageId = withIncrementalHistory(deps);
      deps.threadHistorySummaryStore = secretSummaryStore();

      const messages = [];
      for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { currentUserMessageId })) {
        messages.push(msg);
      }

      const created = findSystemInfoPayload(messages, 'invocation_created');
      assert.equal(created?.contextBudget?.historyMode, undefined);
      assert.equal(created.contextBudget.historyGovernanceDegraded, true);

      const usage = findSystemInfoPayload(messages, 'invocation_usage');
      assert.equal(usage?.usage?.historyMode, undefined);
      assert.equal(usage.usage.historyGovernanceDegraded, true);
    } finally {
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY', previousSummary);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE', previousObserve);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE', previousMode);
    }
  });

  it('parallel route surfaces degraded summary quality without observe history fields', async () => {
    const previousSummary = process.env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY;
    const previousObserve = process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    const previousMode = process.env.CAT_CAFE_HISTORY_GOVERNANCE;
    process.env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY = '1';
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE;

    try {
      const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
      const deps = createMockDeps({ opus: createUsageService('opus', 'ack') });
      const currentUserMessageId = withIncrementalHistory(deps);
      deps.threadHistorySummaryStore = secretSummaryStore();

      const messages = [];
      for await (const msg of routeParallel(deps, ['opus'], 'test', 'user1', 'thread1', { currentUserMessageId })) {
        messages.push(msg);
      }

      const created = findSystemInfoPayload(messages, 'invocation_created');
      assert.equal(created?.contextBudget?.historyMode, undefined);
      assert.equal(created.contextBudget.historyGovernanceDegraded, true);

      const usage = findSystemInfoPayload(messages, 'invocation_usage');
      assert.equal(usage?.usage?.historyMode, undefined);
      assert.equal(usage.usage.historyGovernanceDegraded, true);
    } finally {
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY', previousSummary);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE', previousObserve);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE', previousMode);
    }
  });

  it('serial route preserves observation degraded when incremental summary gate is not degraded', async () => {
    const previousSummary = process.env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY;
    const previousObserve = process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    const previousMode = process.env.CAT_CAFE_HISTORY_GOVERNANCE;
    process.env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY = '1';
    process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE = '1';
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE;

    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const deps = createMockDeps({ opus: createUsageService('opus', 'ack') });
      const currentUserMessageId = withObservationFailureThenIncrementalHistory(deps);
      deps.threadHistorySummaryStore = validSummaryStore();

      const messages = [];
      for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { currentUserMessageId })) {
        messages.push(msg);
      }

      const created = findSystemInfoPayload(messages, 'invocation_created');
      assert.equal(created?.contextBudget?.historyMode, 'observe');
      assert.equal(created.contextBudget.historyGovernanceDegraded, true);

      const usage = findSystemInfoPayload(messages, 'invocation_usage');
      assert.equal(usage?.usage?.historyMode, 'observe');
      assert.equal(usage.usage.historyGovernanceDegraded, true);
    } finally {
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY', previousSummary);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE', previousObserve);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE', previousMode);
    }
  });

  it('parallel route preserves observation degraded when incremental summary gate is not degraded', async () => {
    const previousSummary = process.env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY;
    const previousObserve = process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE;
    const previousMode = process.env.CAT_CAFE_HISTORY_GOVERNANCE;
    process.env.CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY = '1';
    process.env.CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE = '1';
    delete process.env.CAT_CAFE_HISTORY_GOVERNANCE;

    try {
      const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
      const deps = createMockDeps({ opus: createUsageService('opus', 'ack') });
      const currentUserMessageId = withObservationFailureThenIncrementalHistory(deps);
      deps.threadHistorySummaryStore = validSummaryStore();

      const messages = [];
      for await (const msg of routeParallel(deps, ['opus'], 'test', 'user1', 'thread1', { currentUserMessageId })) {
        messages.push(msg);
      }

      const created = findSystemInfoPayload(messages, 'invocation_created');
      assert.equal(created?.contextBudget?.historyMode, 'observe');
      assert.equal(created.contextBudget.historyGovernanceDegraded, true);

      const usage = findSystemInfoPayload(messages, 'invocation_usage');
      assert.equal(usage?.usage?.historyMode, 'observe');
      assert.equal(usage.usage.historyGovernanceDegraded, true);
    } finally {
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY', previousSummary);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE', previousObserve);
      restoreEnv('CAT_CAFE_HISTORY_GOVERNANCE', previousMode);
    }
  });

  it('serial route records provider compact boundary as a task debug event', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const taskStore = new TaskStore();
    const deps = createMockDeps({ opus: createCompactBoundaryService('opus') });
    deps.taskStore = taskStore;
    deps.invocationDeps.taskStore = taskStore;
    const currentUserMessageId = '0000000000000005-000001-compacta';
    const task = taskStore.create({
      threadId: 'thread1',
      title: 'Compact boundary handoff',
      why: 'B4 provider compact visibility',
      createdBy: 'user',
      sourceMessageId: currentUserMessageId,
    });

    const messages = [];
    for await (const msg of routeSerial(deps, ['opus'], 'test', 'user1', 'thread1', { currentUserMessageId })) {
      messages.push(msg);
    }

    const updated = taskStore.get(task.id);
    const compactEvent = updated.events.find((event) => event.type === 'compact_boundary');

    assert.ok(compactEvent);
    assert.equal(compactEvent.catId, 'opus');
    assert.equal(compactEvent.invocationId, 'inv-1');
    assert.equal(compactEvent.data.boundary, 'compact_boundary');
    assert.equal(compactEvent.data.source, 'provider');
    assert.equal(compactEvent.data.preTokens, 42000);
    assert.ok(messages.some((msg) => msg.type === 'text' && msg.content === 'continued'));
  });

  it('parallel route records provider compact boundary as a task debug event', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const taskStore = new TaskStore();
    const deps = createMockDeps({ opus: createCompactBoundaryService('opus') });
    deps.taskStore = taskStore;
    deps.invocationDeps.taskStore = taskStore;
    const currentUserMessageId = '0000000000000006-000001-compactb';
    const task = taskStore.create({
      threadId: 'thread1',
      title: 'Compact boundary handoff',
      why: 'B4 provider compact visibility',
      createdBy: 'user',
      sourceMessageId: currentUserMessageId,
    });

    const messages = [];
    for await (const msg of routeParallel(deps, ['opus'], 'test', 'user1', 'thread1', { currentUserMessageId })) {
      messages.push(msg);
    }

    const updated = taskStore.get(task.id);
    const compactEvent = updated.events.find((event) => event.type === 'compact_boundary');

    assert.ok(compactEvent);
    assert.equal(compactEvent.catId, 'opus');
    assert.equal(compactEvent.invocationId, 'inv-1');
    assert.equal(compactEvent.data.boundary, 'compact_boundary');
    assert.equal(compactEvent.data.source, 'provider');
    assert.equal(compactEvent.data.preTokens, 42000);
    assert.ok(messages.some((msg) => msg.type === 'text' && msg.content === 'continued'));
  });
});
