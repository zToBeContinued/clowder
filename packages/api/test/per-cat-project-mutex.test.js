/**
 * 同猫同项目互斥（CAT_CAFE_PER_CAT_PROJECT_MUTEX，默认开启）
 *
 * 根因案例（quant 2026-08-12）：opus 在两个 thread 同时被派工且都指向
 * D:\project\quant，两个 CLI 实例并发写同一个工作树，owner 回归文件在
 * 40 秒内被两套设计交替覆写。并发槽是 (thread, cat) 维度，但文件冲突是
 * projectPath 维度。覆盖：
 *  1) 同猫同项目：后到的一棒保持排队（跳过≠丢弃），完成后可接续
 *  2) 同猫不同项目：照常并行（跨项目并行是刻意能力）
 *  3) 开关设 0：同项目也放行（回到旧行为）
 *  4) InvocationTracker.activeThreadsForCat 解析 slotKey 正确
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';

function stubDeps(queue, tracker, executions, projectByThread) {
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
    threadProjectLookup: {
      get: async (threadId) => {
        const projectPath = projectByThread[threadId];
        return projectPath ? { projectPath } : null;
      },
    },
  };
}

function enqueueFor(queue, threadId) {
  queue.enqueue({
    threadId,
    userId: 'u1',
    content: 'go',
    source: 'agent',
    targetCats: ['opus'],
    intent: 'execute',
    autoExecute: true,
  });
}

describe('同猫同项目互斥', () => {
  beforeEach(() => {
    delete process.env.CAT_CAFE_PER_CAT_PROJECT_MUTEX;
    delete process.env.CAT_CAFE_PER_CAT_MAX_PARALLEL;
  });
  afterEach(() => {
    delete process.env.CAT_CAFE_PER_CAT_PROJECT_MUTEX;
    delete process.env.CAT_CAFE_PER_CAT_MAX_PARALLEL;
  });

  test('InvocationTracker.activeThreadsForCat 从 slotKey 解析 threadId', () => {
    const tracker = new InvocationTracker();
    tracker.start('thread-A', 'opus', 'u1');
    tracker.start('thread-B', 'opus', 'u1');
    tracker.start('thread-B', 'sol', 'u1');
    assert.deepEqual(tracker.activeThreadsForCat('opus').sort(), ['thread-A', 'thread-B']);
    assert.deepEqual(tracker.activeThreadsForCat('sol'), ['thread-B']);
    assert.deepEqual(tracker.activeThreadsForCat('fable'), []);

    tracker.complete('thread-A', 'opus');
    assert.deepEqual(tracker.activeThreadsForCat('opus'), ['thread-B']);
  });

  test('同猫同项目：后到的一棒保持排队，前一棒完成后接续', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const executions = [];
    const qp = new QueueProcessor(
      stubDeps(queue, tracker, executions, {
        'thread-A': 'D:\\project\\quant',
        'thread-B': 'D:\\project\\quant',
      }),
    );

    tracker.start('thread-A', 'opus', 'u1'); // opus 正在 thread-A 写 quant 工作树
    enqueueFor(queue, 'thread-B');

    await qp.tryAutoExecute('thread-B');
    await new Promise((r) => setTimeout(r, 150));

    assert.equal(executions.length, 0, '同项目并发写必须被拦下');
    assert.equal(queue.hasQueuedAgentForCat('thread-B', 'opus'), true, '条目留在队列等待接续');

    // 前一棒完成 → drain 补踢 → 接续执行
    tracker.complete('thread-A', 'opus');
    await qp.tryAutoExecute('thread-B');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(executions.length, 1, '槽释放后等待条目应被执行');
  });

  test('同猫不同项目：照常并行（跨项目并行是刻意能力）', async () => {
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const executions = [];
    const qp = new QueueProcessor(
      stubDeps(queue, tracker, executions, {
        'thread-A': 'D:\\project\\quant',
        'thread-B': 'D:\\project\\other',
      }),
    );

    tracker.start('thread-A', 'opus', 'u1');
    enqueueFor(queue, 'thread-B');

    await qp.tryAutoExecute('thread-B');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(executions.length, 1, '不同项目不应互斥');
  });

  test('CAT_CAFE_PER_CAT_PROJECT_MUTEX=0：同项目也放行（回退旧行为）', async () => {
    process.env.CAT_CAFE_PER_CAT_PROJECT_MUTEX = '0';
    const queue = new InvocationQueue();
    const tracker = new InvocationTracker();
    const executions = [];
    const qp = new QueueProcessor(
      stubDeps(queue, tracker, executions, {
        'thread-A': 'D:\\project\\quant',
        'thread-B': 'D:\\project\\quant',
      }),
    );

    tracker.start('thread-A', 'opus', 'u1');
    enqueueFor(queue, 'thread-B');

    await qp.tryAutoExecute('thread-B');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(executions.length, 1, '开关关闭时不互斥');
  });
});
