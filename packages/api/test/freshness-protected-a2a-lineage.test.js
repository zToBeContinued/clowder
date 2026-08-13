import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { selectRouteFreshnessGate } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

function createProcessorDeps(queue, routeExecution) {
  return {
    queue,
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: `inv-${crypto.randomUUID()}` })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution,
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: `msg-${crypto.randomUUID()}` })),
      getById: mock.fn(async () => null),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

describe('Freshness protected A2A lineage', () => {
  test('forces a non-allowlisted child route through the protected gate without upgrading a legacy route', () => {
    const protectedGate = { marker: 'protected' };
    const gate = {
      isEnabledFor(_threadId, catId) {
        return catId === 'opus';
      },
      forProtectedRoute() {
        return protectedGate;
      },
    };

    assert.equal(selectRouteFreshnessGate(gate, 'thread-a', ['gemini'], true), protectedGate);
    assert.equal(selectRouteFreshnessGate(gate, 'thread-a', ['gemini']), undefined);
  });

  test('callback enqueue preserves protected lineage on the A2A QueueEntry', async () => {
    const queue = new InvocationQueue();

    const result = await enqueueA2ATargets(
      {
        router: {},
        invocationRecordStore: {},
        socketManager: { emitToUser() {} },
        invocationQueue: queue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['gemini'],
        content: '@gemini 继续处理',
        userId: 'user-a',
        threadId: 'thread-a',
        triggerMessage: {
          id: 'msg-parent',
          threadId: 'thread-a',
          userId: 'user-a',
          catId: 'opus',
          content: '@gemini 继续处理',
          mentions: ['gemini'],
          timestamp: Date.now(),
        },
        callerCatId: 'opus',
        freshnessProtected: true,
      },
    );

    assert.deepEqual(result.enqueued, ['gemini']);
    assert.equal(queue.list('thread-a', 'user-a')[0]?.freshnessProtected, true);
  });

  test('QueueProcessor keeps protected lineage across a queued parent and its non-allowlisted A2A child', async () => {
    const queue = new InvocationQueue();
    const routeCalls = [];
    const deps = createProcessorDeps(
      queue,
      mock.fn(async function* (_userId, _content, threadId, _messageId, targetCats, _intent, options) {
        routeCalls.push({ targetCat: targetCats[0], freshnessProtected: options.freshnessProtected });
        if (targetCats[0] === 'opus') {
          await options.enqueueA2ATargets({
            threadId,
            userId: 'user-a',
            callerCatId: 'opus',
            targetCats: ['gemini'],
            content: '@gemini 继续处理',
            triggerMessageId: 'msg-opus-output',
            freshnessProtected: options.freshnessProtected,
          });
        }
        yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
      }),
    );
    const processor = new QueueProcessor(deps);
    const root = queue.enqueue({
      threadId: 'thread-a',
      userId: 'user-a',
      content: '开始处理',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'codex',
      freshnessProtected: true,
    });
    assert.equal(root.outcome, 'enqueued');

    await processor.tryAutoExecute('thread-a');
    await waitFor(
      () => routeCalls.some((call) => call.targetCat === 'gemini'),
      `expected queued child execution, got ${JSON.stringify(routeCalls)}`,
    );

    assert.deepEqual(routeCalls, [
      { targetCat: 'opus', freshnessProtected: true },
      { targetCat: 'gemini', freshnessProtected: true },
    ]);
  });
});
