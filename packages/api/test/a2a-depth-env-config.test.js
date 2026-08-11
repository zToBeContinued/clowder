/**
 * 回归：A2A 接力深度必须来自统一配置（MAX_A2A_DEPTH env），
 * 而不是 callback-a2a-trigger 里曾经硬编码的 10。
 *
 * 这是用户「改了 env 好像没用」的根因：MCP post_message 接力走 enqueueA2ATargets，
 * 之前读死值 10，改 MAX_A2A_DEPTH 对这条最常用的接力路径完全无效。
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

function mockSocket() {
  return { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} };
}
function mockLog() {
  return { info() {}, warn() {}, error() {} };
}

async function prefillAgentEntries(threadId, userId, cats) {
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const queue = new InvocationQueue();
  for (const cat of cats) {
    queue.enqueue({
      threadId,
      userId,
      content: `pre ${cat}`,
      source: 'agent',
      targetCats: [cat],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
  }
  return queue;
}

async function pushOneMore(queue, threadId, target) {
  const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
  return enqueueA2ATargets(
    {
      router: null,
      invocationRecordStore: null,
      socketManager: mockSocket(),
      invocationQueue: queue,
      invocationTracker: undefined,
      queueProcessor: undefined,
      log: mockLog(),
    },
    {
      targetCats: [target],
      content: `@${target} 继续`,
      userId: 'user1',
      threadId,
      triggerMessage: {
        id: `trig-${target}-${Date.now()}`,
        userId: 'user1',
        catId: 'opus',
        content: `@${target} 继续`,
        mentions: [target],
        timestamp: Date.now(),
      },
      callerCatId: 'opus',
    },
  );
}

describe('A2A 接力深度读取统一配置 (MAX_A2A_DEPTH)', () => {
  afterEach(() => {
    delete process.env.MAX_A2A_DEPTH;
    catRegistry.reset();
  });

  test('MCP 回调路径尊重 MAX_A2A_DEPTH env（小值会拦截，证明不再硬编码 10）', async () => {
    process.env.MAX_A2A_DEPTH = '3';
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const threadId = 'thread-depth-env-small';
      const queue = await prefillAgentEntries(threadId, 'user1', ['codex', 'gemini', 'kimi']); // depth=3
      const result = await pushOneMore(queue, threadId, 'grok');
      assert.deepStrictEqual(result.enqueued, [], 'depth=3 已满 → 第 4 个必须被深度门拦下');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });

  test('默认深度(30)下，同样预填 3 个不会被拦（旧硬编码 10 也不会拦，但关键是随 env 变化）', async () => {
    delete process.env.MAX_A2A_DEPTH; // 默认 30
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const threadId = 'thread-depth-env-default';
      const queue = await prefillAgentEntries(threadId, 'user1', ['codex', 'gemini', 'kimi']); // depth=3
      const result = await pushOneMore(queue, threadId, 'grok');
      assert.deepStrictEqual(result.enqueued, ['grok'], 'depth=3 < 默认 30 → 应正常放行');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });

  test('把 MAX_A2A_DEPTH 调到 12 时，11 个已排 + 第 12 个仍放行（旧硬编码 10 会在此拦下 → 证明生效）', async () => {
    process.env.MAX_A2A_DEPTH = '12';
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const threadId = 'thread-depth-env-12';
      // 预填 11 个（超过旧硬编码 10）——旧代码在第 11 个就已拦；新代码上限 12,仍放行
      const cats = Array.from({ length: 11 }, (_, i) => `filler-${i}`);
      const queue = await prefillAgentEntries(threadId, 'user1', cats); // depth=11
      const result = await pushOneMore(queue, threadId, 'codex');
      assert.deepStrictEqual(result.enqueued, ['codex'], 'depth=11 < 12 → 放行；旧硬编码 10 会错误拦截');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });
});
