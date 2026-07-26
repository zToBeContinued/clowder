import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { completeCapsuleForSeal, buildCapsuleFromRouteState } = await import(
  '../dist/domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js'
);

/**
 * Wait until the recorded task has at least `count` events.
 * Fast-lane terminal events land after a real child-process spawn, so a fixed sleep is
 * flaky on slower machines.
 */
async function waitForTaskEvents(updatedTasks, count, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((updatedTasks.at(-1)?.events.length ?? 0) >= count) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${count} task events, got ${updatedTasks.at(-1)?.events.length ?? 0}`);
}

/** Build a stub deps object for QueueProcessor */
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
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
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
      getByThreadAfter: mock.fn(async () => []),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

/** Helper: enqueue an entry and return it */
function enqueueEntry(queue, overrides = {}) {
  const result = queue.enqueue({
    threadId: 't1',
    userId: 'u1',
    content: 'hello',
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
  return result.entry;
}

async function waitForCondition(predicate, timeoutMs = 5000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('QueueProcessor', () => {
  let deps;
  let processor;

  beforeEach(() => {
    process.env.CAT_CAFE_AGENT_OUTPUT_GATE = '0';
    delete process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY;
    delete process.env.CAT_CAFE_CODEX_OUTPUT_GATE;
    deps = stubDeps();
    processor = new QueueProcessor(deps);
  });

  // ── onInvocationComplete ──

  it('succeeded + queue has entries → auto-dequeues and starts execution', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    // Should have started execution (invocationTracker.start called)
    assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0);
    // Entry should be marked processing then removed
    // Wait a tick for background execution
    await new Promise((r) => setTimeout(r, 50));
  });

  it('succeeded + stale user queued entry → auto-dequeues and starts execution', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'user' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length > 0,
      'stale user queued entry is still pending work and should be dispatched on completion',
    );
  });

  it('succeeded + stale connector queued entry → auto-dequeues and starts execution', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'connector' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-connector-1');
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length > 0,
      'stale connector queued entry is still pending work and should be dispatched on completion',
    );
  });

  it('succeeded + empty queue → no action', async () => {
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0);
  });

  it('canceled → pauses queue, emits queue_paused', async () => {
    enqueueEntry(deps.queue);

    await processor.onInvocationComplete('t1', 'opus', 'canceled');

    // Should NOT start new execution
    assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0);
    // Should emit queue_paused
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    assert.ok(emitCalls.length > 0);
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.ok(pausedCall, 'should emit queue_paused');
    assert.equal(pausedCall.arguments[2].reason, 'canceled');
  });

  it('failed + stale user queued entry → pauses queue instead of treating it as empty', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'user' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    await processor.onInvocationComplete('t1', 'opus', 'failed');

    assert.equal(processor.isPaused('t1', 'opus'), true, 'stale user work should still keep the slot paused');
    const pausedCall = deps.socketManager.emitToUser.mock.calls.find((c) => c.arguments[1] === 'queue_paused');
    assert.ok(pausedCall, 'should emit queue_paused for stale user work');
    assert.equal(pausedCall.arguments[2].reason, 'failed');
  });

  it('canceled + stale connector queued entry → pauses queue instead of treating it as empty', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'connector' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-connector-1');
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    await processor.onInvocationComplete('t1', 'opus', 'canceled');

    assert.equal(processor.isPaused('t1', 'opus'), true, 'stale connector work should still keep the slot paused');
    const pausedCall = deps.socketManager.emitToUser.mock.calls.find((c) => c.arguments[1] === 'queue_paused');
    assert.ok(pausedCall, 'should emit queue_paused for stale connector work');
    assert.equal(pausedCall.arguments[2].reason, 'canceled');
  });

  it('failed + stale user queued entry → #595 auto-recovery starts dispatch after pause delay', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const entry = enqueueEntry(deps.queue, { source: 'user' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    await processor.onInvocationComplete('t1', 'opus', 'failed');
    assert.equal(processor.isPaused('t1', 'opus'), true);

    t.mock.timers.tick(10_000);

    assert.equal(deps.queue.list('t1', 'u1')[0].status, 'processing');
    assert.equal(processor.isPaused('t1', 'opus'), false);
  });

  it('isThreadBusy treats stale queued user work as busy until it is dispatched or cleared', () => {
    enqueueEntry(deps.queue, { source: 'user' });
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    assert.equal(deps.queue.hasQueuedForThread('t1'), false, 'freshness gate should ignore stale user work');
    assert.equal(processor.isThreadBusy('t1'), true, 'delivery-batch-done must not close while stale work is pending');
  });

  it('canceled_by_user → auto-dequeues and does not emit queue_paused', async () => {
    deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'resume after cancel',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user');
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0, 'user cancel should auto-resume queued work');
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.equal(pausedCall, undefined, 'user cancel should not pause the queue');
  });

  it('canceled with processing-only queue → does not emit queue_paused', async () => {
    enqueueEntry(deps.queue);
    // Simulate steer immediate: queued entry is promoted to processing before the canceled cleanup runs.
    deps.queue.markProcessing('t1', 'u1');

    await processor.onInvocationComplete('t1', 'opus', 'canceled');

    assert.equal(processor.isPaused('t1'), false);
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.equal(pausedCall, undefined);
  });

  it('user cancel during queued execution stops broadcasting late agent events', async () => {
    let controller;
    deps.invocationTracker.startAll.mock.mockImplementation(() => {
      controller = new AbortController();
      return controller;
    });
    deps.router.routeExecution = mock.fn(async function* () {
      yield { type: 'text', catId: 'opus', content: 'before cancel', timestamp: Date.now() };
      controller.abort('user_cancel');
      yield { type: 'text', catId: 'opus', content: 'after cancel', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
    });

    enqueueEntry(deps.queue);

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const broadcasts = deps.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
    assert.ok(
      broadcasts.some((msg) => msg.type === 'text' && msg.content === 'before cancel'),
      'pre-cancel text should be broadcast',
    );
    assert.equal(
      broadcasts.some((msg) => msg.type === 'text' && msg.content === 'after cancel'),
      false,
      'post-cancel text must not be broadcast',
    );
    assert.equal(
      broadcasts.some((msg) => msg.type === 'done' && msg.catId === 'opus'),
      false,
      'post-cancel done from the stale producer must not be broadcast',
    );

    const canceledUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[1]?.status === 'canceled',
    );
    assert.ok(canceledUpdate, 'aborted queued invocation should be recorded as canceled');
  });

  it('failed → pauses queue, emits queue_paused', async () => {
    enqueueEntry(deps.queue);

    await processor.onInvocationComplete('t1', 'opus', 'failed');

    assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0);
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.ok(pausedCall);
    assert.equal(pausedCall.arguments[2].reason, 'failed');
  });

  // ── processNext ──

  it('processNext starts next entry when paused', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    assert.ok(result.entry);
  });

  it('queued execution broadcasts intent_mode with invocationId when processing starts', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['codex'], intent: 'execute' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 50));

    const intentCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.ok(intentCall, 'should broadcast intent_mode for queued execution');
    assert.deepEqual(intentCall.arguments[2], {
      threadId: 't1',
      mode: 'execute',
      targetCats: ['codex'],
      invocationId: 'inv-stub',
    });
  });

  it('preserves silent window-primer presentation after connector work is queued', async () => {
    deps.router.routeExecution = mock.fn(async function* () {
      yield {
        type: 'text',
        catId: 'codex',
        content: 'Codex 窗口已激活，当前时间 10:30。',
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    });
    const entry = enqueueEntry(deps.queue, {
      source: 'connector',
      sourceCategory: 'scheduled',
      responsePresentation: 'silent_receipt',
      targetCats: ['codex'],
      content: 'window-primer: warm the active session',
    });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-primer');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    await new Promise((r) => setTimeout(r, 50));

    const routeOptions = deps.router.routeExecution.mock.calls[0]?.arguments[6];
    assert.equal(routeOptions.responsePresentation, 'silent_receipt');
    const textBroadcast = deps.socketManager.broadcastAgentMessage.mock.calls
      .map((call) => call.arguments[0])
      .find((message) => message.type === 'text');
    assert.ok(textBroadcast, 'queued primer should still use the existing text event');
    assert.equal(textBroadcast.extra.scheduler.hiddenReceipt, true);
  });

  it('keeps ordinary queued scheduled reminders visible', async () => {
    const entry = enqueueEntry(deps.queue, {
      source: 'connector',
      sourceCategory: 'scheduled',
      targetCats: ['codex'],
      content: '提醒我提交周报',
    });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-reminder');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    await new Promise((r) => setTimeout(r, 50));

    const routeOptions = deps.router.routeExecution.mock.calls[0]?.arguments[6];
    assert.equal(routeOptions.responsePresentation, undefined);
  });

  it('does not infer silent presentation from scheduled reminder text', async () => {
    const entry = enqueueEntry(deps.queue, {
      source: 'connector',
      sourceCategory: 'scheduled',
      targetCats: ['codex'],
      content: 'window-primer: this is ordinary user-visible reminder text',
    });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-marker-reminder');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    await new Promise((r) => setTimeout(r, 50));

    const routeOptions = deps.router.routeExecution.mock.calls[0]?.arguments[6];
    assert.equal(routeOptions.responsePresentation, undefined);
  });

  it('emits queue_updated(action=completed) after entry is removed from queue', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['codex'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 50));

    const queueUpdates = deps.socketManager.emitToUser.mock.calls
      .filter((c) => c.arguments[1] === 'queue_updated')
      .map((c) => c.arguments[2]);
    const completed = queueUpdates.find((u) => u.action === 'completed');
    assert.ok(completed, 'should emit queue_updated completed after cleanup');
    assert.equal(completed.threadId, 't1');
    assert.deepEqual(completed.queue, [], 'queue snapshot should be empty after processed entry cleanup');
  });

  it('processNext returns started=false when queue empty', async () => {
    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, false);
  });

  it('CAT_CAFE_FAST_LANE disabled preserves slow lane for project-init-like messages', async () => {
    const previous = process.env.CAT_CAFE_FAST_LANE;
    delete process.env.CAT_CAFE_FAST_LANE;
    try {
      enqueueEntry(deps.queue, { content: '帮我初始化项目 wechat-cli' });

      const result = await processor.processNext('t1', 'u1');

      assert.equal(result.started, true);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'flag off must keep existing slow lane path');
      const decisionCall = deps.log.info.mock.calls.find(
        (c) => c.arguments[1] === '[QueueProcessor] fast lane decision',
      );
      assert.equal(decisionCall, undefined, 'flag off must not run fast-lane classification');
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_FAST_LANE;
      else process.env.CAT_CAFE_FAST_LANE = previous;
    }
  });

  it('CAT_CAFE_FAST_LANE=1 keeps project-init mentions on slow lane without explicit command', async () => {
    const previous = process.env.CAT_CAFE_FAST_LANE;
    process.env.CAT_CAFE_FAST_LANE = '1';
    try {
      enqueueEntry(deps.queue, { content: '帮我初始化项目 wechat-cli' });

      const result = await processor.processNext('t1', 'u1');

      assert.equal(result.started, true);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'Phase 1 must not short-circuit without executor');
      const decisionCall = deps.log.info.mock.calls.find(
        (c) => c.arguments[1] === '[QueueProcessor] fast lane decision',
      );
      assert.ok(decisionCall, 'should log fast-lane decision when flag is enabled');
      assert.equal(decisionCall.arguments[0].decision.lane, 'slow');
      assert.match(decisionCall.arguments[0].decision.reason, /without explicit/);
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_FAST_LANE;
      else process.env.CAT_CAFE_FAST_LANE = previous;
    }
  });

  it('CAT_CAFE_FAST_LANE=1 executes explicit project-init command without routeExecution', async () => {
    const previous = process.env.CAT_CAFE_FAST_LANE;
    process.env.CAT_CAFE_FAST_LANE = '1';
    const projectRoot = await mkdtemp(join(tmpdir(), 'cat-fast-lane-project-'));
    try {
      const sourceTask = {
        id: 'task-source',
        threadId: 't1',
        sourceMessageId: 'msg-task',
        events: [],
      };
      const snapshots = [
        { files: [], totalAdded: 0, totalRemoved: 0 },
        {
          files: [
            { path: '.cat-cafe/projects/wechat-cli/brief.md', added: 10, removed: 0 },
            { path: '.cat-cafe/projects/wechat-cli/progress.md', added: 10, removed: 0 },
            { path: '.cat-cafe/projects/wechat-cli/decisions.md', added: 10, removed: 0 },
            { path: '.cat-cafe/projects/wechat-cli/handoff-index.md', added: 10, removed: 0 },
            { path: '.cat-cafe/projects/wechat-cli/handoff-log.md', added: 10, removed: 0 },
          ],
          totalAdded: 50,
          totalRemoved: 0,
        },
      ];
      const updatedTasks = [];
      const fastDeps = stubDeps({
        messageStore: {
          append: mock.fn(async () => ({ id: 'msg-stub' })),
          getById: mock.fn(async () => null),
          markDelivered: mock.fn(async () => null),
        },
        gitArtifactCollector: mock.fn(async () => snapshots.shift() ?? snapshots.at(-1)),
        taskStore: {
          listByThread: mock.fn(async () => [updatedTasks.at(-1) ?? sourceTask]),
          update: mock.fn(async (_taskId, input) => {
            const previousTask = updatedTasks.at(-1) ?? sourceTask;
            const updated = {
              ...sourceTask,
              events: [...previousTask.events, ...(input.events ?? [])],
            };
            updatedTasks.push(updated);
            return updated;
          }),
        },
      });
      const fastProcessor = new QueueProcessor(fastDeps);
      const entry = enqueueEntry(fastDeps.queue, {
        content: `/project-init wechat-cli --root ${projectRoot} --creator tester`,
        targetCats: ['opus'],
      });
      fastDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-task');

      const result = await fastProcessor.processNext('t1', 'u1');
      assert.equal(result.started, true);
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(fastDeps.router.routeExecution.mock.calls.length, 0, 'fast lane must bypass routeExecution');
      assert.match(
        await readFile(join(projectRoot, '.cat-cafe', 'projects', 'wechat-cli', 'brief.md'), 'utf-8'),
        /wechat-cli/,
      );
      const eventTypes = updatedTasks.at(-1).events.map((event) => event.type);
      assert.deepEqual(eventTypes, ['fast_lane_decision', 'fast_lane_started', 'fast_lane_completed', 'artifact']);
      const completed = updatedTasks.at(-1).events.find((event) => event.type === 'fast_lane_completed');
      assert.equal(completed.data.workflowId, 'project-init');
      assert.equal(completed.data.routeExecutionBypassed, true);
      assert.equal(completed.data.tokenUsage.totalTokens, 0);
      assert.equal(completed.data.artifactCount, 5);
      const textMessage = fastDeps.socketManager.broadcastAgentMessage.mock.calls.find(
        (call) => call.arguments[0].type === 'text',
      );
      assert.match(textMessage.arguments[0].content, /project-init 快车道已完成/);
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_FAST_LANE;
      else process.env.CAT_CAFE_FAST_LANE = previous;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('CAT_CAFE_FAST_LANE=1 fails closed when the project-init script exits non-zero', async () => {
    const previous = process.env.CAT_CAFE_FAST_LANE;
    process.env.CAT_CAFE_FAST_LANE = '1';
    const projectRoot = await mkdtemp(join(tmpdir(), 'cat-fast-lane-existing-'));
    // .cat-cafe/projects as a FILE makes the script's mkdir fail after spawn. An
    // already-existing project dir is no longer a failure — the scaffold is idempotent.
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeFile(join(projectRoot, '.cat-cafe', 'projects'), 'not a directory', 'utf-8');
    try {
      const sourceTask = {
        id: 'task-source',
        threadId: 't1',
        sourceMessageId: 'msg-task',
        events: [],
      };
      const updatedTasks = [];
      const fastDeps = stubDeps({
        messageStore: {
          append: mock.fn(async () => ({ id: 'msg-stub' })),
          getById: mock.fn(async () => null),
          markDelivered: mock.fn(async () => null),
        },
        gitArtifactCollector: mock.fn(async () => ({ files: [], totalAdded: 0, totalRemoved: 0 })),
        taskStore: {
          listByThread: mock.fn(async () => [updatedTasks.at(-1) ?? sourceTask]),
          update: mock.fn(async (_taskId, input) => {
            const previousTask = updatedTasks.at(-1) ?? sourceTask;
            const updated = {
              ...sourceTask,
              events: [...previousTask.events, ...(input.events ?? [])],
            };
            updatedTasks.push(updated);
            return updated;
          }),
        },
      });
      const fastProcessor = new QueueProcessor(fastDeps);
      const entry = enqueueEntry(fastDeps.queue, {
        content: `/project-init existing --root ${projectRoot}`,
        targetCats: ['opus'],
      });
      fastDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-task');

      const result = await fastProcessor.processNext('t1', 'u1');
      assert.equal(result.started, true);
      // The terminal event lands after a real node spawn, so poll instead of sleeping a
      // fixed amount — spawn latency varies a lot across machines.
      await waitForTaskEvents(updatedTasks, 3);

      assert.equal(fastDeps.router.routeExecution.mock.calls.length, 0, 'post-spawn failure must not rerun slow lane');
      const eventTypes = updatedTasks.at(-1).events.map((event) => event.type);
      assert.deepEqual(eventTypes, ['fast_lane_decision', 'fast_lane_started', 'fast_lane_failed']);
      const failed = updatedTasks.at(-1).events.at(-1);
      assert.match(failed.data.stderr, /ENOTDIR|not a directory/i);
      const errorMessage = fastDeps.socketManager.broadcastAgentMessage.mock.calls.find(
        (call) => call.arguments[0].type === 'error',
      );
      assert.ok(errorMessage, 'a fast-lane failure must be broadcast to the user');
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_FAST_LANE;
      else process.env.CAT_CAFE_FAST_LANE = previous;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('CAT_CAFE_FAST_LANE=1 treats an already-scaffolded project as success', async () => {
    const previous = process.env.CAT_CAFE_FAST_LANE;
    process.env.CAT_CAFE_FAST_LANE = '1';
    const projectRoot = await mkdtemp(join(tmpdir(), 'cat-fast-lane-idempotent-'));
    await mkdir(join(projectRoot, '.cat-cafe', 'projects', 'existing'), { recursive: true });
    try {
      const sourceTask = { id: 'task-source', threadId: 't1', sourceMessageId: 'msg-task', events: [] };
      const updatedTasks = [];
      const fastDeps = stubDeps({
        messageStore: {
          append: mock.fn(async () => ({ id: 'msg-stub' })),
          getById: mock.fn(async () => null),
          markDelivered: mock.fn(async () => null),
        },
        gitArtifactCollector: mock.fn(async () => ({ files: [], totalAdded: 0, totalRemoved: 0 })),
        taskStore: {
          listByThread: mock.fn(async () => [updatedTasks.at(-1) ?? sourceTask]),
          update: mock.fn(async (_taskId, input) => {
            const previousTask = updatedTasks.at(-1) ?? sourceTask;
            const updated = { ...sourceTask, events: [...previousTask.events, ...(input.events ?? [])] };
            updatedTasks.push(updated);
            return updated;
          }),
        },
      });
      const fastProcessor = new QueueProcessor(fastDeps);
      const entry = enqueueEntry(fastDeps.queue, {
        content: `/project-init existing --root ${projectRoot}`,
        targetCats: ['opus'],
      });
      fastDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-task');

      const result = await fastProcessor.processNext('t1', 'u1');
      assert.equal(result.started, true);
      await waitForTaskEvents(updatedTasks, 3);

      // The scaffold is project-level and shared by every channel of that project, so
      // "already there" is the desired end state. Failing here used to break channel
      // creation with a 500 that no retry could clear.
      const eventTypes = updatedTasks.at(-1).events.map((event) => event.type);
      assert.deepEqual(eventTypes, ['fast_lane_decision', 'fast_lane_started', 'fast_lane_completed']);
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_FAST_LANE;
      else process.env.CAT_CAFE_FAST_LANE = previous;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('CAT_CAFE_PARALLEL_DISPATCH=1 starts multiple free cat slots in one processNext call', async () => {
    const previous = process.env.CAT_CAFE_PARALLEL_DISPATCH;
    process.env.CAT_CAFE_PARALLEL_DISPATCH = '1';
    try {
      const slowDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            await new Promise((r) => setTimeout(r, 120));
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      enqueueEntry(slowDeps.queue, { content: 'opus work', targetCats: ['opus'] });
      enqueueEntry(slowDeps.queue, { content: 'codex work', targetCats: ['codex'] });

      const result = await slowProcessor.processNext('t1', 'u1');

      assert.equal(result.started, true);
      assert.equal(result.entries?.length, 2);
      assert.deepEqual(result.entries?.map((entry) => entry.targetCats[0]).sort(), ['codex', 'opus']);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(slowDeps.invocationTracker.startAll.mock.calls.length, 2);
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_PARALLEL_DISPATCH;
      else process.env.CAT_CAFE_PARALLEL_DISPATCH = previous;
    }
  });

  it('CAT_CAFE_PARALLEL_DISPATCH=1 does not start two invocations for the same cat slot', async () => {
    const previous = process.env.CAT_CAFE_PARALLEL_DISPATCH;
    process.env.CAT_CAFE_PARALLEL_DISPATCH = '1';
    try {
      const slowDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            await new Promise((r) => setTimeout(r, 120));
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      enqueueEntry(slowDeps.queue, { content: 'first opus work', targetCats: ['opus'] });
      enqueueEntry(slowDeps.queue, { content: 'second opus work', targetCats: ['opus'] });

      const result = await slowProcessor.processNext('t1', 'u1');

      assert.equal(result.started, true);
      assert.equal(result.entries?.length, 1);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(slowDeps.invocationTracker.startAll.mock.calls.length, 1);
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_PARALLEL_DISPATCH;
      else process.env.CAT_CAFE_PARALLEL_DISPATCH = previous;
    }
  });

  it('CAT_CAFE_PARALLEL_DISPATCH disabled preserves single-entry processNext behavior', async () => {
    const previous = process.env.CAT_CAFE_PARALLEL_DISPATCH;
    delete process.env.CAT_CAFE_PARALLEL_DISPATCH;
    try {
      const slowDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            await new Promise((r) => setTimeout(r, 120));
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      enqueueEntry(slowDeps.queue, { content: 'opus work', targetCats: ['opus'] });
      enqueueEntry(slowDeps.queue, { content: 'codex work', targetCats: ['codex'] });

      const result = await slowProcessor.processNext('t1', 'u1');

      assert.equal(result.started, true);
      assert.equal(result.entries, undefined);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(slowDeps.invocationTracker.startAll.mock.calls.length, 1);
    } finally {
      if (previous === undefined) delete process.env.CAT_CAFE_PARALLEL_DISPATCH;
      else process.env.CAT_CAFE_PARALLEL_DISPATCH = previous;
    }
  });

  // ── Mutex ──

  it('concurrent tryExecuteNext on same thread + same cat → only one starts (F108: per-slot mutex)', async () => {
    // Make executeEntry slow
    const slowDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          await new Promise((r) => setTimeout(r, 100));
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const slowProcessor = new QueueProcessor(slowDeps);

    // Both entries target same cat → same slot key
    enqueueEntry(slowDeps.queue, { content: 'a', targetCats: ['opus'] });
    enqueueEntry(slowDeps.queue, { content: 'b', targetCats: ['opus'] });

    // Fire two processNext concurrently
    const [r1, r2] = await Promise.all([slowProcessor.processNext('t1', 'u1'), slowProcessor.processNext('t1', 'u1')]);

    // One should start, other should not (per-slot mutex)
    const startedCount = [r1, r2].filter((r) => r.started).length;
    assert.equal(startedCount, 1, 'only one should start due to per-slot mutex');
  });

  // ── executeEntry creates InvocationRecord ──

  it('executeEntry creates InvocationRecord with queue idempotency key', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const createCalls = deps.invocationRecordStore.create.mock.calls;
    assert.ok(createCalls.length > 0);
    const createArg = createCalls[0].arguments[0];
    assert.ok(createArg.idempotencyKey.startsWith('queue-'));
  });

  it('connector-sourced entry uses connector-${messageId} idempotency key', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'connector' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-conn-1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const createCalls = deps.invocationRecordStore.create.mock.calls;
    assert.ok(createCalls.length > 0);
    const createArg = createCalls[0].arguments[0];
    assert.strictEqual(createArg.idempotencyKey, 'connector-msg-conn-1');
  });

  it('entry-provided idempotency key overrides queue entry id', async () => {
    const entry = enqueueEntry(deps.queue, { idempotencyKey: 'a2a:msg-trigger:opus-45:codex' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-trigger');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const createCalls = deps.invocationRecordStore.create.mock.calls;
    assert.ok(createCalls.length > 0);
    const createArg = createCalls[0].arguments[0];
    assert.strictEqual(createArg.idempotencyKey, 'a2a:msg-trigger:opus-45:codex');
  });

  // ── P1-2 fix: isPaused state tracking ──

  it('isPaused returns true after canceled when queue has entries', async () => {
    enqueueEntry(deps.queue);
    assert.equal(processor.isPaused('t1'), false);

    await processor.onInvocationComplete('t1', 'opus', 'canceled');
    assert.equal(processor.isPaused('t1'), true);

    // processNext clears paused
    await processor.processNext('t1', 'u1');
    assert.equal(processor.isPaused('t1'), false);
  });

  it('isPaused returns false when queue is empty even after failed', async () => {
    // No entries in queue — no pause should be persisted
    await processor.onInvocationComplete('t1', 'opus', 'failed');
    assert.equal(processor.isPaused('t1'), false);

    // Add entry → still not paused
    enqueueEntry(deps.queue);
    assert.equal(processor.isPaused('t1'), false);

    // Succeeded clears paused flag
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    assert.equal(processor.isPaused('t1'), false);
  });

  // ── P1 fix: chain auto-dequeue ──

  it('chain auto-dequeue: entry1 succeed → entry2 auto-starts', async () => {
    // Enqueue two entries from different users
    const e1 = enqueueEntry(deps.queue, { userId: 'u1', content: 'first', targetCats: ['a'] });
    deps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-1');
    const e2 = enqueueEntry(deps.queue, { userId: 'u2', content: 'second', targetCats: ['b'] });
    deps.queue.backfillMessageId('t1', 'u2', e2.id, 'msg-2');

    // Trigger first entry via onInvocationComplete('succeeded')
    await processor.onInvocationComplete('t1', 'a', 'succeeded');

    // Wait for both executions to complete (e1 finishes → chains → e2 starts)
    await new Promise((r) => setTimeout(r, 200));

    // Both entries should have been processed (tracker.start called twice)
    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length >= 2,
      `expected >=2 tracker.start calls, got ${deps.invocationTracker.startAll.mock.calls.length}`,
    );
  });

  it('threshold seal capsule in queued execution enqueues and starts bounded same-cat continuation', async () => {
    let routeCalls = 0;
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-first',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const routeContents = [];
    const sealDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, content) {
          routeCalls++;
          routeContents.push(content);
          if (routeCalls === 1) {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
              timestamp: Date.now(),
            };
          } else {
            yield { type: 'text', catId: 'opus', content: 'continued', timestamp: Date.now() };
          }
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sealProcessor = new QueueProcessor(sealDeps);
    const entry = enqueueEntry(sealDeps.queue, { targetCats: ['opus'], content: 'initial work' });
    sealDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await sealProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(routeCalls, 2, 'second route call should be the continuation');
    assert.match(routeContents[1], /previous session was sealed/i);
    assert.ok(sealDeps.invocationTracker.startAll.mock.calls.length >= 2);
  });

  it('threshold seal capsule in queued multi-cat execution resumes the capsule owner cat', async () => {
    let routeCalls = 0;
    const routeTargetCats = [];
    const routeContents = [];
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'codex',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-codex-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-codex', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const sealDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, content, _threadId, _messageId, targetCats) {
          routeCalls++;
          routeContents.push(content);
          routeTargetCats.push([...targetCats]);
          if (routeCalls === 1) {
            yield {
              type: 'system_info',
              catId: 'codex',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
              timestamp: Date.now(),
            };
          } else {
            yield { type: 'text', catId: targetCats[0], content: 'continued', timestamp: Date.now() };
          }
          yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sealProcessor = new QueueProcessor(sealDeps);
    const entry = enqueueEntry(sealDeps.queue, { targetCats: ['opus', 'codex'], content: 'parallel work' });
    sealDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await sealProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(routeCalls, 2, 'second route call should be the continuation');
    assert.deepEqual(routeTargetCats[0], ['opus', 'codex']);
    assert.deepEqual(routeTargetCats[1], ['codex']);
    assert.match(routeContents[1], /Cat: codex/);
  });

  it('threshold seal capsules in queued multi-cat execution resume every sealed cat', async () => {
    let routeCalls = 0;
    const routeTargetCats = [];
    const opusCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-opus-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-opus', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const codexCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'codex',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-codex-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-codex', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const sealDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
          routeCalls++;
          routeTargetCats.push([...targetCats]);
          if (routeCalls === 1) {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: opusCapsule }),
              timestamp: Date.now(),
            };
            yield {
              type: 'system_info',
              catId: 'codex',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: codexCapsule }),
              timestamp: Date.now(),
            };
          } else {
            yield { type: 'text', catId: targetCats[0], content: 'continued', timestamp: Date.now() };
          }
          yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sealProcessor = new QueueProcessor(sealDeps);
    const entry = enqueueEntry(sealDeps.queue, { targetCats: ['opus', 'codex'], content: 'parallel work' });
    sealDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await sealProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 250));

    assert.equal(routeCalls, 3, 'both sealed cats should get continuation runs');
    assert.deepEqual(routeTargetCats[0], ['opus', 'codex']);
    assert.deepEqual(
      routeTargetCats.slice(1).sort((a, b) => a[0].localeCompare(b[0])),
      [['codex'], ['opus']],
    );
  });

  it('threshold seal capsule does not enqueue continuation when execution fails afterward', async () => {
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-first',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
            timestamp: Date.now(),
          };
          throw new Error('route failed after seal notice');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);
    const entry = enqueueEntry(failDeps.queue, { targetCats: ['opus'], content: 'initial work' });
    failDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await failProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(failDeps.queue.list('t1', 'u1').length, 0, 'failed execution must not leave continuation queued');
    assert.equal(failDeps.router.routeExecution.mock.calls.length, 1, 'must not start continuation after failure');
  });

  it('enqueueContinuation pins seal work ahead of queued user work without dropping either', async () => {
    enqueueEntry(deps.queue, { targetCats: ['opus'], source: 'user', content: 'new user work' });
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-1',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );

    const outcome = processor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule });

    assert.equal(outcome.outcome, 'enqueued');
    const queue = deps.queue.list('t1', 'u1');
    assert.equal(queue.length, 2);
    assert.match(queue[0].content, /Continue the same structured work from the sealed session/);
    assert.equal(queue[1].content, 'new user work');
  });

  it('enqueueContinuation pins seal work ahead of queued agent work without dropping either', async () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      enqueueEntry(deps.queue, { targetCats: ['opus'], source: 'agent', content: 'stale queued work' });
      now += InvocationQueue.STALE_QUEUED_THRESHOLD_MS + 1;
      const capsule = completeCapsuleForSeal(
        buildCapsuleFromRouteState({
          threadId: 't1',
          catId: 'opus',
          mode: 'independent',
          a2aEnabled: true,
        }),
        {
          invocationId: 'inv-stale-queued',
          createdAt: now,
          seal: { sessionId: 'sess-stale-queued', sessionSeq: 1, reason: 'threshold' },
        },
      );

      const outcome = processor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule });

      assert.equal(outcome.outcome, 'enqueued');
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 2);
      assert.match(queue[0].content, /Continue the same structured work from the sealed session/);
      assert.equal(queue[1].content, 'stale queued work', 'old queued agent work must not be dropped');
    } finally {
      Date.now = originalNow;
    }
  });

  it('enqueueContinuation does not retain empty continuation window after skipped duplicate', async () => {
    enqueueEntry(deps.queue, {
      targetCats: ['opus'],
      source: 'agent',
      sourceCategory: 'continuation',
      continuationKey: 't1:opus:inv-duplicate-window:sess-duplicate-window:1',
      content: 'pending continuation work',
    });
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-duplicate-window',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-duplicate-window', sessionSeq: 1, reason: 'threshold' },
      },
    );

    const outcome = processor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule });

    assert.equal(outcome.outcome, 'skipped_existing_entry');
    assert.equal(processor.continuationWindows.has('t1:opus'), false);
  });

  it('enqueueContinuation preserves distinct sealed work while deduping the same seal item', async () => {
    const firstCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-first-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-first-seal', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const secondCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-second-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-second-seal', sessionSeq: 2, reason: 'threshold' },
      },
    );

    const first = processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      catId: 'opus',
      capsule: firstCapsule,
    });
    const duplicateFirst = processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      catId: 'opus',
      capsule: firstCapsule,
    });
    const second = processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      catId: 'opus',
      capsule: secondCapsule,
    });

    assert.equal(first.outcome, 'enqueued');
    assert.equal(duplicateFirst.outcome, 'skipped_existing_entry');
    assert.equal(second.outcome, 'enqueued');
    assert.equal(deps.queue.list('t1', 'u1').length, 2);
  });

  it('enqueueContinuation pins seal work ahead of old queued user work without dropping either', async () => {
    const originalNow = Date.now;
    let now = 1_500_000;
    Date.now = () => now;
    try {
      enqueueEntry(deps.queue, { targetCats: ['opus'], source: 'user', content: 'old but real user work' });
      now += InvocationQueue.STALE_QUEUED_THRESHOLD_MS + 1;
      const capsule = completeCapsuleForSeal(
        buildCapsuleFromRouteState({
          threadId: 't1',
          catId: 'opus',
          mode: 'independent',
          a2aEnabled: true,
        }),
        {
          invocationId: 'inv-old-user-work',
          createdAt: now,
          seal: { sessionId: 'sess-old-user-work', sessionSeq: 1, reason: 'threshold' },
        },
      );

      const outcome = processor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule });

      assert.equal(outcome.outcome, 'enqueued');
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 2);
      assert.match(queue[0].content, /Continue the same structured work from the sealed session/);
      assert.equal(queue[1].content, 'old but real user work');
    } finally {
      Date.now = originalNow;
    }
  });

  it('enqueueContinuation ignores stale processing entries when checking existing pending work', async () => {
    const originalNow = Date.now;
    let now = 2_000_000;
    Date.now = () => now;
    try {
      const entry = enqueueEntry(deps.queue, {
        targetCats: ['opus'],
        source: 'agent',
        content: 'stale processing work',
      });
      deps.queue.markProcessingById('t1', entry.id);
      now += InvocationQueue.STALE_PROCESSING_THRESHOLD_MS + 1;
      const capsule = completeCapsuleForSeal(
        buildCapsuleFromRouteState({
          threadId: 't1',
          catId: 'opus',
          mode: 'independent',
          a2aEnabled: true,
        }),
        {
          invocationId: 'inv-stale-processing',
          createdAt: now,
          seal: { sessionId: 'sess-stale-processing', sessionSeq: 1, reason: 'threshold' },
        },
      );

      const outcome = processor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule });

      assert.equal(outcome.outcome, 'enqueued');
      assert.equal(outcome.entry?.targetCats[0], 'opus');
    } finally {
      Date.now = originalNow;
    }
  });

  it('continuation dispatch runs seal continuation first and preserves old queued agent work', async () => {
    const originalNow = Date.now;
    let now = 3_000_000;
    Date.now = () => now;
    const routeContents = [];
    try {
      const dispatchDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (_userId, content, _threadId, _messageId, targetCats) {
            routeContents.push(content);
            yield { type: 'text', catId: targetCats[0], content: 'ok', timestamp: Date.now() };
            yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const dispatchProcessor = new QueueProcessor(dispatchDeps);
      enqueueEntry(dispatchDeps.queue, {
        source: 'agent',
        targetCats: ['opus'],
        content: 'old queued handoff',
      });
      now += InvocationQueue.STALE_QUEUED_THRESHOLD_MS + 1;
      const capsule = completeCapsuleForSeal(
        buildCapsuleFromRouteState({
          threadId: 't1',
          catId: 'opus',
          mode: 'independent',
          a2aEnabled: true,
        }),
        {
          invocationId: 'inv-fresh-continuation',
          createdAt: now,
          seal: { sessionId: 'sess-fresh-continuation', sessionSeq: 1, reason: 'threshold' },
        },
      );

      const outcome = dispatchProcessor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule });
      assert.equal(outcome.outcome, 'enqueued');
      assert.equal(dispatchDeps.queue.list('t1', 'u1').length, 2, 'continuation should wait behind agent work');

      await dispatchProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 80));

      assert.ok(routeContents.length > 0, 'seal continuation should be dispatched first');
      assert.match(routeContents[0], /Continue the same structured work from the sealed session/);

      await dispatchProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 80));

      assert.ok(routeContents.length > 1, 'old queued agent work should still dispatch after continuation');
      assert.match(routeContents[1], /old queued handoff/);
    } finally {
      Date.now = originalNow;
    }
  });

  it('enqueueContinuation rate-limits after five continuations per hour for a thread cat', async () => {
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-rate-limit',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-rate-limit', sessionSeq: 1, reason: 'threshold' },
      },
    );

    for (let i = 0; i < 5; i++) {
      const outcome = processor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule });
      assert.equal(outcome.outcome, 'enqueued');
      deps.queue.clear('t1', 'u1');
    }

    const sixth = processor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule });

    assert.equal(sixth.outcome, 'skipped_rate_limited');
    assert.equal(deps.queue.list('t1', 'u1').length, 0);
  });

  // ── #768: intent_mode deferred until CLI is alive ──

  it('#768 regression: intent_mode is NOT broadcast when routeExecution throws before yielding', async () => {
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          throw new Error('CLI spawn failed');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);

    const entry = enqueueEntry(failDeps.queue);
    failDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await failProcessor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 100));

    const intentCall = failDeps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.equal(intentCall, undefined, 'intent_mode must NOT be broadcast when CLI fails before producing events');
  });

  it('#768 regression: intent_mode IS broadcast once CLI produces first event', async () => {
    const entry = enqueueEntry(deps.queue, { targetCats: ['codex'], intent: 'execute' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const intentCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.ok(intentCall, 'intent_mode should be broadcast after first CLI event');
  });

  it('#768 regression: intent_mode is NOT broadcast when routeExecution yields nothing (empty generator)', async () => {
    const emptyDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          // Generator completes without yielding any events
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const emptyProcessor = new QueueProcessor(emptyDeps);

    const entry = enqueueEntry(emptyDeps.queue);
    emptyDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await emptyProcessor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 100));

    const intentCall = emptyDeps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.equal(intentCall, undefined, 'intent_mode must NOT be broadcast when CLI produces zero events');
  });

  // ── P1 fix: executeEntry failure marks InvocationRecord ──

  it('executeEntry failure marks InvocationRecord as failed', async () => {
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          throw new Error('route boom');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);

    const entry = enqueueEntry(failDeps.queue);
    failDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await failProcessor.processNext('t1', 'u1');
    // Wait for background execution to complete
    await new Promise((r) => setTimeout(r, 100));

    // InvocationRecord should be updated with status='failed'
    const updateCalls = failDeps.invocationRecordStore.update.mock.calls;
    const failedUpdate = updateCalls.find((c) => c.arguments[1]?.status === 'failed');
    assert.ok(failedUpdate, 'should mark InvocationRecord as failed');
    assert.ok(failedUpdate.arguments[1].error, 'should include error message');
  });

  // ── F039 remaining bugfix: queue execution should include contentBlocks ──

  it('executeEntry passes contentBlocks from messageId to routeExecution', async () => {
    const contentBlocks = [{ type: 'image', url: 'https://example.com/1.png' }];

    deps.messageStore.getById = mock.fn(async (id) => {
      if (id === 'm1') return { id: 'm1', contentBlocks };
      return null;
    });

    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'm1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(deps.router.routeExecution.mock.calls.length > 0);
    const call = deps.router.routeExecution.mock.calls[0];
    const opts = call.arguments[6];
    assert.ok(opts && typeof opts === 'object', 'expected opts object');
    assert.deepEqual(opts.contentBlocks, contentBlocks);
  });

  it('degrades when messageStore.getById throws: still executes without contentBlocks', async () => {
    deps.messageStore.getById = mock.fn(async () => {
      throw new Error('redis down');
    });

    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'm1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(deps.router.routeExecution.mock.calls.length > 0, 'should still execute');
    const call = deps.router.routeExecution.mock.calls[0];
    const opts = call.arguments[6];
    assert.ok(opts && typeof opts === 'object', 'expected opts object');
    assert.equal(opts.contentBlocks, undefined);

    const succeededUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (c) => c.arguments[1]?.status === 'succeeded',
    );
    assert.ok(succeededUpdate, 'should mark InvocationRecord succeeded');

    assert.ok(deps.log.warn.mock.calls.length > 0, 'should warn on messageStore failure');
  });

  it('persists an intent preamble into the task discussion thread before execution', async () => {
    const sourceTask = {
      id: 'task-1',
      threadId: 't1',
      taskThreadId: 'task-thread-1',
      sourceMessageId: 'm1',
      title: '实现 WI-9 心跳补齐',
      status: 'doing',
      kind: 'work',
      createdBy: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    deps = stubDeps({
      messageStore: {
        append: mock.fn(async (input) => ({
          ...input,
          id: 'intent-msg-1',
          timestamp: input.timestamp ?? Date.now(),
        })),
        getById: mock.fn(async () => null),
        markDelivered: mock.fn(async () => null),
      },
      taskStore: {
        listByThread: mock.fn(async () => [sourceTask]),
        update: mock.fn(async () => sourceTask),
      },
      gitArtifactCollector: mock.fn(async () => null),
    });
    processor = new QueueProcessor(deps);

    const entry = enqueueEntry(deps.queue, { targetCats: ['opus'], messageId: 'm1' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'm1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const intentAppend = deps.messageStore.append.mock.calls.find((call) =>
      String(call.arguments[0]?.idempotencyKey ?? '').startsWith('progress-intent:'),
    );
    assert.ok(intentAppend, 'should append a progress intent message');
    const input = intentAppend.arguments[0];
    assert.equal(input.threadId, 'task-thread-1');
    assert.equal(input.source.connector, 'agent-progress-intent');
    assert.equal(input.extra.systemKind, 'progress_heartbeat');
    assert.match(input.content, /我要做「实现 WI-9 心跳补齐」/);

    const broadcast = deps.socketManager.broadcastToRoom.mock.calls.find(
      (call) => call.arguments[0] === 'thread:task-thread-1' && call.arguments[1] === 'connector_message',
    );
    assert.ok(broadcast, 'should broadcast the intent into the task thread');
  });

  // ── F108: QueueProcessor slot-aware (AC-A7) ──

  describe('slot-aware mutex and dequeue (F108)', () => {
    it('processing mutex is per-slot: different cats can execute concurrently in same thread', async () => {
      // Enqueue opus and codex entries for same thread
      const e1 = enqueueEntry(deps.queue, { content: 'opus task', targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-opus');
      const e2 = enqueueEntry(deps.queue, { content: 'codex task', targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', e2.id, 'msg-codex');

      // Complete opus slot → should dequeue opus entry
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // Now complete codex slot → should dequeue codex entry (not blocked by opus mutex)
      await processor.onInvocationComplete('t1', 'codex', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // Both entries should have been processed
      assert.ok(
        deps.invocationTracker.startAll.mock.calls.length >= 2,
        `expected >=2 tracker.start calls, got ${deps.invocationTracker.startAll.mock.calls.length}`,
      );
    });

    it('slot completion does not affect pause state of different slot', async () => {
      // Enqueue entries for both cats
      enqueueEntry(deps.queue, { content: 'opus task', targetCats: ['opus'] });
      enqueueEntry(deps.queue, { content: 'codex task', targetCats: ['codex'] });

      // Cancel opus slot — should pause opus, not codex
      await processor.onInvocationComplete('t1', 'opus', 'canceled');

      // opus slot should be paused
      assert.equal(processor.isPaused('t1', 'opus'), true);
      // codex slot should NOT be paused
      assert.equal(processor.isPaused('t1', 'codex'), false);
    });

    it('clearPause is slot-specific', () => {
      // Manually set both paused
      processor.clearPause('t1', 'opus');
      // Should not throw, just noop
      assert.equal(processor.isPaused('t1', 'opus'), false);
    });

    it('releaseSlot is slot-specific', async () => {
      const slowDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            await new Promise((r) => setTimeout(r, 200));
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      // Enqueue opus and codex
      const e1 = enqueueEntry(slowDeps.queue, { content: 'opus slow', targetCats: ['opus'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-1');
      const e2 = enqueueEntry(slowDeps.queue, { content: 'codex fast', targetCats: ['codex'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', e2.id, 'msg-2');

      // Start opus via processNext — takes mutex for opus slot
      await slowProcessor.processNext('t1', 'u1');

      // Release opus slot — should allow another opus entry to start
      slowProcessor.releaseSlot('t1', 'opus');

      // codex should still be startable (no mutex on codex slot)
      const r2 = await slowProcessor.processNext('t1', 'u1');
      assert.equal(r2.started, true, 'codex entry should start since opus slot was released');
    });

    it('processNext skips queued entries whose cat slot is already processing', async () => {
      const slowDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            await new Promise((r) => setTimeout(r, 200));
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      const runningOpus = enqueueEntry(slowDeps.queue, { content: 'opus running', targetCats: ['opus'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', runningOpus.id, 'msg-running-opus');
      await slowProcessor.processNext('t1', 'u1');

      const queuedOpus = enqueueEntry(slowDeps.queue, { content: 'opus queued', targetCats: ['opus'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', queuedOpus.id, 'msg-queued-opus');
      const queuedCodex = enqueueEntry(slowDeps.queue, { content: 'codex queued', targetCats: ['codex'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', queuedCodex.id, 'msg-queued-codex');

      const result = await slowProcessor.processNext('t1', 'u1');

      assert.equal(result.started, true, 'free codex slot should start even when older opus entry is blocked');
      assert.deepEqual(result.entry?.targetCats, ['codex']);
      const queue = slowDeps.queue.list('t1', 'u1');
      assert.equal(
        queue.find((entry) => entry.id === queuedOpus.id)?.status,
        'queued',
        'busy opus entry should be rolled back and remain queued',
      );
    });

    it('onInvocationComplete requires catId parameter', async () => {
      enqueueEntry(deps.queue);

      // New signature: onInvocationComplete(threadId, catId, status)
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      // Should not throw — catId is now required
    });

    it('tryExecuteNextAcrossUsers checks entryCat slot, not just completing cat slot (P1-2)', async () => {
      // Scenario: opus completes, oldest queued entry targets codex, but codex is already running.
      // Bug: code checks completing cat (opus) slot mutex, not the entry's cat (codex).
      // Expected: should NOT start codex entry when codex slot is busy.

      // Make routeExecution hang so codex stays "in progress"
      let resolveCodex;
      deps.router.routeExecution = mock.fn(async function* () {
        await new Promise((r) => {
          resolveCodex = r;
        });
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      });

      const codexEntry = enqueueEntry(deps.queue, { targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', codexEntry.id, 'msg-codex');

      // Start codex — it hangs (slot is busy)
      await processor.processNext('t1', 'u1');

      // Enqueue another codex entry while the first is still running
      const codexEntry2 = enqueueEntry(deps.queue, { targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', codexEntry2.id, 'msg-codex2');

      // Simulate opus completing — triggers auto-dequeue across users
      // Oldest remaining queued entry is codex, but codex slot is busy
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // routeExecution should only have been called once (for the first codex entry)
      const routeCalls = deps.router.routeExecution.mock.calls;
      assert.equal(routeCalls.length, 1, `should not double-start codex slot; got ${routeCalls.length} route calls`);

      // Cleanup: resolve the hanging codex execution
      resolveCodex?.();
    });

    it('tryExecuteNextForUser does not leave entry stuck in processing when slot is busy (P1-3)', async () => {
      // Scenario: codex is already running, user sends another message targeting codex.
      // Bug: markProcessing() called before mutex check, entry gets stuck as 'processing'.
      // Expected: entry should remain 'queued' if slot is busy.

      // Make routeExecution hang so codex stays "in progress"
      let resolveCodex;
      deps.router.routeExecution = mock.fn(async function* () {
        await new Promise((r) => {
          resolveCodex = r;
        });
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      });

      const entry1 = enqueueEntry(deps.queue, { targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', entry1.id, 'msg-1');

      // Process entry1 — codex slot becomes busy (hangs)
      await processor.processNext('t1', 'u1');

      // Use different intent to prevent auto-merge with entry1
      const entry2res = deps.queue.enqueue({
        threadId: 't1',
        userId: 'u1',
        content: 'second message',
        source: 'user',
        targetCats: ['codex'],
        intent: 'ideate',
      });
      const entry2 = entry2res.entry;
      deps.queue.backfillMessageId('t1', 'u1', entry2.id, 'msg-2');

      // Try to process entry2 while codex slot is busy
      const result = await processor.processNext('t1', 'u1');
      assert.equal(result.started, false, 'should not start when slot is busy');

      // Key assertion: entry2 should still be 'queued', not stuck as 'processing'
      const list = deps.queue.list('t1', 'u1');
      const entry2Status = list.find((e) => e.id === entry2.id);
      assert.ok(entry2Status, 'entry2 should still be in queue');
      assert.equal(entry2Status.status, 'queued', 'entry2 should remain queued, not stuck as processing');

      // Cleanup
      resolveCodex?.();
    });

    it('broadcast messages carry invocationId (AC-A8)', async () => {
      const entry = enqueueEntry(deps.queue);
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await processor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 50));

      const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
      assert.ok(broadcastCalls.length > 0, 'should have broadcast at least one message');
      const msgArg = broadcastCalls[0].arguments[0];
      assert.equal(msgArg.invocationId, 'inv-stub', 'broadcast message should carry invocationId');
    });
  });

  // ── F122B: tryAutoExecute ──

  describe('tryAutoExecute (F122B agent auto-execute)', () => {
    it('immediately executes autoExecute entry when target cat slot is free', async () => {
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });

      await processor.tryAutoExecute('t1');
      // Give fire-and-forget a tick
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0, 'should start execution');
    });

    it('does not execute autoExecute entry when target cat slot is busy', async () => {
      // Occupy opus slot
      deps.invocationTracker.has = mock.fn(() => true);
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      // Entry stays queued, not executed
      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0, 'should not start when slot busy');
      const queued = deps.queue.list('t1', 'system');
      assert.equal(queued.length, 1, 'entry should remain in queue');
      assert.equal(queued[0].status, 'queued', 'entry should still be queued');
    });

    it('skips non-autoExecute entries', async () => {
      enqueueEntry(deps.queue, {
        userId: 'u1',
        source: 'user',
        targetCats: ['opus'],
        // no autoExecute
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0, 'should not execute user entries');
    });

    it('executes old queued autoExecute entries older than threshold when the slot is free', async () => {
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });
      // list() returns shallow-copied array with reference elements — mutating
      // createdAt here reaches the real entry inside the queue (coupling on purpose).
      const queued = deps.queue.list('t1', 'system');
      queued[0].createdAt = Date.now() - 120_000;

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 1, 'old autoExecute entry must still start');
      assert.equal(
        deps.queue.list('t1', 'system').length,
        0,
        'old autoExecute entry should be removed after execution',
      );
    });

    it('autoExecute entry bypasses pause state', async () => {
      // Set up a paused state
      enqueueEntry(deps.queue, { userId: 'u1', source: 'user' });
      await processor.onInvocationComplete('t1', 'opus', 'failed');
      assert.ok(processor.isPaused('t1', 'opus'), 'should be paused');

      // Now enqueue an agent auto-execute entry
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'], // different cat slot — not paused
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(
        deps.invocationTracker.startAll.mock.calls.length > 0,
        'should execute on free slot despite thread pause',
      );
    });

    it('skips busy-slot entry and executes next free-slot autoExecute entry (P2 scan)', async () => {
      // Entry 1: opus slot busy
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      // Entry 2: codex slot free
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'gemini',
      });

      // Mock: opus is busy, codex is free
      deps.invocationTracker.has = mock.fn((threadId, catId) => catId === 'opus');

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      // First start should be codex (skipped opus because slot is busy)
      assert.ok(deps.invocationTracker.startAll.mock.calls.length >= 1, 'should start at least one');
      const firstStartCall = deps.invocationTracker.startAll.mock.calls[0];
      // startAll receives catIds[] as second arg
      assert.deepEqual(firstStartCall.arguments[1], ['codex'], 'should start codex (free slot) first, not opus (busy)');
    });

    it('starts multiple free-slot entries in a single tryAutoExecute call (parallel dispatch)', async () => {
      // Enqueue 3 entries for 3 different cats — all slots free
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['gemini'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 100));

      // All 3 should have been started (different cat slots, all free)
      const startCalls = deps.invocationTracker.startAll.mock.calls;
      assert.equal(startCalls.length, 3, 'should start all 3 entries in one call');
      // startAll receives catIds[] as second arg — flatten to get primary cats
      const startedCats = startCalls.map((c) => c.arguments[1][0]);
      assert.ok(startedCats.includes('opus'), 'opus should be started');
      assert.ok(startedCats.includes('codex'), 'codex should be started');
      assert.ok(startedCats.includes('gemini'), 'gemini should be started');
    });

    it('passes A2A caller and trigger context into queued target invocation', async () => {
      const routeCalls = [];
      const a2aDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (...args) {
            routeCalls.push(args);
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const a2aProcessor = new QueueProcessor(a2aDeps);
      const entry = enqueueEntry(a2aDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请执行 Phase 1-B',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus-45',
        a2aTriggerMessageId: 'msg-claude-handoff',
      });
      a2aDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-claude-handoff');

      await a2aProcessor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      const createInput = a2aDeps.invocationRecordStore.create.mock.calls[0].arguments[0];
      assert.equal(createInput.callerCatId, 'opus-45');
      assert.equal(createInput.a2aTriggerMessageId, 'msg-claude-handoff');
      assert.equal(createInput.idempotencyKey, 'a2a:msg-claude-handoff:opus-45:codex');

      const routeOptions = routeCalls[0][6];
      assert.equal(routeOptions.directMessageFrom, 'opus-45');
      assert.equal(routeOptions.a2aTriggerMessageId, 'msg-claude-handoff');
      assert.equal(routeOptions.replyToMessageId, 'msg-claude-handoff');
    });

    it('redirects a queued-user A2A conflict to a durable reminder for the sender', async () => {
      const messagesAfterSource = [
        {
          id: 'msg-user-correction',
          threadId: 't1',
          userId: 'u1',
          catId: null,
          content: '先别做这个，换方向，等我确认后再执行',
          mentions: [],
          timestamp: Date.now(),
        },
      ];
      const conflictDeps = stubDeps({
        messageStore: {
          append: mock.fn(async (input) => ({ ...input, id: 'msg-conflict-notice' })),
          getById: mock.fn(async () => null),
          getByThreadAfter: mock.fn(async () => messagesAfterSource),
        },
      });
      const conflictProcessor = new QueueProcessor(conflictDeps);
      const entry = enqueueEntry(conflictDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请继续原方案',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus-45',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aSourceUserMessageId: 'msg-user-original',
        a2aWaitedForQueuedUserMessages: true,
      });
      conflictDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-agent-handoff');

      await conflictProcessor.tryAutoExecute('t1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      const createCalls = conflictDeps.invocationRecordStore.create.mock.calls.map((call) => call.arguments[0]);
      assert.equal(
        createCalls.some((input) => input.targetCats[0] === 'codex'),
        false,
        'conflicting target must not run',
      );
      assert.equal(
        createCalls.filter((input) => input.targetCats[0] === 'opus-45').length,
        1,
        'sender should receive exactly one durable conflict reminder',
      );
      const reminderRoute = conflictDeps.router.routeExecution.mock.calls.find(
        (call) => call.arguments[4][0] === 'opus-45',
      );
      assert.ok(reminderRoute, 'conflict reminder should execute through the normal queue path');
      assert.match(reminderRoute.arguments[1], /@codex 请继续原方案/);
      assert.match(reminderRoute.arguments[1], /先别做这个，换方向/);

      const noticeInput = conflictDeps.messageStore.append.mock.calls.find(
        (call) => call.arguments[0].source?.connector === 'a2a-replay-conflict',
      )?.arguments[0];
      assert.ok(noticeInput, 'thread should receive one visible conflict notice');
      assert.match(noticeInput.content, /已提醒 @opus-45 重新确认/);
    });

    it('detects a deferred A2A correction even when later supplements exceed the intent snapshot window', async () => {
      const messagesAfterSource = [
        {
          id: 'msg-user-correction-old',
          threadId: 't1',
          userId: 'u1',
          catId: null,
          content: '先别做这个，等我重新确认',
          mentions: [],
          timestamp: Date.now(),
        },
        ...Array.from({ length: 21 }, (_, index) => ({
          id: `msg-user-supplement-${index}`,
          threadId: 't1',
          userId: 'u1',
          catId: null,
          content: `补充材料 ${index}`,
          mentions: [],
          timestamp: Date.now() + index + 1,
        })),
      ];
      const conflictDeps = stubDeps({
        messageStore: {
          append: mock.fn(async (input) => ({ ...input, id: 'msg-conflict-notice' })),
          getById: mock.fn(async () => null),
          getByThreadAfter: mock.fn(async () => messagesAfterSource),
        },
      });
      const conflictProcessor = new QueueProcessor(conflictDeps);
      const entry = enqueueEntry(conflictDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请继续原方案',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus-45',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aSourceUserMessageId: 'msg-user-original',
        a2aWaitedForQueuedUserMessages: true,
      });
      conflictDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-agent-handoff');

      await conflictProcessor.tryAutoExecute('t1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      const targets = conflictDeps.invocationRecordStore.create.mock.calls.map(
        (call) => call.arguments[0].targetCats[0],
      );
      assert.equal(targets.includes('codex'), false, 'any correction after the source boundary must block the target');
      assert.equal(targets.filter((target) => target === 'opus-45').length, 1);
    });

    it('keeps the original deferred A2A queued when conflict history cannot be read', async () => {
      const conflictDeps = stubDeps({
        messageStore: {
          append: mock.fn(async (input) => ({ ...input, id: 'msg-stub' })),
          getById: mock.fn(async () => null),
          getByThreadAfter: mock.fn(async () => {
            throw new Error('history unavailable');
          }),
        },
      });
      const conflictProcessor = new QueueProcessor(conflictDeps);
      const entry = enqueueEntry(conflictDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请继续原方案',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus-45',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aSourceUserMessageId: 'msg-user-original',
        a2aWaitedForQueuedUserMessages: true,
      });

      await conflictProcessor.tryAutoExecute('t1');
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(conflictDeps.invocationRecordStore.create.mock.calls.length, 0);
      assert.equal(
        conflictDeps.queue.list('t1', 'u1').some((queued) => queued.id === entry.id),
        true,
      );
    });

    it('fails closed when a deferred A2A is missing its conflict-check lineage', async () => {
      const conflictDeps = stubDeps();
      const conflictProcessor = new QueueProcessor(conflictDeps);
      const entry = enqueueEntry(conflictDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请继续原方案',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus-45',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aWaitedForQueuedUserMessages: true,
      });

      await conflictProcessor.tryAutoExecute('t1');
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(conflictDeps.invocationRecordStore.create.mock.calls.length, 0);
      assert.equal(
        conflictDeps.queue.list('t1', 'u1').some((queued) => queued.id === entry.id),
        true,
      );
      assert.equal(conflictDeps.log.warn.mock.calls.length > 0, true);
    });

    it('routes manual processNext through the deferred A2A conflict guard', async () => {
      const conflictDeps = stubDeps({
        messageStore: {
          append: mock.fn(async (input) => ({ ...input, id: 'msg-conflict-notice' })),
          getById: mock.fn(async () => null),
          getByThreadAfter: mock.fn(async () => [
            {
              id: 'msg-user-correction',
              threadId: 't1',
              userId: 'u1',
              catId: null,
              content: '暂停，先确认后再执行',
              mentions: [],
              timestamp: Date.now(),
            },
          ]),
        },
      });
      const conflictProcessor = new QueueProcessor(conflictDeps);
      enqueueEntry(conflictDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请继续原方案',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus-45',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aSourceUserMessageId: 'msg-user-original',
        a2aWaitedForQueuedUserMessages: true,
      });

      await conflictProcessor.processNext('t1', 'u1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      const targets = conflictDeps.invocationRecordStore.create.mock.calls.map(
        (call) => call.arguments[0].targetCats[0],
      );
      assert.equal(targets.includes('codex'), false, 'manual dequeue must not bypass the conflict guard');
      assert.equal(targets.filter((target) => target === 'opus-45').length, 1);
    });

    it('keeps the original deferred A2A queued when durable removal fails', async () => {
      const persistence = {
        save: mock.fn(async () => {}),
        delete: mock.fn(async () => {
          throw new Error('redis delete unavailable');
        }),
        list: mock.fn(async () => []),
      };
      const queue = new InvocationQueue(persistence);
      const conflictDeps = stubDeps({
        queue,
        messageStore: {
          append: mock.fn(async (input) => ({ ...input, id: 'msg-conflict-notice' })),
          getById: mock.fn(async () => null),
          getByThreadAfter: mock.fn(async () => [
            {
              id: 'msg-user-correction',
              threadId: 't1',
              userId: 'u1',
              catId: null,
              content: '不要做，先讨论',
              mentions: [],
              timestamp: Date.now(),
            },
          ]),
        },
      });
      const conflictProcessor = new QueueProcessor(conflictDeps);
      const entry = enqueueEntry(queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请继续原方案',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus-45',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aSourceUserMessageId: 'msg-user-original',
        a2aWaitedForQueuedUserMessages: true,
        pendingMentionId: 'a2a:msg-agent-handoff:opus-45:codex',
      });
      await queue.persistEntry(entry);

      await conflictProcessor.tryAutoExecute('t1');
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(
        queue.list('t1', 'u1').some((queued) => queued.id === entry.id),
        true,
      );
      assert.equal(
        conflictDeps.invocationRecordStore.create.mock.calls.some(
          (call) => call.arguments[0].targetCats[0] === 'codex',
        ),
        false,
      );
    });

    it('keeps a queued-user A2A deferred until the processing user message finishes', async () => {
      const fairnessDeps = stubDeps();
      const fairnessProcessor = new QueueProcessor(fairnessDeps);
      const userEntry = enqueueEntry(fairnessDeps.queue, {
        userId: 'u1',
        source: 'user',
        content: '第二条用户消息',
        targetCats: ['opus'],
      });
      fairnessDeps.queue.backfillMessageId('t1', 'u1', userEntry.id, 'msg-user-2');
      assert.ok(fairnessDeps.queue.markProcessingById('t1', userEntry.id));

      const handoffEntry = enqueueEntry(fairnessDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请接球',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aSourceUserMessageId: 'msg-user-1',
        a2aWaitedForQueuedUserMessages: true,
      });
      fairnessDeps.queue.backfillMessageId('t1', 'u1', handoffEntry.id, 'msg-agent-handoff');

      await fairnessProcessor.tryAutoExecute('t1');
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(
        fairnessDeps.invocationRecordStore.create.mock.calls.length,
        0,
        'handoff must stay queued while the user message is processing',
      );

      fairnessDeps.queue.removeProcessed('t1', 'u1', userEntry.id);
      await fairnessProcessor.tryAutoExecute('t1');
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(
        fairnessDeps.invocationRecordStore.create.mock.calls.filter(
          (call) => call.arguments[0].targetCats[0] === 'codex',
        ).length,
        1,
        'handoff should run exactly once after user work finishes',
      );
    });

    it('rechecks user work after the async conflict-history read before dispatching deferred A2A', async () => {
      let resolveHistory;
      let signalHistoryStarted;
      const historyStarted = new Promise((resolve) => {
        signalHistoryStarted = resolve;
      });
      const historyResult = new Promise((resolve) => {
        resolveHistory = resolve;
      });
      const fairnessDeps = stubDeps({
        messageStore: {
          append: mock.fn(async (input) => ({ ...input, id: 'msg-stub' })),
          getById: mock.fn(async () => null),
          getByThreadAfter: mock.fn(async () => {
            signalHistoryStarted();
            return historyResult;
          }),
        },
      });
      const fairnessProcessor = new QueueProcessor(fairnessDeps);
      const handoffEntry = enqueueEntry(fairnessDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请接球',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aSourceUserMessageId: 'msg-user-1',
        a2aWaitedForQueuedUserMessages: true,
      });

      const autoExecute = fairnessProcessor.tryAutoExecute('t1');
      await historyStarted;
      enqueueEntry(fairnessDeps.queue, {
        userId: 'u1',
        source: 'user',
        content: '读取期间到达的新用户消息',
        targetCats: ['opus'],
      });
      resolveHistory([]);
      await autoExecute;
      await new Promise((resolve) => setTimeout(resolve, 40));

      assert.equal(fairnessDeps.invocationRecordStore.create.mock.calls.length, 0);
      assert.equal(
        fairnessDeps.queue.list('t1', 'u1').some((entry) => entry.id === handoffEntry.id),
        true,
      );
    });

    it('does not treat an ordinary queued-user supplement as an A2A replay conflict', async () => {
      const supplementDeps = stubDeps({
        messageStore: {
          append: mock.fn(async (input) => ({ ...input, id: 'msg-stub' })),
          getById: mock.fn(async () => null),
          getByThreadAfter: mock.fn(async () => [
            {
              id: 'msg-user-supplement',
              threadId: 't1',
              userId: 'u1',
              catId: null,
              content: '补充一份材料，继续按原方案处理',
              mentions: [],
              timestamp: Date.now(),
            },
          ]),
        },
      });
      const supplementProcessor = new QueueProcessor(supplementDeps);
      const entry = enqueueEntry(supplementDeps.queue, {
        userId: 'u1',
        source: 'agent',
        sourceCategory: 'a2a',
        content: '@codex 请继续原方案',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus-45',
        a2aTriggerMessageId: 'msg-agent-handoff',
        a2aSourceUserMessageId: 'msg-user-original',
        a2aWaitedForQueuedUserMessages: true,
      });
      supplementDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-agent-handoff');

      await supplementProcessor.tryAutoExecute('t1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      const createCalls = supplementDeps.invocationRecordStore.create.mock.calls.map((call) => call.arguments[0]);
      assert.equal(createCalls.filter((input) => input.targetCats[0] === 'codex').length, 1);
      assert.equal(
        createCalls.some((input) => input.targetCats[0] === 'opus-45'),
        false,
      );
      assert.equal(
        supplementDeps.messageStore.append.mock.calls.some(
          (call) => call.arguments[0].source?.connector === 'a2a-replay-conflict',
        ),
        false,
      );
    });

    it('enqueues text-scan A2A mentions as independent autoExecute work items', async () => {
      const previousProjectIds = process.env.CAT_CAFE_PROJECT_CONTEXT_IDS;
      const projectRoot = await mkdtemp(join(tmpdir(), 'queue-handoff-project-'));
      await mkdir(join(projectRoot, '.cat-cafe', 'projects', 'demo'), { recursive: true });
      await writeFile(join(projectRoot, '.cat-cafe', 'projects', 'demo', 'handoff-log.md'), '# demo — 交接日志\n');
      process.env.CAT_CAFE_PROJECT_CONTEXT_IDS = 'demo';
      const sourceTask = {
        id: 'task-source',
        threadId: 't1',
        sourceMessageId: 'msg-opus-handoff',
        status: 'doing',
        events: [],
      };
      const updatedTasks = [];
      const nestedDeps = stubDeps({
        projectRoot,
        taskStore: {
          listByThread: mock.fn(async () => [sourceTask]),
          update: mock.fn(async (_taskId, input) => {
            const updated = {
              ...sourceTask,
              events: [...sourceTask.events, ...(input.events ?? [])],
            };
            updatedTasks.push(updated);
            return updated;
          }),
        },
        router: {
          routeExecution: mock.fn(
            async function* (_userId, _content, _threadId, _messageId, targetCats, _intent, opts) {
              if (targetCats[0] === 'opus') {
                const enqueued = await opts.enqueueA2ATargets({
                  threadId: 't1',
                  userId: 'u1',
                  callerCatId: 'opus',
                  targetCats: ['pi', 'codex'],
                  content: '@Pi 做 A，@codex 做 B',
                  triggerMessageId: 'msg-opus-handoff',
                });
                assert.deepEqual(enqueued, ['pi', 'codex']);
              }
              yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
            },
          ),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const nestedProcessor = new QueueProcessor(nestedDeps);
      try {
        const entry = enqueueEntry(nestedDeps.queue, {
          userId: 'u1',
          source: 'agent',
          targetCats: ['opus'],
          autoExecute: true,
          callerCatId: 'claude',
        });
        nestedDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-root');

        await nestedProcessor.tryAutoExecute('t1');
        await waitForCondition(() => {
          const targets = nestedDeps.invocationRecordStore.create.mock.calls.map(
            (call) => call.arguments[0].targetCats[0],
          );
          return targets.includes('pi') && targets.includes('codex');
        });

        const createdTargets = nestedDeps.invocationRecordStore.create.mock.calls.map(
          (call) => call.arguments[0].targetCats[0],
        );
        assert.ok(createdTargets.includes('pi'), 'Pi should be started via queue-backed A2A');
        assert.ok(createdTargets.includes('codex'), 'Codex should be started via queue-backed A2A');
        assert.equal(updatedTasks.length, 2, 'each enqueued A2A target should append a handoff event');
        assert.deepEqual(
          updatedTasks.map((task) => task.events.at(-1).type),
          ['handoff', 'handoff'],
        );
        assert.deepEqual(
          updatedTasks.map((task) => task.events.at(-1).data.toCatId),
          ['pi', 'codex'],
        );
        const handoffLog = await readFile(
          join(projectRoot, '.cat-cafe', 'projects', 'demo', 'handoff-log.md'),
          'utf-8',
        );
        assert.ok(handoffLog.includes('**from**: opus'), 'handoff-log should include sender');
        assert.ok(handoffLog.includes('**to**: pi'), 'handoff-log should include first target');
        assert.ok(handoffLog.includes('**to**: codex'), 'handoff-log should include second target');
        assert.ok(handoffLog.includes('**状态**: doing'), 'handoff-log should include source task status');
        assert.ok(handoffLog.includes('@Pi 做 A，@codex 做 B'), 'handoff-log should include handoff summary');
      } finally {
        if (previousProjectIds === undefined) {
          delete process.env.CAT_CAFE_PROJECT_CONTEXT_IDS;
        } else {
          process.env.CAT_CAFE_PROJECT_CONTEXT_IDS = previousProjectIds;
        }
        await rm(projectRoot, { recursive: true, force: true });
      }
    });

    it('appends artifact task event with git diff stats after successful execution', async () => {
      const sourceTask = {
        id: 'task-source',
        threadId: 't1',
        sourceMessageId: 'msg-task',
        events: [],
      };
      const snapshots = [
        { files: [], totalAdded: 0, totalRemoved: 0 },
        {
          files: [{ path: 'packages/api/src/index.ts', added: 4, removed: 2 }],
          totalAdded: 4,
          totalRemoved: 2,
        },
      ];
      const updatedTasks = [];
      const artifactDeps = stubDeps({
        messageStore: {
          append: mock.fn(async () => ({ id: 'msg-stub' })),
          getById: mock.fn(async () => null),
          markDelivered: mock.fn(async () => null),
        },
        gitArtifactCollector: mock.fn(async () => snapshots.shift() ?? snapshots.at(-1)),
        taskStore: {
          listByThread: mock.fn(async () => [sourceTask]),
          update: mock.fn(async (_taskId, input) => {
            const updated = {
              ...sourceTask,
              events: [...sourceTask.events, ...(input.events ?? [])],
            };
            updatedTasks.push(updated);
            return updated;
          }),
        },
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'done', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const artifactProcessor = new QueueProcessor(artifactDeps);
      const entry = enqueueEntry(artifactDeps.queue, {
        userId: 'u1',
        targetCats: ['opus'],
      });
      artifactDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-task');

      await artifactProcessor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(updatedTasks.length, 1);
      const event = updatedTasks[0].events.at(-1);
      assert.equal(event.type, 'artifact');
      assert.equal(event.catId, 'opus');
      assert.deepEqual(event.data.files, [{ path: 'packages/api/src/index.ts', added: 4, removed: 2 }]);
      assert.equal(event.data.totalAdded, 4);
      assert.equal(event.data.totalRemoved, 2);
      assert.equal(artifactDeps.socketManager.broadcastToRoom.mock.calls.at(-1).arguments[1], 'task_updated');
    });

    it('appends usage task event with estimated token cost after successful execution', async () => {
      const sourceTask = {
        id: 'task-source',
        threadId: 't1',
        taskThreadId: 't1',
        events: [],
      };
      const updatedTasks = [];
      const usageDeps = stubDeps({
        gitArtifactCollector: mock.fn(async () => ({ files: [], totalAdded: 0, totalRemoved: 0 })),
        taskStore: {
          listByThread: mock.fn(async () => [sourceTask]),
          update: mock.fn(async (_taskId, input) => {
            const previous = updatedTasks.at(-1) ?? sourceTask;
            const updated = {
              ...sourceTask,
              events: [...previous.events, ...(input.events ?? [])],
            };
            updatedTasks.push(updated);
            return updated;
          }),
        },
        router: {
          routeExecution: mock.fn(async function* () {
            yield {
              type: 'text',
              catId: 'opus',
              content: 'done',
              timestamp: Date.now(),
              metadata: {
                provider: 'openai',
                model: 'gpt-4o-mini',
                usage: {
                  inputTokens: 1000,
                  outputTokens: 500,
                  cacheReadTokens: 300,
                  durationMs: 1234,
                  historyMode: 'observe',
                  historyFullTokens: 12_000,
                  historyBudgetRatio: 0.6,
                  historyGovernanceDegraded: false,
                  deliveryOnlyMode: 'degraded',
                  deliveryOnlyDegradedIssue: 'missing_summary',
                  sourceBreakdown: {
                    totalEstimatedTokens: 1000,
                    sources: [
                      { source: 'history', chars: 2400, estimatedTokens: 600 },
                      { source: 'rules', chars: 1600, estimatedTokens: 400 },
                    ],
                  },
                },
              },
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const usageProcessor = new QueueProcessor(usageDeps);
      enqueueEntry(usageDeps.queue, {
        userId: 'u1',
        targetCats: ['opus'],
      });

      await usageProcessor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(updatedTasks.length, 1);
      const event = updatedTasks[0].events.at(-1);
      assert.equal(event.type, 'usage');
      assert.equal(event.catId, 'opus');
      assert.equal(event.data.provider, 'openai');
      assert.equal(event.data.model, 'gpt-4o-mini');
      assert.equal(event.data.inputTokens, 1000);
      assert.equal(event.data.outputTokens, 500);
      assert.equal(event.data.totalTokens, 1500);
      assert.equal(event.data.cacheReadTokens, 300);
      assert.equal(event.data.durationMs, 1234);
      assert.equal(event.data.historyMode, 'observe');
      assert.equal(event.data.historyFullTokens, 12_000);
      assert.equal(event.data.historyBudgetRatio, 0.6);
      assert.equal(event.data.historyGovernanceDegraded, false);
      assert.equal(event.data.deliveryOnlyMode, 'degraded');
      assert.equal(event.data.deliveryOnlyDegradedIssue, 'missing_summary');
      assert.deepEqual(event.data.sourceBreakdown, {
        totalEstimatedTokens: 1000,
        sources: [
          { source: 'history', chars: 2400, estimatedTokens: 600 },
          { source: 'rules', chars: 1600, estimatedTokens: 400 },
        ],
      });
      assert.ok(Math.abs(event.data.costUsd - 0.00045) < 1e-10);
      assert.equal(usageDeps.socketManager.broadcastToRoom.mock.calls.at(-1).arguments[1], 'task_updated');
      const succeededUpdate = usageDeps.invocationRecordStore.update.mock.calls
        .map((call) => call.arguments[1])
        .find((input) => input.status === 'succeeded');
      assert.equal(succeededUpdate.usageByCat.opus.deliveryOnlyMode, 'degraded');
      assert.equal(succeededUpdate.usageByCat.opus.deliveryOnlyDegradedIssue, 'missing_summary');
    });

    it('preserves diagnostic-only deliveryOnly usage with zero provider tokens', async () => {
      const sourceTask = { id: 'task-source', threadId: 't1', taskThreadId: 't1', events: [] };
      const updatedTasks = [];
      const usageDeps = stubDeps({
        gitArtifactCollector: mock.fn(async () => ({ files: [], totalAdded: 0, totalRemoved: 0 })),
        taskStore: {
          listByThread: mock.fn(async () => [sourceTask]),
          update: mock.fn(async (_taskId, input) => {
            const updated = { ...sourceTask, events: [...(input.events ?? [])] };
            updatedTasks.push(updated);
            return updated;
          }),
        },
        router: {
          routeExecution: mock.fn(async function* () {
            yield {
              type: 'text',
              catId: 'opus',
              content: 'done',
              timestamp: Date.now(),
              metadata: {
                provider: 'openai',
                model: 'gpt-4o-mini',
                usage: {
                  deliveryOnlyMode: 'degraded',
                  deliveryOnlyDegradedIssue: 'missing_summary',
                },
              },
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const usageProcessor = new QueueProcessor(usageDeps);
      enqueueEntry(usageDeps.queue, { userId: 'u1', targetCats: ['opus'] });

      await usageProcessor.processNext('t1', 'u1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      const event = updatedTasks[0].events[0];
      assert.equal(event.type, 'usage');
      assert.equal(event.data.totalTokens, 0);
      assert.equal(event.data.deliveryOnlyMode, 'degraded');
      assert.equal(event.data.deliveryOnlyDegradedIssue, 'missing_summary');
      const succeededUpdate = usageDeps.invocationRecordStore.update.mock.calls
        .map((call) => call.arguments[1])
        .find((input) => input.status === 'succeeded');
      assert.equal(succeededUpdate.usageByCat.opus.deliveryOnlyMode, 'degraded');
    });

    it('marks a provider error event failed and preserves usage in the InvocationRecord', async () => {
      const providerErrorDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield {
              type: 'error',
              catId: 'opus',
              error: 'Provider timeout while waiting for response body',
              metadata: {
                provider: 'catagent',
                model: 'claude-opus-4',
                usage: { inputTokens: 654, outputTokens: 0, cacheReadTokens: 222 },
              },
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const providerErrorProcessor = new QueueProcessor(providerErrorDeps);
      enqueueEntry(providerErrorDeps.queue, { userId: 'u1', targetCats: ['opus'] });

      await providerErrorProcessor.processNext('t1', 'u1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      const terminalUpdates = providerErrorDeps.invocationRecordStore.update.mock.calls.map(
        (call) => call.arguments[1],
      );
      assert.equal(
        terminalUpdates.some((input) => input.status === 'succeeded'),
        false,
        'provider error must never converge to succeeded',
      );
      const failedUpdate = terminalUpdates.find((input) => input.status === 'failed');
      assert.ok(failedUpdate, 'provider error must converge to failed');
      assert.equal(failedUpdate.error, 'Provider timeout while waiting for response body');
      assert.deepEqual(failedUpdate.usageByCat, {
        opus: { inputTokens: 654, outputTokens: 0, cacheReadTokens: 222 },
      });
    });

    it('persistence failure outranks a normal done and preserves usage in the InvocationRecord', async () => {
      const streamLifecycle = [];
      const streamingHook = {
        onStreamStart: mock.fn(async () => {
          streamLifecycle.push('start:begin');
          await new Promise((resolve) => setTimeout(resolve, 20));
          streamLifecycle.push('start:end');
        }),
        onStreamFailure: mock.fn(async () => {
          streamLifecycle.push('failure');
        }),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };
      const persistenceDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (...args) {
            const routeOptions = args[6];
            routeOptions.persistenceContext.failed = true;
            routeOptions.persistenceContext.errors.push({
              catId: 'opus',
              error: 'assistant message append failed',
            });
            yield {
              type: 'text',
              catId: 'opus',
              content: 'answer generated but not persisted',
              metadata: {
                provider: 'catagent',
                model: 'claude-opus-4',
                usage: { inputTokens: 321, outputTokens: 45 },
              },
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        streamingHook,
      });
      const persistenceProcessor = new QueueProcessor(persistenceDeps);
      enqueueEntry(persistenceDeps.queue, { userId: 'u1', targetCats: ['opus'] });

      await persistenceProcessor.processNext('t1', 'u1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      const terminalUpdates = persistenceDeps.invocationRecordStore.update.mock.calls.map((call) => call.arguments[1]);
      assert.equal(
        terminalUpdates.some((input) => input.status === 'succeeded'),
        false,
      );
      const failedUpdate = terminalUpdates.find((input) => input.status === 'failed');
      assert.ok(failedUpdate, 'persistence failure must converge to failed');
      assert.equal(failedUpdate.error, 'persistence_failure: opus: assistant message append failed');
      assert.deepEqual(failedUpdate.usageByCat, {
        opus: { inputTokens: 321, outputTokens: 45 },
      });
      assert.equal(streamingHook.onStreamFailure.mock.calls.length, 1);
      assert.deepEqual(streamingHook.onStreamFailure.mock.calls[0].arguments, [
        't1',
        'persistence_failure: opus: assistant message append failed',
        'inv-stub',
      ]);
      assert.deepEqual(streamLifecycle, ['start:begin', 'start:end', 'failure']);
      assert.equal(streamingHook.onStreamEnd.mock.calls.length, 0);
    });

    it('persistence failure outranks a simultaneous provider terminal error', async () => {
      const persistenceDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (...args) {
            const routeOptions = args[6];
            routeOptions.persistenceContext.failed = true;
            routeOptions.persistenceContext.errors.push({
              catId: 'opus',
              error: 'assistant message append failed',
            });
            yield {
              type: 'error',
              catId: 'opus',
              error: 'Provider timeout while waiting for response body',
              metadata: {
                provider: 'catagent',
                model: 'claude-opus-4',
                usage: { inputTokens: 654, outputTokens: 0 },
              },
              timestamp: Date.now(),
            };
            yield {
              type: 'done',
              catId: 'opus',
              errorCode: 'provider_timeout',
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const persistenceProcessor = new QueueProcessor(persistenceDeps);
      enqueueEntry(persistenceDeps.queue, { userId: 'u1', targetCats: ['opus'] });

      await persistenceProcessor.processNext('t1', 'u1');
      await new Promise((resolve) => setTimeout(resolve, 80));

      const terminalUpdates = persistenceDeps.invocationRecordStore.update.mock.calls.map((call) => call.arguments[1]);
      assert.equal(
        terminalUpdates.some((input) => input.status === 'succeeded'),
        false,
      );
      const failedUpdate = terminalUpdates.find((input) => input.status === 'failed');
      assert.ok(failedUpdate, 'persistence failure must converge to failed');
      assert.equal(failedUpdate.error, 'persistence_failure: opus: assistant message append failed');
      assert.deepEqual(failedUpdate.usageByCat, {
        opus: { inputTokens: 654, outputTokens: 0 },
      });
    });
  });

  // ── Tracker guard: prevent duplicate execution for CLI-active cats ──

  describe('tracker guard on completion chain (tryExecuteNextAcrossUsers)', () => {
    it('does NOT start queued entry when target cat has active CLI invocation', async () => {
      // Simulate: opus is running via CLI (tracked in invocationTracker but NOT in processingSlots)
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      // invocationTracker reports opus is active (CLI invocation)
      deps.invocationTracker.has = mock.fn((_tid, catId) => catId === 'opus');

      // codex completes → triggers tryExecuteNextAcrossUsers which finds the opus entry
      await processor.onInvocationComplete('t1', 'codex', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // executeEntry must NOT have been called
      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'must not call executeEntry (tracker.start not called)',
      );
      assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'must not call routeExecution');

      // Entry must be rolled back to queued (not stuck as processing)
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 1);
      assert.equal(queue[0].status, 'queued', 'entry must rollback to queued');
    });
  });

  describe('tracker guard on processNext (tryExecuteNextForUser)', () => {
    it('does NOT start queued entry when target cat has active CLI invocation', async () => {
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      // invocationTracker reports opus is active (CLI invocation)
      deps.invocationTracker.has = mock.fn((_tid, catId) => catId === 'opus');

      const result = await processor.processNext('t1', 'u1');

      assert.equal(result.started, false, 'must not start when tracker has active invocation');
      // executeEntry must NOT have been called
      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'must not call executeEntry (tracker.start not called)',
      );
      assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'must not call routeExecution');

      // Entry must still be queued (never marked processing since guard fires before markProcessing)
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 1);
      assert.equal(queue[0].status, 'queued', 'entry must remain queued');
    });

    it('skips active tracker cat and starts next queued entry for an idle cat', async () => {
      const opusEntry = enqueueEntry(deps.queue, { content: 'opus queued', targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', opusEntry.id, 'msg-opus');
      const codexEntry = enqueueEntry(deps.queue, { content: 'codex queued', targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', codexEntry.id, 'msg-codex');

      deps.invocationTracker.has = mock.fn((_tid, catId) => catId === 'opus');

      const result = await processor.processNext('t1', 'u1');

      assert.equal(result.started, true, 'idle codex should start even when older opus entry is blocked');
      assert.deepEqual(result.entry?.targetCats, ['codex']);
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(
        queue.find((entry) => entry.id === opusEntry.id)?.status,
        'queued',
        'blocked opus entry should remain queued',
      );
    });
  });

  // ── F088 fix: OutboundDeliveryHook regression tests ──

  describe('outbound delivery via QueueProcessor (F088)', () => {
    /** Poll until predicate returns true or timeout (deterministic, no fixed sleeps). */
    async function waitFor(predicate, timeoutMs = 5000, intervalMs = 10) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }

    it('single-cat execution: outboundHook.deliver called once with correct catId + content', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId, richBlocks, threadMeta) => {
          deliverCalls.push({ threadId, content, catId, richBlocks, threadMeta });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };
      const threadMetaLookup = mock.fn(async () => ({
        threadShortId: 't1-short',
        threadTitle: 'Test Thread',
        deepLinkUrl: 'https://example.com/threads/t1',
      }));

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Hello from opus', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup,
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls.length, 1, 'deliver should be called once for single-cat execution');
      assert.equal(deliverCalls[0].threadId, 't1');
      assert.equal(deliverCalls[0].catId, 'opus');
      assert.equal(deliverCalls[0].content, 'Hello from opus');
      assert.ok(deliverCalls[0].threadMeta, 'threadMeta should be provided');
      assert.equal(deliverCalls[0].threadMeta.threadTitle, 'Test Thread');

      assert.ok(streamingHook.onStreamStart.mock.calls.length >= 1, 'onStreamStart should be called');
      assert.ok(streamingHook.onStreamEnd.mock.calls.length >= 1, 'onStreamEnd should be called');

      await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);
      assert.ok(
        streamingHook.cleanupPlaceholders.mock.calls.length >= 1,
        'cleanupPlaceholders should be called on successful delivery',
      );
    });

    it('replace-mode text overwrites server-side aggregated outbound and streaming content', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: '第一段。第二段。', timestamp: Date.now() };
            yield {
              type: 'text',
              catId: 'opus',
              content: '第一段。插入一句。第二段。',
              textMode: 'replace',
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls[0].content, '第一段。插入一句。第二段。');
      const lastChunkCall = streamingHook.onStreamChunk.mock.calls.at(-1);
      assert.ok(lastChunkCall, 'streaming hook should receive chunks');
      assert.equal(lastChunkCall.arguments[1], '第一段。插入一句。第二段。');
      const endCall = streamingHook.onStreamEnd.mock.calls.at(-1);
      assert.ok(endCall, 'streaming hook should receive final end');
      assert.equal(endCall.arguments[1], '第一段。插入一句。第二段。');
    });

    it('complete-message delivery flag buffers text chunks and broadcasts one final text message', async () => {
      const previous = process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY;
      process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY = '1';
      try {
        const hookDeps = stubDeps({
          router: {
            routeExecution: mock.fn(async function* () {
              yield { type: 'text', catId: 'opus', content: '第一段。', timestamp: 1000 };
              yield { type: 'text', catId: 'opus', content: '第二段。', timestamp: 1001 };
              yield { type: 'done', catId: 'opus', timestamp: 1002 };
            }),
            ackCollectedCursors: mock.fn(async () => {}),
          },
          threadMetaLookup: mock.fn(async () => undefined),
        });
        const hookProcessor = new QueueProcessor(hookDeps);

        const entry = enqueueEntry(hookDeps.queue);
        hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

        await hookProcessor.processNext('t1', 'u1');
        await waitFor(() => hookDeps.socketManager.broadcastAgentMessage.mock.calls.length >= 2);

        const agentMessages = hookDeps.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
        const textMessages = agentMessages.filter((msg) => msg.type === 'text');
        const doneMessages = agentMessages.filter((msg) => msg.type === 'done');

        assert.equal(textMessages.length, 1, 'should not broadcast intermediate text chunks');
        assert.equal(textMessages[0].content, '第一段。第二段。');
        assert.equal(textMessages[0].textMode, 'replace');
        assert.equal(textMessages[0].origin, 'stream');
        assert.equal(doneMessages.length, 1, 'done lifecycle event should still be broadcast');
        assert.ok(
          agentMessages.indexOf(textMessages[0]) < agentMessages.indexOf(doneMessages[0]),
          'final text should arrive before done so the UI can finalize it immediately',
        );
      } finally {
        if (previous === undefined) {
          delete process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY;
        } else {
          process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY = previous;
        }
      }
    });

    it('provider terminal error marks the queued invocation failed without delivering partial text as completed', async () => {
      const previous = process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY;
      process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY = '1';
      try {
        const outboundHook = { deliver: mock.fn(async () => {}) };
        const streamingHook = {
          onStreamStart: mock.fn(async () => {}),
          onStreamChunk: mock.fn(async () => {}),
          onStreamEnd: mock.fn(async () => {}),
          onStreamFailure: mock.fn(async () => {}),
          cleanupPlaceholders: mock.fn(async () => {}),
        };
        const hookDeps = stubDeps({
          router: {
            routeExecution: mock.fn(async function* () {
              yield { type: 'text', catId: 'grok', content: '收到，开始执行。', timestamp: 1000 };
              yield {
                type: 'error',
                catId: 'grok',
                error: 'Grok 终端工具权限未获批准，本轮未完成。',
                errorCode: 'permission_cancelled',
                timestamp: 1001,
              };
              yield {
                type: 'done',
                catId: 'grok',
                errorCode: 'permission_cancelled',
                timestamp: 1002,
              };
            }),
            ackCollectedCursors: mock.fn(async () => {}),
          },
          outboundHook,
          streamingHook,
          threadMetaLookup: mock.fn(async () => undefined),
        });
        const hookProcessor = new QueueProcessor(hookDeps);
        const entry = enqueueEntry(hookDeps.queue, { targetCats: ['grok'] });
        hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

        await hookProcessor.processNext('t1', 'u1');
        await waitFor(() =>
          hookDeps.invocationRecordStore.update.mock.calls.some((call) => call.arguments[1]?.status === 'failed'),
        );

        const failedUpdate = hookDeps.invocationRecordStore.update.mock.calls.find(
          (call) => call.arguments[1]?.status === 'failed',
        );
        assert.equal(
          failedUpdate.arguments[1].error,
          'permission_cancelled: Grok 终端工具权限未获批准，本轮未完成。',
          'structured code must stay authoritative without duplicate prefixes',
        );
        assert.equal(
          hookDeps.invocationRecordStore.update.mock.calls.some((call) => call.arguments[1]?.status === 'succeeded'),
          false,
        );
        assert.equal(outboundHook.deliver.mock.calls.length, 0, 'partial text must not be delivered as a final reply');
        assert.equal(streamingHook.onStreamFailure.mock.calls.length, 1);
        assert.deepEqual(streamingHook.onStreamFailure.mock.calls[0].arguments, [
          't1',
          'Grok 终端工具权限未获批准，本轮未完成。',
          'inv-stub',
        ]);
        assert.equal(streamingHook.onStreamEnd.mock.calls.length, 0);

        const broadcasts = hookDeps.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
        assert.ok(
          broadcasts.some((message) => message.type === 'error' && message.errorCode === 'permission_cancelled'),
        );
        assert.equal(
          broadcasts.some((message) => message.type === 'text' && message.textMode === 'replace'),
          false,
          'failed turn must not receive a completed replacement text',
        );
      } finally {
        if (previous === undefined) {
          delete process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY;
        } else {
          process.env.CAT_CAFE_COMPLETE_MESSAGE_DELIVERY = previous;
        }
      }
    });

    it('non-terminal error.errorCode does not fail a provider turn that later completes', async () => {
      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield {
              type: 'error',
              catId: 'antigravity',
              error: 'One tool call failed; continuing.',
              errorCode: 'tool_error',
              timestamp: 1001,
            };
            yield { type: 'text', catId: 'antigravity', content: 'Recovered answer', timestamp: 1002 };
            yield { type: 'done', catId: 'antigravity', timestamp: 1003 };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const hookProcessor = new QueueProcessor(hookDeps);
      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['antigravity'] });
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() =>
        hookDeps.invocationRecordStore.update.mock.calls.some((call) => call.arguments[1]?.status === 'succeeded'),
      );

      assert.equal(
        hookDeps.invocationRecordStore.update.mock.calls.some((call) => call.arguments[1]?.status === 'failed'),
        false,
      );
    });

    it('codex output gate defaults on and broadcasts sanitized final answer only', async () => {
      const previous = process.env.CAT_CAFE_CODEX_OUTPUT_GATE;
      delete process.env.CAT_CAFE_CODEX_OUTPUT_GATE;
      try {
        const hookDeps = stubDeps({
          router: {
            routeExecution: mock.fn(async function* () {
              yield {
                type: 'text',
                catId: 'gpt52',
                content: '**🔍 我开始做指南**\n\n我现在认领当前消息，再并行读源文件和目标目录。\n\n',
                timestamp: 1000,
              };
              yield {
                type: 'text',
                catId: 'gpt52',
                content: '**✅ 已完成**\n\n交付：已修复输出闸门。\n\n**验证证据**\n\n- 单测通过',
                timestamp: 1001,
              };
              yield { type: 'done', catId: 'gpt52', timestamp: 1002 };
            }),
            ackCollectedCursors: mock.fn(async () => {}),
          },
          threadMetaLookup: mock.fn(async () => undefined),
        });
        const hookProcessor = new QueueProcessor(hookDeps);

        const entry = enqueueEntry(hookDeps.queue, { targetCats: ['gpt52'] });
        hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

        await hookProcessor.processNext('t1', 'u1');
        await waitFor(() => hookDeps.socketManager.broadcastAgentMessage.mock.calls.length >= 2);

        const agentMessages = hookDeps.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
        const textMessages = agentMessages.filter((msg) => msg.type === 'text');
        const doneMessages = agentMessages.filter((msg) => msg.type === 'done');
        const roomEvents = hookDeps.socketManager.broadcastToRoom.mock.calls.map((call) => call.arguments[1]);

        assert.equal(textMessages.length, 1, 'codex gate should not broadcast intermediate text chunks');
        assert.ok(textMessages[0].content.includes('**✅ 已完成**'));
        assert.ok(textMessages[0].content.includes('交付：已修复输出闸门。'));
        assert.ok(!textMessages[0].content.includes('我开始做指南'));
        assert.ok(!textMessages[0].content.includes('我现在认领当前消息'));
        assert.equal(doneMessages.length, 1, 'done lifecycle event should still be broadcast');
        assert.ok(roomEvents.includes('spawn_started'), 'liveness signal should still be visible while buffered');
      } finally {
        if (previous === undefined) {
          delete process.env.CAT_CAFE_CODEX_OUTPUT_GATE;
        } else {
          process.env.CAT_CAFE_CODEX_OUTPUT_GATE = previous;
        }
      }
    });

    it('codex output gate can be disabled explicitly for emergency rollback', async () => {
      const previous = process.env.CAT_CAFE_CODEX_OUTPUT_GATE;
      process.env.CAT_CAFE_CODEX_OUTPUT_GATE = '0';
      try {
        const hookDeps = stubDeps({
          router: {
            routeExecution: mock.fn(async function* () {
              yield {
                type: 'text',
                catId: 'gpt52',
                content: '**🔍 我开始做指南**\n\n我现在认领当前消息。\n\n',
                timestamp: 1000,
              };
              yield {
                type: 'text',
                catId: 'gpt52',
                content: '**✅ 已完成**\n\n交付：输出闸门可回退。',
                timestamp: 1001,
              };
              yield { type: 'done', catId: 'gpt52', timestamp: 1002 };
            }),
            ackCollectedCursors: mock.fn(async () => {}),
          },
          threadMetaLookup: mock.fn(async () => undefined),
        });
        const hookProcessor = new QueueProcessor(hookDeps);

        const entry = enqueueEntry(hookDeps.queue, { targetCats: ['gpt52'] });
        hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-rollback');

        await hookProcessor.processNext('t1', 'u1');
        await waitFor(() => hookDeps.socketManager.broadcastAgentMessage.mock.calls.length >= 3);

        const agentMessages = hookDeps.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
        const textMessages = agentMessages.filter((msg) => msg.type === 'text');

        assert.equal(textMessages.length, 2, 'explicit rollback should restore raw streaming chunks');
        assert.ok(textMessages[0].content.includes('我开始做指南'));
        assert.ok(textMessages[1].content.includes('交付：输出闸门可回退。'));
      } finally {
        if (previous === undefined) {
          delete process.env.CAT_CAFE_CODEX_OUTPUT_GATE;
        } else {
          process.env.CAT_CAFE_CODEX_OUTPUT_GATE = previous;
        }
      }
    });

    it('codex output gate does not change non-codex streaming behavior', async () => {
      const previous = process.env.CAT_CAFE_CODEX_OUTPUT_GATE;
      process.env.CAT_CAFE_CODEX_OUTPUT_GATE = '1';
      try {
        const hookDeps = stubDeps({
          router: {
            routeExecution: mock.fn(async function* () {
              yield { type: 'text', catId: 'opus', content: '第一段。', timestamp: 1000 };
              yield { type: 'text', catId: 'opus', content: '第二段。', timestamp: 1001 };
              yield { type: 'done', catId: 'opus', timestamp: 1002 };
            }),
            ackCollectedCursors: mock.fn(async () => {}),
          },
          threadMetaLookup: mock.fn(async () => undefined),
        });
        const hookProcessor = new QueueProcessor(hookDeps);

        const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });
        hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

        await hookProcessor.processNext('t1', 'u1');
        await waitFor(() => hookDeps.socketManager.broadcastAgentMessage.mock.calls.length >= 3);

        const agentMessages = hookDeps.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
        const textMessages = agentMessages.filter((msg) => msg.type === 'text');

        assert.equal(textMessages.length, 2, 'non-codex cats should still stream text chunks normally');
        assert.equal(textMessages[0].content, '第一段。');
        assert.equal(textMessages[1].content, '第二段。');
      } finally {
        if (previous === undefined) {
          delete process.env.CAT_CAFE_CODEX_OUTPUT_GATE;
        } else {
          process.env.CAT_CAFE_CODEX_OUTPUT_GATE = previous;
        }
      }
    });

    it('agent output gate defaults on for claude/gemini/kimi/grok targets and preserves lifecycle broadcasts', async () => {
      const previous = process.env.CAT_CAFE_AGENT_OUTPUT_GATE;
      delete process.env.CAT_CAFE_AGENT_OUTPUT_GATE;
      try {
        for (const catId of ['opus', 'gemini', 'kimi', 'grok']) {
          const hookDeps = stubDeps({
            router: {
              routeExecution: mock.fn(async function* () {
                yield {
                  type: 'text',
                  catId,
                  content: '**🔍 我先取上下文**\n\n我正在读取目录并准备执行。\n\n',
                  timestamp: 1000,
                };
                yield {
                  type: 'text',
                  catId,
                  content: '**✅ 已完成**\n\n交付：输出闸门已覆盖该 runtime。',
                  timestamp: 1001,
                };
                yield { type: 'done', catId, timestamp: 1002 };
              }),
              ackCollectedCursors: mock.fn(async () => {}),
            },
            threadMetaLookup: mock.fn(async () => undefined),
          });
          const hookProcessor = new QueueProcessor(hookDeps);

          const entry = enqueueEntry(hookDeps.queue, { targetCats: [catId] });
          hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, `msg-${catId}`);

          await hookProcessor.processNext('t1', 'u1');
          await waitFor(() => hookDeps.socketManager.broadcastAgentMessage.mock.calls.length >= 2);

          const agentMessages = hookDeps.socketManager.broadcastAgentMessage.mock.calls.map(
            (call) => call.arguments[0],
          );
          const textMessages = agentMessages.filter((msg) => msg.type === 'text');
          const doneMessages = agentMessages.filter((msg) => msg.type === 'done');
          const roomEvents = hookDeps.socketManager.broadcastToRoom.mock.calls.map((call) => call.arguments[1]);

          assert.equal(textMessages.length, 1, `${catId} should not broadcast intermediate text chunks`);
          assert.ok(textMessages[0].content.includes('**✅ 已完成**'));
          assert.ok(textMessages[0].content.includes('交付：输出闸门已覆盖该 runtime。'));
          assert.ok(!textMessages[0].content.includes('我先取上下文'));
          assert.equal(doneMessages.length, 1, `${catId} done lifecycle event should still be broadcast`);
          assert.ok(roomEvents.includes('spawn_started'), `${catId} liveness signal should still be visible`);
        }
      } finally {
        if (previous === undefined) {
          delete process.env.CAT_CAFE_AGENT_OUTPUT_GATE;
        } else {
          process.env.CAT_CAFE_AGENT_OUTPUT_GATE = previous;
        }
      }
    });

    it('multi-cat execution: outboundHook.deliver called per-turn with each catId', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId, richBlocks, threadMeta) => {
          deliverCalls.push({ threadId, content, catId, richBlocks, threadMeta });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Opus says hi. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Codex chimes in.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 2);

      assert.equal(deliverCalls.length, 2, 'deliver should be called once per cat turn');
      assert.equal(deliverCalls[0].catId, 'opus', 'first deliver should be for opus');
      assert.equal(deliverCalls[0].content, 'Opus says hi. ', 'opus content should match');
      assert.equal(deliverCalls[1].catId, 'codex', 'second deliver should be for codex');
      assert.equal(deliverCalls[1].content, 'Codex chimes in.', 'codex content should match');
    });

    it('BUG-5: multi-turn delivers per-turn (no merge needed, token reusable)', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Opus says hi. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Codex chimes in.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 2);

      assert.equal(deliverCalls.length, 2, 'Multi-turn delivers per-turn');
      assert.strictEqual(deliverCalls[0].catId, 'opus');
      assert.ok(deliverCalls[0].content.includes('Opus says hi.'));
      assert.strictEqual(deliverCalls[1].catId, 'codex');
      assert.ok(deliverCalls[1].content.includes('Codex chimes in.'));
    });

    it('no outboundHook: execution completes normally without delivery', async () => {
      const entry = enqueueEntry(deps.queue);
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await processor.processNext('t1', 'u1');
      await waitFor(() =>
        deps.invocationRecordStore.update.mock.calls.some((c) => c.arguments[1]?.status === 'succeeded'),
      );

      const updateCalls = deps.invocationRecordStore.update.mock.calls;
      const succeededUpdate = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
      assert.ok(succeededUpdate, 'should succeed even without outboundHook');
    });

    it('delivery failure: cleanupPlaceholders NOT called when delivery partially fails', async () => {
      // F151: mid-loop delivery retries failed turns in the final phase,
      // so use catId-based failure to ensure opus consistently fails.
      const outboundHook = {
        deliver: mock.fn(async (_threadId, _content, catId) => {
          if (catId === 'opus') throw new Error('delivery failed');
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Turn 1. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Turn 2.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      // F151: mid-loop delivers both, opus fails and retries in final phase = 3 calls total
      await waitFor(() => outboundHook.deliver.mock.calls.length >= 3);

      assert.equal(outboundHook.deliver.mock.calls.length, 3, 'mid-loop (2) + final-phase retry (1)');

      // One rejection → Promise.allSettled sees mixed results → cleanupPlaceholders skipped
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(
        streamingHook.cleanupPlaceholders.mock.calls.length,
        0,
        'cleanupPlaceholders should NOT be called when delivery partially fails',
      );
    });

    it('all deliveries succeed: cleanupPlaceholders called', async () => {
      const outboundHook = {
        deliver: mock.fn(async () => {}),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Success text', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);

      assert.equal(outboundHook.deliver.mock.calls.length, 1, 'deliver called once');
      assert.ok(
        streamingHook.cleanupPlaceholders.mock.calls.length >= 1,
        'cleanupPlaceholders should be called when all deliveries succeed',
      );
    });

    it('freshness hold skips normal outbound and marks only the matching placeholder held', async () => {
      const outboundHook = {
        deliver: mock.fn(async () => {}),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        onStreamHold: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };
      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (...args) {
            const routeOpts = args[6];
            routeOpts.persistenceContext.egressByCat = {
              opus: {
                disposition: 'held',
                holdId: 'hold-queue-1',
                observedWatermark: '3',
                unseenMessageIds: ['new-user-message'],
              },
            };
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({ type: 'freshness_hold', holdId: 'hold-queue-1' }),
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);
      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-held');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => streamingHook.onStreamHold.mock.calls.length >= 1);

      assert.equal(outboundHook.deliver.mock.calls.length, 0);
      assert.equal(streamingHook.onStreamEnd.mock.calls.length, 0);
      assert.equal(streamingHook.cleanupPlaceholders.mock.calls.length, 0);
      assert.deepEqual(streamingHook.onStreamHold.mock.calls[0].arguments, ['t1', 'inv-stub']);
    });

    it('outboundHook set via late-bind setOutboundHook: deliver is called', async () => {
      const lateDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Late-bound delivery', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const lateProcessor = new QueueProcessor(lateDeps);

      const deliverCalls = [];
      lateProcessor.setOutboundHook({
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      });

      const entry = enqueueEntry(lateDeps.queue);
      lateDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await lateProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls.length, 1, 'late-bound hook should be called');
      assert.equal(deliverCalls[0].content, 'Late-bound delivery');
    });

    it('P2-1 regression: failed invocation still triggers notifyDeliveryBatchDone', async () => {
      const batchDoneCalls = [];
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        notifyDeliveryBatchDone: mock.fn(async (threadId, chainDone) => {
          batchDoneCalls.push({ threadId, chainDone });
        }),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('invocation crashed');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => batchDoneCalls.length >= 1);

      assert.equal(batchDoneCalls.length, 1, 'notifyDeliveryBatchDone must fire on failure');
      assert.equal(batchDoneCalls[0].threadId, 't1');
      assert.equal(batchDoneCalls[0].chainDone, true, 'single invocation failure → chainDone=true');
    });

    it('P3-P2: reject callback (executeEntry throws in finally) still triggers notifyDeliveryBatchDone', async () => {
      const batchDoneCalls = [];
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        notifyDeliveryBatchDone: mock.fn(async (threadId, chainDone) => {
          batchDoneCalls.push({ threadId, chainDone });
        }),
      };

      // Make invocationTracker.complete throw in finally block → executeEntry rejects
      const hookDeps = stubDeps({
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          complete: mock.fn(() => {
            throw new Error('tracker.complete crashed');
          }),
          has: mock.fn(() => false),
        },
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);
      hookDeps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => batchDoneCalls.length >= 1);

      assert.equal(batchDoneCalls.length, 1, 'reject callback must also fire notifyDeliveryBatchDone');
      assert.equal(batchDoneCalls[0].threadId, 't1');
    });
  });

  // ── F175 Task 5: user-message batching at dequeue ──

  describe('user-message batching (F175)', () => {
    async function waitForQueue(queue, threadId, userId, predicate, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate(queue.list(threadId, userId))) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`waitForQueue timed out after ${timeoutMs}ms`);
    }

    it('combines adjacent user entries into single routeExecution call', async () => {
      enqueueEntry(deps.queue, { content: 'msg-a' });
      enqueueEntry(deps.queue, { content: 'msg-b' });
      enqueueEntry(deps.queue, { content: 'msg-c' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', (q) => deps.router.routeExecution.mock.calls.length >= 1);

      assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'should call routeExecution once');
      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'msg-a\nmsg-b\nmsg-c', 'content should be combined');
    });

    it('fixed canary window turns four idle envelopes into one invocation', async () => {
      const base = Date.now();
      for (let index = 0; index < 4; index++) {
        const queued = enqueueEntry(deps.queue, {
          content: `msg-${index + 1}`,
          messageEnvelope: {
            messageId: `message-${index + 1}`,
            senderType: 'user',
            content: `msg-${index + 1}`,
            mentions: ['opus'],
            timestamp: base + index,
          },
        });
        deps.queue.backfillMessageId('t1', 'u1', queued.id, `message-${index + 1}`);
        processor.scheduleUserBatchFlush({
          threadId: 't1',
          userId: 'u1',
          targetCats: ['opus'],
          intent: 'execute',
          windowMs: 10,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(deps.router.routeExecution.mock.calls.length, 1);
      const payload = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.match(payload, /^\[批量投递 - 4 条消息\]/);
      for (let index = 1; index <= 4; index++) {
        assert.match(payload, new RegExp(`"messageId":"message-${index}"`));
      }
      const auditUpdate = deps.invocationRecordStore.update.mock.calls.find(
        (call) => call.arguments[1]?.userMessageIds,
      );
      assert.deepEqual(auditUpdate?.arguments[1].userMessageIds, ['message-1', 'message-2', 'message-3', 'message-4']);
      processor.dispose();
    });

    it('coalesces multiple already-pending A2A mentions for one busy target', async () => {
      for (let index = 1; index <= 2; index++) {
        enqueueEntry(deps.queue, {
          source: 'agent',
          sourceCategory: 'a2a',
          autoExecute: true,
          callerCatId: 'codex',
          content: `handoff-${index}`,
          messageEnvelope: {
            messageId: `agent-message-${index}`,
            senderType: 'agent',
            content: `handoff-${index}`,
            mentions: ['opus'],
            timestamp: Date.now() + index,
          },
        });
      }

      await processor.tryAutoExecute('t1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      assert.equal(deps.router.routeExecution.mock.calls.length, 1);
      const payload = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.match(payload, /^\[批量投递 - 2 条消息\]/);
      assert.match(payload, /"messageId":"agent-message-1"/);
      assert.match(payload, /"messageId":"agent-message-2"/);
    });

    it('never drops legacy unenveloped content when adjacent entries have envelopes', async () => {
      enqueueEntry(deps.queue, { content: 'legacy-primary' });
      enqueueEntry(deps.queue, {
        content: 'enveloped-second',
        messageEnvelope: {
          messageId: 'message-2',
          senderType: 'user',
          content: 'enveloped-second',
          mentions: ['opus'],
          timestamp: Date.now(),
        },
      });
      enqueueEntry(deps.queue, {
        content: 'enveloped-third',
        messageEnvelope: {
          messageId: 'message-3',
          senderType: 'user',
          content: 'enveloped-third',
          mentions: ['opus'],
          timestamp: Date.now() + 1,
        },
      });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      assert.equal(
        deps.router.routeExecution.mock.calls[0].arguments[1],
        'legacy-primary\nenveloped-second\nenveloped-third',
        'mixed legacy/new batches must fail closed instead of emitting a partial envelope batch',
      );
    });

    it('marks all batched entries as processing', async () => {
      enqueueEntry(deps.queue, { content: 'a' });
      enqueueEntry(deps.queue, { content: 'b' });

      await processor.processNext('t1', 'u1');

      const remaining = deps.queue.list('t1', 'u1').filter((e) => e.status === 'queued');
      assert.equal(remaining.length, 0, 'no queued entries should remain after batch');
    });

    it('does not batch connector entries', async () => {
      enqueueEntry(deps.queue, { content: 'conn-a', source: 'connector' });
      enqueueEntry(deps.queue, { content: 'conn-b', source: 'connector' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 2);

      const calledContents = deps.router.routeExecution.mock.calls.map((call) => call.arguments[1]);
      assert.deepEqual(calledContents, ['conn-a', 'conn-b'], 'connector entries should drain as separate invocations');
    });

    it('stops batch at different intent', async () => {
      enqueueEntry(deps.queue, { content: 'exec-a', intent: 'execute' });
      enqueueEntry(deps.queue, { content: 'search-b', intent: 'search' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'exec-a', 'should only include matching-intent entries');
    });

    it('removes all batched entries after successful execution', async () => {
      enqueueEntry(deps.queue, { content: 'a' });
      enqueueEntry(deps.queue, { content: 'b' });
      enqueueEntry(deps.queue, { content: 'c' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', (q) => q.length === 0);

      const all = deps.queue.list('t1', 'u1');
      assert.equal(all.length, 0, 'all batched entries should be removed after completion');
    });

    it('P1: failed execution rolls back batched entries instead of dropping them', async () => {
      const failDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('CLI spawn failed');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const failProcessor = new QueueProcessor(failDeps);

      enqueueEntry(failDeps.queue, { content: 'primary' });
      enqueueEntry(failDeps.queue, { content: 'batched-a' });
      enqueueEntry(failDeps.queue, { content: 'batched-b' });

      await failProcessor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 100));

      const remaining = failDeps.queue.list('t1', 'u1');
      const queued = remaining.filter((e) => e.status === 'queued');
      assert.ok(queued.length >= 2, `batched entries should be rolled back to queued, got ${queued.length}`);
      const contents = queued.map((e) => e.content);
      assert.ok(contents.includes('batched-a'), 'batched-a should be preserved');
      assert.ok(contents.includes('batched-b'), 'batched-b should be preserved');
    });

    it('P1-1: batched entries messageIds are markDelivered-ed', async () => {
      deps.messageStore.markDelivered = mock.fn(async (id) => ({
        id,
        content: 'c',
        catId: null,
        timestamp: Date.now(),
        mentions: [],
        userId: 'u1',
      }));

      const e1 = enqueueEntry(deps.queue, { content: 'first' });
      deps.queue.backfillMessageId('t1', 'u1', e1.id, 'm1');
      const e2 = enqueueEntry(deps.queue, { content: 'second' });
      deps.queue.backfillMessageId('t1', 'u1', e2.id, 'm2');

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.messageStore.markDelivered.mock.calls.length >= 2);

      const deliveredIds = deps.messageStore.markDelivered.mock.calls.map((c) => c.arguments[0]);
      assert.ok(deliveredIds.includes('m1'), 'primary entry messageId should be delivered');
      assert.ok(deliveredIds.includes('m2'), 'batched entry messageId should be delivered');
    });

    it('P1-2: connector entry is NOT absorbed into user batch', async () => {
      enqueueEntry(deps.queue, { content: 'user-msg', source: 'user' });
      enqueueEntry(deps.queue, { content: 'connector-msg', source: 'connector' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 2);

      const calledContents = deps.router.routeExecution.mock.calls.map((call) => call.arguments[1]);
      assert.deepEqual(
        calledContents,
        ['user-msg', 'connector-msg'],
        'connector entry must execute separately instead of being absorbed into user content',
      );
    });

    it('P2: urgent entry for busy slot does not block lower-priority entry for free slot', async () => {
      const slowDeps = stubDeps({
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          startAll: mock.fn(() => new AbortController()),
          complete: mock.fn(),
          completeAll: mock.fn(),
          has: mock.fn((tid, catId) => catId === 'codex'),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      // urgent entry for codex (slot busy), normal entry for opus (slot free)
      enqueueEntry(slowDeps.queue, { content: 'urgent-codex', targetCats: ['codex'], priority: 'urgent' });
      enqueueEntry(slowDeps.queue, { content: 'normal-opus', targetCats: ['opus'], priority: 'normal' });

      // Trigger across-users chain (simulates codex slot completing, then scanning queue)
      // codex is still busy (has() returns true), opus is free
      await slowProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 100));

      // opus entry should execute despite urgent codex being first in sort order
      const routeCalls = slowDeps.router.routeExecution.mock.calls;
      assert.ok(routeCalls.length >= 1, 'should execute free-slot entry');
      const calledContent = routeCalls[0].arguments[1];
      assert.equal(calledContent, 'normal-opus', 'should execute opus entry, skipping busy codex');

      // codex entry should remain queued
      const codexEntries = slowDeps.queue.list('t1', 'u1').filter((e) => e.content === 'urgent-codex');
      assert.equal(codexEntries.length, 1, 'codex entry should remain');
      assert.equal(codexEntries[0].status, 'queued', 'codex entry should still be queued');
    });

    it('P1: duplicate primary does not mark batched entries as processing', async () => {
      let callCount = 0;
      const dupeDeps = stubDeps({
        invocationRecordStore: {
          create: mock.fn(async () => {
            callCount++;
            if (callCount === 1) return { outcome: 'duplicate', invocationId: 'inv-dupe' };
            return { outcome: 'created', invocationId: `inv-${callCount}` };
          }),
          update: mock.fn(async () => {}),
        },
      });
      const dupeProcessor = new QueueProcessor(dupeDeps);

      enqueueEntry(dupeDeps.queue, { content: 'a' });
      enqueueEntry(dupeDeps.queue, { content: 'b' });
      enqueueEntry(dupeDeps.queue, { content: 'c' });

      await dupeProcessor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 100));

      // Entry 'a' hits duplicate → returns early. With the fix, b and c are NOT
      // marked processing on the duplicate path. The chain then dequeues b (non-duplicate),
      // which batches c. So routeExecution sees b+c content, not a+b+c.
      const routeCalls = dupeDeps.router.routeExecution.mock.calls;
      assert.ok(routeCalls.length >= 1, 'chain should process remaining entries');
      const calledContent = routeCalls[0].arguments[1];
      assert.ok(!calledContent.includes('a'), 'duplicate entry content must not appear in batched execution');
    });
  });

  // ── F185 AC-7: tryAutoExecute fairness gate ──

  describe('tryAutoExecute fairness gate (F185 AC-7)', () => {
    it('skips auto-execute when non-agent entries are queued for the thread', async () => {
      // User entry queued (non-agent)
      enqueueEntry(deps.queue, {
        userId: 'u1',
        source: 'user',
        targetCats: ['opus'],
      });
      // Agent autoExecute entry queued
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'should NOT auto-execute when user entry is pending',
      );
      // Agent entry stays queued
      const agentEntries = deps.queue.list('t1', 'system');
      assert.equal(agentEntries.length, 1, 'agent entry should remain queued');
      assert.equal(agentEntries[0].status, 'queued');
    });

    it('AC-11: A2A chain + connector entry → connector not starved by autoExecute', async () => {
      // Connector entry queued first
      enqueueEntry(deps.queue, {
        userId: 'u1',
        source: 'connector',
        targetCats: ['opus'],
      });
      // Agent A2A chain entry queued after
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'agent autoExecute must NOT run while connector entry is pending',
      );
    });

    it('allows restart-requeued user autoExecute entry to execute itself', async () => {
      enqueueEntry(deps.queue, {
        userId: 'u1',
        source: 'user',
        targetCats: ['codex'],
        autoExecute: true,
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        1,
        'restart-requeued user autoExecute entry should not block itself',
      );
      const entries = deps.queue.list('t1', 'u1');
      assert.equal(entries.length, 0, 'autoExecute user entry should be removed after execution');
    });

    it('allows auto-execute when only agent entries are queued', async () => {
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.tryAutoExecute('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(
        deps.invocationTracker.startAll.mock.calls.length > 0,
        'should auto-execute when only agent entries are queued',
      );
    });
  });
});
