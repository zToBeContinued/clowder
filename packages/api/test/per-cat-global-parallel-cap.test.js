/**
 * 每猫全局并发软上限（CAT_CAFE_PER_CAT_MAX_PARALLEL）
 *
 * 同一只猫（身份全局共享）被多个 channel 同时驱动时共用一个 provider 账号，
 * 无人值守的队列自动执行需要一个总闸保护配额。覆盖：
 *  1) 默认（未设置）不限流 —— 行为与旧版完全一致
 *  2) limit=1 时：猫在 thread-A 活跃 → thread-B 的同猫队列条目被跳过（留队不丢）
 *  3) 槽释放后 drain：threadsWithQueuedCat 能找到等待中的 thread
 *  4) InvocationTracker.countActiveForCat 跨 thread 计数正确
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';

function stubDeps(queue, tracker, executions) {
  return {
    queue,
    invocationTracker: tracker,
    invocationRecordStore: {
      create: () => ({ outcome: 'created', invocationId: `inv-${executions.length}` }),
      update: () => {},
    },
    router: {
      async *routeExecution(_u, _c, threadId, _m, targetCats) {
        executions.push({ threadId, cat: targetCats[0] });
        yield { type: 'text', catId: targetCats[0], content: 'ok', timestamp: Date.now() };
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
      ackCollectedCursors: () => Promise.resolve(),
    },
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
    messageStore: { markDelivered: () => null, getById: () => null },
    log: { info() {}, warn() {}, error() {} },
  };
}

describe('每猫全局并发软上限', () => {
  beforeEach(() => {
    delete process.env.CAT_CAFE_PER_CAT_MAX_PARALLEL;
  });
  afterEach(() => {
    delete process.env.CAT_CAFE_PER_CAT_MAX_PARALLEL;
  });

  test('InvocationTracker.countActiveForCat 跨 thread 计数', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-A', 'codex', 'u1');
    tracker.start('thread-B', 'codex', 'u1');
    tracker.start('thread-B', 'kimi', 'u1');
    assert.equal(tracker.countActiveForCat('codex'), 2);
    assert.equal(tracker.countActiveForCat('kimi'), 1);
    assert.equal(tracker.countActiveForCat('gemini'), 0);

    tracker.complete('thread-A', 'codex');
    assert.equal(tracker.countActiveForCat('codex'), 1);
  });

  test('默认不限流：另一 thread 同猫条目照常执行（旧行为不变）', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const executions = [];
    const qp = new QueueProcessor(stubDeps(queue, tracker, executions));

    // 猫已在 thread-A 活跃
    tracker.start('thread-A', 'codex', 'u1');

    queue.enqueue({
      threadId: 'thread-B',
      userId: 'u1',
      content: 'go',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    await qp.tryAutoExecute('thread-B');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(executions.length, 1, '未设上限时 thread-B 应正常执行');
  });

  test('limit=1：猫在别的 thread 活跃时，本 thread 条目被跳过且留在队列', async () => {
    process.env.CAT_CAFE_PER_CAT_MAX_PARALLEL = '1';
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const executions = [];
    const qp = new QueueProcessor(stubDeps(queue, tracker, executions));

    tracker.start('thread-A', 'codex', 'u1'); // 占满全局唯一并发额度

    queue.enqueue({
      threadId: 'thread-B',
      userId: 'u1',
      content: 'wait me',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    await qp.tryAutoExecute('thread-B');
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(executions.length, 0, '饱和时不得执行');
    assert.equal(
      queue.hasQueuedAgentForCat('thread-B', 'codex'),
      true,
      '条目必须留在队列（跳过≠丢弃），等槽释放后 drain',
    );
    assert.deepEqual(queue.threadsWithQueuedCat('codex'), ['thread-B'], 'drain 路径能找到等待中的 thread');

    // 槽释放后再踢一次 → 应可执行（模拟 drainCatWaiters 的补踢）
    tracker.complete('thread-A', 'codex');
    await qp.tryAutoExecute('thread-B');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(executions.length, 1, '槽释放后等待条目应被执行');
  });

  test('limit=2：一路活跃时第二路放行，第三路被拦', async () => {
    process.env.CAT_CAFE_PER_CAT_MAX_PARALLEL = '2';
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const executions = [];
    const qp = new QueueProcessor(stubDeps(queue, tracker, executions));

    tracker.start('thread-A', 'codex', 'u1'); // 占 1/2

    for (const tid of ['thread-B', 'thread-C']) {
      queue.enqueue({
        threadId: tid,
        userId: 'u1',
        content: 'go',
        source: 'agent',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
      });
    }

    // thread-B 放行（占满 2/2）。router 执行是异步的，但 processingSlots 同步占位；
    // 全局计数依赖 tracker —— executeEntry 内部会 start tracker 槽。
    await qp.tryAutoExecute('thread-B');
    await new Promise((r) => setTimeout(r, 50));
    await qp.tryAutoExecute('thread-C');
    await new Promise((r) => setTimeout(r, 200));

    const threads = executions.map((e) => e.threadId);
    assert.ok(threads.includes('thread-B'), '第二路应放行');
  });
});
