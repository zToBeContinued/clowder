/**
 * 债务1(2026-08-13 立案): 队列条目消费泄漏 + 推进无兜底 — QueueProcessor 周期看守
 *
 * 事故还原(thread_msofdas4ijjjp16k, 2026-08-13 05:07):
 * - 调用 2d033f73 被 InvocationTracker TTL 释放(active=0),但其队列条目
 *   5a95b10f 永远停在 processing——条目消费只存在于 executeEntry 的 finally,
 *   provider 流不结束 finally 就不跑,出现"第三态"。
 * - 后续条目 6535c2d1 无人推进(队列推进纯事件驱动),停摆 15 分钟直到人工
 *   POST queue/next。
 *
 * 看守契约:
 * - AC-W1: 孤儿 processing 条目(≥STALE_PROCESSING_THRESHOLD_MS 且 tracker 无
 *   活跃调用、slot 互斥已释放)→ 周期看守消费之,不允许第三态。
 * - AC-W2: 新鲜 processing 条目不受影响(误杀防御)。
 * - AC-W3: tracker 仍有活跃调用时,过期 processing 条目保留(真在跑)。
 * - AC-W4: 某 thread 有 queued 条目且无任何活跃调用 → 自动推进(0 活跃+有排队)。
 * - AC-W5: thread 忙(fresh slot / tracker 活跃)或 paused 时不推进。
 * - AC-W6: 事故端到端——孤儿条目 + 排队条目同 thread:先收尸再推进。
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

const T0 = 1_000_000;
const STALE_MS = InvocationQueue.STALE_PROCESSING_THRESHOLD_MS; // 10min

function stubDeps(overrides = {}) {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'msg-stub' })),
      getById: mock.fn(async () => null),
      markDelivered: mock.fn(async () => null),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

function enqueueA2A(queue, { threadId = 't1', userId = 'u1', catId = 'opus', content = '交接棒' } = {}) {
  const result = queue.enqueue({
    threadId,
    userId,
    content,
    source: 'agent',
    sourceCategory: 'a2a',
    targetCats: [catId],
    intent: 'execute',
    autoExecute: true,
    callerCatId: 'codex',
  });
  assert.equal(result.outcome, 'enqueued');
  return result.entry;
}

function enqueueUser(queue, { threadId = 't1', userId = 'u1', catId = 'opus', content = 'hello' } = {}) {
  const result = queue.enqueue({
    threadId,
    userId,
    content,
    source: 'user',
    targetCats: [catId],
    intent: 'execute',
  });
  assert.equal(result.outcome, 'enqueued');
  return result.entry;
}

function findEntry(queue, threadId, userId, entryId) {
  return queue.list(threadId, userId).find((entry) => entry.id === entryId);
}

async function waitFor(predicate, { rounds = 50 } = {}) {
  for (let i = 0; i < rounds; i++) {
    if (predicate()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

describe('QueueProcessor 周期看守(债务1)', () => {
  // ── AC-W1: 孤儿 processing 条目收尸 ──

  it('consumes orphaned stale processing entry when tracker has no active invocation', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    const entry = enqueueA2A(deps.queue);
    assert.ok(deps.queue.markProcessingById('t1', entry.id), 'entry should enter processing');

    t.mock.timers.tick(STALE_MS + 1);
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    await processor.runQueueWatchdogTick();

    assert.equal(findEntry(deps.queue, 't1', 'u1', entry.id), undefined, 'orphaned processing entry must be consumed');
    const diagWarn = deps.log.warn.mock.calls.some((call) => String(call.arguments[1]).includes('[DIAG/watchdog]'));
    assert.ok(diagWarn, 'watchdog must leave a [DIAG] trace when consuming an orphan');
    const emitted = deps.socketManager.emitToUser.mock.calls.some(
      (call) => call.arguments[1] === 'queue_updated' && call.arguments[2]?.action === 'completed',
    );
    assert.ok(emitted, 'queue_updated must be emitted after orphan consumption');
  });

  // ── AC-W2: 新鲜 processing 条目不误杀 ──

  it('leaves fresh processing entry untouched', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    const entry = enqueueA2A(deps.queue);
    deps.queue.markProcessingById('t1', entry.id);

    t.mock.timers.tick(STALE_MS - 1000);
    await processor.runQueueWatchdogTick();

    assert.ok(findEntry(deps.queue, 't1', 'u1', entry.id), 'fresh processing entry must survive the watchdog');
  });

  // ── AC-W3: tracker 活跃时保留(真在跑) ──

  it('keeps stale processing entry while tracker still has an active invocation for the cat', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    const entry = enqueueA2A(deps.queue);
    deps.queue.markProcessingById('t1', entry.id);

    t.mock.timers.tick(STALE_MS + 1);
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    await processor.runQueueWatchdogTick();

    assert.ok(findEntry(deps.queue, 't1', 'u1', entry.id), 'genuinely running invocation must not lose its entry');
  });

  // ── AC-W4: 0 活跃 + 有排队 → 自动推进 ──

  it('advances queued user entry when no invocation is active (stall recovery)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    const entry = enqueueUser(deps.queue);
    assert.equal(findEntry(deps.queue, 't1', 'u1', entry.id)?.status, 'queued');

    await processor.runQueueWatchdogTick();

    const after = findEntry(deps.queue, 't1', 'u1', entry.id);
    assert.notEqual(after?.status, 'queued', 'stalled queued entry must be picked up by the watchdog');
    const routed = await waitFor(() => deps.router.routeExecution.mock.callCount() > 0);
    assert.ok(routed, 'advance must reach route execution');
  });

  it('advances queued A2A autoExecute entry when no invocation is active (incident 6535c2d1)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    const entry = enqueueA2A(deps.queue);
    await processor.runQueueWatchdogTick();

    const after = findEntry(deps.queue, 't1', 'u1', entry.id);
    assert.notEqual(after?.status, 'queued', 'stalled A2A entry must be picked up by the watchdog');
  });

  // ── AC-W5: 忙/暂停时不抢跑 ──

  it('does not advance when a fresh processingSlot marks the thread busy', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    const entry = enqueueUser(deps.queue);
    /** @type {any} */ (processor).processingSlots.set('t1:opus', Date.now());

    await processor.runQueueWatchdogTick();

    assert.equal(findEntry(deps.queue, 't1', 'u1', entry.id)?.status, 'queued', 'busy thread must not be advanced');
  });

  it('does not advance when tracker reports an active invocation for the thread', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    const entry = enqueueUser(deps.queue);
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    await processor.runQueueWatchdogTick();

    assert.equal(findEntry(deps.queue, 't1', 'u1', entry.id)?.status, 'queued', 'active thread must not be advanced');
  });

  it('does not advance a paused slot (pause auto-recovery owns it)', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    const entry = enqueueUser(deps.queue);
    /** @type {any} */ (processor).pausedSlots.set('t1:opus', 'failed');

    await processor.runQueueWatchdogTick();

    assert.equal(findEntry(deps.queue, 't1', 'u1', entry.id)?.status, 'queued', 'paused thread must not be advanced');
  });

  // ── AC-W6: 事故端到端——先收尸再推进 ──

  it('incident replay: consumes orphaned entry then advances the queued successor', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    // 5a95b10f: A2A 条目进入 processing 后其调用被 tracker 释放,收口未消费
    const orphan = enqueueA2A(deps.queue, { content: '5a95b10f 交接棒' });
    deps.queue.markProcessingById('t1', orphan.id);
    // 6535c2d1: 后续排队条目,同猫
    t.mock.timers.tick(STALE_MS + 1);
    const successor = enqueueA2A(deps.queue, { content: '6535c2d1 交接棒' });

    deps.invocationTracker.has.mock.mockImplementation(() => false);
    await processor.runQueueWatchdogTick();

    assert.equal(findEntry(deps.queue, 't1', 'u1', orphan.id), undefined, 'orphan must be consumed first');
    const after = findEntry(deps.queue, 't1', 'u1', successor.id);
    assert.notEqual(after?.status, 'queued', 'successor must be dispatched in the same tick');
  });

  // ── 看守生命周期 ──

  it('startQueueWatchdog is idempotent and dispose stops the timer', () => {
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    processor.startQueueWatchdog();
    const timer = /** @type {any} */ (processor).queueWatchdogTimer;
    assert.ok(timer, 'watchdog timer must be armed');
    processor.startQueueWatchdog();
    assert.equal(/** @type {any} */ (processor).queueWatchdogTimer, timer, 'second start must not re-arm');

    processor.dispose();
    assert.equal(/** @type {any} */ (processor).queueWatchdogTimer, undefined, 'dispose must clear the watchdog');
  });

  it('watchdog tick never throws even when a thread inspection fails', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps);

    enqueueUser(deps.queue);
    deps.invocationTracker.has.mock.mockImplementation(() => {
      throw new Error('tracker exploded');
    });

    await assert.doesNotReject(processor.runQueueWatchdogTick(), 'a broken thread must not break the whole tick');
  });
});

describe('InvocationQueue 看守配套枚举(债务1)', () => {
  it('listThreadIdsWithEntries returns unique thread ids across scopes', () => {
    const queue = new InvocationQueue();
    enqueueUser(queue, { threadId: 't1', userId: 'u1' });
    enqueueUser(queue, { threadId: 't1', userId: 'u2' });
    enqueueA2A(queue, { threadId: 't2', userId: 'u1' });

    assert.deepEqual(queue.listThreadIdsWithEntries().sort(), ['t1', 't2']);
  });

  it('listStaleProcessingAcrossUsers only returns processing entries beyond the stale threshold', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const queue = new InvocationQueue();
    const stale = enqueueUser(queue, { threadId: 't1', userId: 'u1' });
    queue.markProcessingById('t1', stale.id);

    t.mock.timers.tick(STALE_MS + 1);
    const fresh = enqueueUser(queue, { threadId: 't1', userId: 'u2' });
    queue.markProcessingById('t1', fresh.id);
    const queued = enqueueUser(queue, { threadId: 't1', userId: 'u2', content: 'queued' });

    const staleList = queue.listStaleProcessingAcrossUsers('t1');
    assert.deepEqual(
      staleList.map((entry) => entry.id),
      [stale.id],
      'only the stale processing entry qualifies',
    );
    assert.ok(queued.id, 'queued entry must never appear in stale processing list');
  });
});
