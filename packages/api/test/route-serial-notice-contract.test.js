import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createInlineMentionService(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: 'Done. Ready for @codex review', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createLineStartMentionService(catId) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: '我已经处理完。\n@gpt52 请继续处理', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls, feedbackWrites, broadcasts) {
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
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        async getParticipantsWithActivity() {
          return [];
        },
        async get(threadId) {
          return {
            id: threadId,
            title: 'Test Thread',
            createdBy: 'user1',
            participants: [],
            createdAt: Date.now(),
            lastActiveAt: Date.now(),
            projectPath: 'default',
          };
        },
        async consumeMentionRoutingFeedback() {
          return null;
        },
        async setMentionRoutingFeedback(threadId, catId, payload) {
          feedbackWrites.push({ threadId, catId, payload });
        },
        async getVotingState() {
          return null;
        },
        async updateVotingState() {},
        async updateParticipantActivity() {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        appendCalls.push(msg);
        return {
          id: `msg-${++messageSeq}`,
          userId: msg.userId,
          catId: msg.catId,
          content: msg.content,
          mentions: msg.mentions,
          timestamp: msg.timestamp,
          threadId: msg.threadId ?? 'default',
          source: msg.source,
          extra: msg.extra,
        };
      },
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
      getById: async () => null,
    },
    socketManager: {
      broadcastToRoom(room, event, payload) {
        broadcasts.push({ room, event, payload });
      },
    },
  };
}

function findA2ABlockedNotice(appendCalls) {
  return appendCalls.find((msg) => msg.source?.connector === 'a2a-routing-blocked');
}

function findA2ADeferredNotice(appendCalls) {
  return appendCalls.find((msg) => msg.source?.connector === 'a2a-routing-deferred');
}

describe('route-serial notice contract', () => {
  it('inline @ routes directly — no syntax hint, no feedback (2026-08-11: @ anywhere = call)', async () => {
    // 2026-08-11: inline @mentions route directly (aligned with user-message rule).
    // Phase H routing-syntax-hint no longer fires for inline @ of routable cats;
    // #417 feedback stays empty because the mention IS routed.
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const codexCalls = [];
    const codexService = {
      calls: codexCalls,
      async *invoke(prompt) {
        codexCalls.push(prompt);
        yield { type: 'text', catId: 'codex', content: 'ack, reviewed.', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const deps = createMockDeps(
      { opus: createInlineMentionService('opus'), codex: codexService },
      appendCalls,
      feedbackWrites,
      broadcasts,
    );

    for await (const _msg of routeSerial(deps, ['opus'], 'review this', 'user1', 'thread-1')) {
    }

    assert.equal(feedbackWrites.length, 0, 'no #417 feedback — the inline mention was actually routed');

    const hintAppend = appendCalls.find((msg) => msg.source?.connector === 'routing-syntax-hint');
    assert.equal(hintAppend, undefined, 'no routing-syntax-hint — inline @ is now a legitimate route');

    const legacyHint = appendCalls.find((msg) => msg.source?.connector === 'inline-mention-hint');
    assert.equal(legacyHint, undefined, 'no legacy inline-mention-hint either');

    assert.ok(codexCalls.length >= 1, 'codex must actually be invoked via the inline @ route');
  });

  it('persists an A2A deferred notice after queued user messages delay a durable handoff', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps(
      { opus: createLineStartMentionService('opus') },
      appendCalls,
      feedbackWrites,
      broadcasts,
    );

    const enqueueCalls = [];
    for await (const _msg of routeSerial(deps, ['opus'], 'review this', 'user1', 'thread-a2a-queued', {
      currentUserMessageId: 'msg-user-1',
      queueHasQueuedMessages: () => true,
      enqueueA2ATargets: async (input) => {
        enqueueCalls.push(input);
        return input.targetCats;
      },
    })) {
    }

    assert.equal(enqueueCalls.length, 1, 'queued user work should delay execution, not drop durable admission');
    assert.equal(enqueueCalls[0].sourceUserMessageId, 'msg-user-1');
    assert.equal(enqueueCalls[0].waitedForQueuedUserMessages, true);

    const notice = findA2ADeferredNotice(appendCalls);
    assert.ok(notice, 'should append a visible A2A deferred notice');
    assert.equal(notice.content, '[交接提醒]: @gpt52 已排队，用户消息处理完自动传球。');
    assert.equal(notice.source.meta.reason, 'queued_user_messages');
    assert.equal(notice.source.meta.presentation, 'system_notice');

    const broadcast = broadcasts.find(
      (entry) =>
        entry.event === 'connector_message' && entry.payload.message.source?.connector === 'a2a-routing-deferred',
    );
    assert.ok(broadcast, 'should broadcast the A2A blocked notice in real-time');
  });

  it('admits an active target through the durable queue without a stale blocked notice', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps(
      { opus: createLineStartMentionService('opus') },
      appendCalls,
      feedbackWrites,
      broadcasts,
    );

    const enqueueCalls = [];
    for await (const _msg of routeSerial(deps, ['opus'], 'review this', 'user1', 'thread-a2a-active', {
      hasQueuedOrActiveAgentForCat: () => true,
      enqueueA2ATargets: async (input) => {
        enqueueCalls.push(input);
        return input.targetCats;
      },
    })) {
    }

    assert.equal(enqueueCalls.length, 1, 'busy targets should use task #366 durable queue admission');
    const notice = findA2ABlockedNotice(appendCalls);
    assert.equal(notice, undefined, 'durably admitted busy targets must not retain the old blocked warning');
  });

  it('persists an A2A blocked notice when queue enqueue returns no accepted target', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const appendCalls = [];
    const feedbackWrites = [];
    const broadcasts = [];
    const deps = createMockDeps(
      { opus: createLineStartMentionService('opus') },
      appendCalls,
      feedbackWrites,
      broadcasts,
    );

    for await (const _msg of routeSerial(deps, ['opus'], 'review this', 'user1', 'thread-a2a-noop', {
      enqueueA2ATargets: async () => [],
    })) {
    }

    const notice = findA2ABlockedNotice(appendCalls);
    assert.ok(notice, 'should append a visible A2A blocked notice');
    assert.match(notice.content, /队列没有接受这次交接请求/);
    assert.equal(notice.source.meta.reason, 'enqueue_noop');
  });
});
