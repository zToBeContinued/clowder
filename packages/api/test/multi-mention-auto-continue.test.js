/**
 * Multi-Mention auto-continue + timeout-flush (自动推进闭环)
 *
 * 覆盖两处修复：
 *  1) 超时也会 flush 汇总（onMultiMentionTimeout），不再把部分结果闷死在内存里。
 *  2) 汇总产出后自动把发起者（callbackTo）入队唤醒，让它据汇总继续推进，
 *     无需人工转发；全失败/全超时时不唤醒；CAT_CAFE_MM_AUTO_CONTINUE=0 可关闭。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import {
  getMultiMentionOrchestrator,
  onMultiMentionTimeout,
  resetMultiMentionOrchestrator,
} from '../dist/routes/callback-multi-mention-routes.js';

function createMockRegistry() {
  const records = new Map();
  return {
    register(catId, threadId, userId) {
      const id = `inv-${records.size}`;
      const token = `tok-${records.size}`;
      records.set(id, { catId, threadId, userId, invocationId: id, callbackToken: token });
      return { invocationId: id, callbackToken: token };
    },
    async verify(invocationId, callbackToken) {
      const r = records.get(invocationId);
      if (!r) return { ok: false, reason: 'unknown_invocation' };
      if (r.callbackToken !== callbackToken) return { ok: false, reason: 'invalid_token' };
      return { ok: true, record: r };
    },
    isLatest: () => true,
    claimClientMessageId: () => true,
  };
}

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
  };
}

function createMockMessageStore() {
  const messages = [];
  return {
    append(msg) {
      const stored = { id: `msg-${messages.length}`, ...msg };
      messages.push(stored);
      return stored;
    },
    getMessages: () => messages,
  };
}

function createMockInvocationRecordStore() {
  let counter = 0;
  return {
    create() {
      return { outcome: 'created', invocationId: `inv-mm-${counter++}` };
    },
    update() {},
  };
}

function createMockInvocationTracker() {
  return {
    start: () => new AbortController(),
    startAll: () => new AbortController(),
    tryStartThreadAll: () => new AbortController(),
    complete() {},
    completeAll() {},
  };
}

function createMockRouter() {
  return {
    async *routeExecution(_u, _m, _t, _i, targetCats) {
      yield { type: 'text', catId: targetCats[0], content: `resp ${targetCats[0]}`, timestamp: Date.now() };
      yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
    },
  };
}

function createMockQueueProcessor() {
  const hooks = new Map();
  const autoExecuteCalls = [];
  return {
    registerEntryCompleteHook(entryId, hook) {
      hooks.set(entryId, hook);
    },
    unregisterEntryCompleteHook(entryId) {
      hooks.delete(entryId);
    },
    tryAutoExecute(threadId) {
      autoExecuteCalls.push(threadId);
      return Promise.resolve();
    },
    getHooks: () => hooks,
    getAutoExecuteCalls: () => autoExecuteCalls,
    simulateComplete(entryId, status, responseText) {
      const hook = hooks.get(entryId);
      if (hook) {
        hook(entryId, status, responseText);
        hooks.delete(entryId);
      }
    },
  };
}

describe('Multi-Mention 自动续跑（唤醒发起者）', () => {
  let app;
  let deps;
  let invocationQueue;
  let mockQueueProcessor;
  let mockMessageStore;
  let creds;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();
    delete process.env.CAT_CAFE_MM_AUTO_CONTINUE;
    const mockRegistry = createMockRegistry();
    mockMessageStore = createMockMessageStore();
    invocationQueue = new InvocationQueue();
    mockQueueProcessor = createMockQueueProcessor();
    creds = mockRegistry.register('opus', 'thread-1', 'user-1');

    deps = {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: createMockSocketManager(),
      router: createMockRouter(),
      invocationRecordStore: createMockInvocationRecordStore(),
      invocationTracker: createMockInvocationTracker(),
      invocationQueue,
      queueProcessor: mockQueueProcessor,
    };

    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(app, deps);
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.CAT_CAFE_MM_AUTO_CONTINUE;
    await app.close();
  });

  async function createMM(targets, callbackTo = 'opus', question = 'q') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: { targets, question, callbackTo },
    });
    assert.equal(res.statusCode, 200);
    return res.json().requestId;
  }

  // done 路径用 void flushResult（不 await），唤醒发生在 append 之后的 microtask，
  // 故断言前让出一拍。
  const settle = () => new Promise((r) => setTimeout(r, 20));

  test('全部回答后，发起者被自动入队唤醒并带上汇总内容', async () => {
    // callbackTo=gemini 便于和 target(codex) 区分
    const requestId = await createMM(['codex'], 'gemini', '需要复核');
    const orch = getMultiMentionOrchestrator();

    const [entryId] = mockQueueProcessor.getHooks().keys();
    mockQueueProcessor.simulateComplete(entryId, 'succeeded', 'codex 说没问题');
    assert.equal(orch.getStatus(requestId), 'done');
    await settle();

    // 发起者 gemini 被入队（source=agent, autoExecute），内容含汇总
    const wake = invocationQueue.listAutoExecute('thread-1').find((e) => e.targetCats.includes('gemini'));
    assert.ok(wake, '发起者 gemini 应被自动入队唤醒');
    assert.equal(wake.source, 'agent');
    assert.equal(wake.autoExecute, true);
    assert.ok(wake.content.includes('汇总'));
    assert.ok(wake.content.includes('codex 说没问题'), '唤醒内容应带上汇总答案');
  });

  test('全部超时（无人回答）时不唤醒发起者', async () => {
    const requestId = await createMM(['codex', 'kimi'], 'gemini');
    // 谁都不回，直接超时
    await onMultiMentionTimeout(deps, requestId, 'thread-1', 'user-1', app.log);

    const wake = invocationQueue.listAutoExecute('thread-1').find((e) => e.targetCats.includes('gemini'));
    assert.equal(wake, undefined, '全超时（无真实回答）不应唤醒发起者');
  });

  test('CAT_CAFE_MM_AUTO_CONTINUE=0 时禁用自动续跑', async () => {
    process.env.CAT_CAFE_MM_AUTO_CONTINUE = '0';
    await createMM(['codex'], 'gemini', 'q');
    const [entryId] = mockQueueProcessor.getHooks().keys();
    mockQueueProcessor.simulateComplete(entryId, 'succeeded', '有答案');
    await settle();

    const wake = invocationQueue.listAutoExecute('thread-1').find((e) => e.targetCats.includes('gemini'));
    assert.equal(wake, undefined, '开关关闭时不应唤醒');
    // 但汇总消息仍应贴出
    assert.ok(mockMessageStore.getMessages().some((m) => m.content?.includes('Multi-Mention')));
  });

  test('超时也会 flush 汇总，并保留已到的回答', async () => {
    const requestId = await createMM(['codex', 'kimi'], 'gemini', '限时讨论');
    const orch = getMultiMentionOrchestrator();

    // 只有 codex 回来，kimi 没回
    const [firstEntry] = mockQueueProcessor.getHooks().keys();
    mockQueueProcessor.simulateComplete(firstEntry, 'succeeded', 'codex 的观点');
    assert.equal(orch.getStatus(requestId), 'partial');

    const before = mockMessageStore.getMessages().length;
    // 直接触发超时处理（不等真实计时器）
    await onMultiMentionTimeout(deps, requestId, 'thread-1', 'user-1', app.log);

    assert.equal(orch.getStatus(requestId), 'timeout');
    const msgs = mockMessageStore.getMessages();
    assert.equal(msgs.length, before + 1, '超时应产出一条汇总消息');
    const summary = msgs.find((m) => m.content?.includes('Multi-Mention'));
    assert.ok(summary.content.includes('codex 的观点'), '汇总应保留已到回答');
    assert.ok(summary.content.includes('超时'), '缺席方应标注超时');

    // 有真实回答 → 超时后也唤醒发起者继续
    const wake = invocationQueue.listAutoExecute('thread-1').find((e) => e.targetCats.includes('gemini'));
    assert.ok(wake, '超时但有部分答案时应唤醒发起者');
  });

  test('flush 幂等：done 之后再触发超时不会重复贴汇总', async () => {
    const requestId = await createMM(['codex'], 'gemini');
    const [entryId] = mockQueueProcessor.getHooks().keys();
    mockQueueProcessor.simulateComplete(entryId, 'succeeded', '答案');
    const countAfterDone = mockMessageStore.getMessages().filter((m) => m.content?.includes('Multi-Mention')).length;
    assert.equal(countAfterDone, 1);

    // 迟到的超时回调不应再贴一条
    await onMultiMentionTimeout(deps, requestId, 'thread-1', 'user-1', app.log);
    const countAfterTimeout = mockMessageStore.getMessages().filter((m) => m.content?.includes('Multi-Mention')).length;
    assert.equal(countAfterTimeout, 1, 'flush 应幂等，不重复');
  });
});
