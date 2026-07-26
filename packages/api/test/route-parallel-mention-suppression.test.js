import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function createMentionService(catId, content) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createDeps(services, options = {}) {
  let counter = 0;
  const appendCalls = options.appendCalls ?? [];
  return {
    services,
    appendCalls,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        getVotingState: async () => null,
        updateVotingState: async () => {},
        updateParticipantActivity: async () => {},
        getParticipantsWithActivity: async () => [],
        get: async () => null,
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (payload) => {
        appendCalls.push(payload);
        return { id: `msg-${counter}`, userId: '', catId: null, content: '', mentions: [], timestamp: 0 };
      },
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

describe('F167 L2: routeParallel mention suppression', () => {
  test('parallel mode does not emit a2a_followup_available even when cats @ each other', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const deps = createDeps({
      opus: createMentionService('opus', '我觉得方向不错\n@codex 你看看'),
      codex: createMentionService('codex', '同意'),
    });

    const events = [];
    for await (const msg of routeParallel(deps, ['opus', 'codex'], 'ideate 方向', 'user1', 'thread1')) {
      events.push(msg);
    }

    const followup = events.find(
      (e) => e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_followup_available'),
    );
    assert.strictEqual(followup, undefined, 'parallel mode should suppress a2a_followup_available emission (F167 L2)');
  });

  test('parallel mode with no inline @mentions: no followup emitted (baseline)', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    const deps = createDeps({
      opus: createMentionService('opus', '独立意见 A'),
      codex: createMentionService('codex', '独立意见 B'),
    });

    const events = [];
    for await (const msg of routeParallel(deps, ['opus', 'codex'], 'ideate', 'user1', 'thread1')) {
      events.push(msg);
    }

    const followup = events.find(
      (e) => e.type === 'system_info' && typeof e.content === 'string' && e.content.includes('a2a_followup_available'),
    );
    assert.strictEqual(followup, undefined, 'baseline: no mentions means no followup');
  });

  test('parallel mode persists mentions=[] (AC-A5): pending-mentions flow must not pull parallel @ messages', async () => {
    // Codex P1-3 regression: parseA2AMentions still ran and its result was written into
    // messageStore.append({ mentions }), which means MessageStore.getMentionsFor(catId)
    // would return parallel-mode @ messages to the pending-mentions pull. Parallel mode
    // explicitly has no routing semantics, so mentions MUST be [].
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createDeps(
      {
        opus: createMentionService('opus', '方向 A\n@codex 看看这个'),
        codex: createMentionService('codex', '方向 B\n@opus 反过来如何'),
      },
      { appendCalls },
    );

    for await (const _ of routeParallel(deps, ['opus', 'codex'], 'ideate 方向', 'user1', 'thread-ac-a5')) {
    }

    // Every persisted agent message in parallel mode must carry mentions=[].
    // Otherwise MessageStore.getMentionsFor / getRecentMentionsFor will surface parallel @ messages.
    const agentAppends = appendCalls.filter((c) => c.catId && c.origin === 'stream');
    assert.ok(agentAppends.length >= 2, 'expected at least two agent append calls');
    for (const call of agentAppends) {
      assert.deepStrictEqual(
        call.mentions,
        [],
        `parallel-mode agent message must persist mentions=[], got ${JSON.stringify(call.mentions)} for catId=${call.catId}`,
      );
    }
  });
});

describe('F167 L2: suppressed handoff is announced to the user', () => {
  function findNotice(appendCalls) {
    return appendCalls.find((c) => c.source?.connector === 'parallel-handoff-suppressed');
  }

  test('persists one system notice naming who wanted to hand off to whom', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createDeps(
      {
        opus: createMentionService('opus', '拆解完了\n@codex 你来实现'),
        codex: createMentionService('codex', '收到\n@opus 收口给你'),
      },
      { appendCalls },
    );

    for await (const _ of routeParallel(deps, ['opus', 'codex'], 'ideate', 'user1', 'thread-notice')) {
    }

    const notice = findNotice(appendCalls);
    assert.ok(notice, 'a suppressed handoff must not leave the thread silently stopped');
    assert.equal(notice.userId, 'system');
    assert.equal(notice.catId, null);
    // Must not re-enter routing itself, or the notice would recreate the cascade F167 prevents.
    assert.deepStrictEqual(notice.mentions, []);
    assert.equal(notice.source.meta.presentation, 'system_notice');
    assert.equal(notice.source.meta.reason, 'parallel_mode_no_routing');
    assert.match(notice.content, /并行轮次结束/);
    assert.match(notice.content, /@codex/);
    assert.match(notice.content, /@opus/);
    assert.deepStrictEqual(notice.source.meta.suppressedHandoffs, { codex: ['opus'], opus: ['codex'] });
  });

  test('stays silent when no cat tried to hand off', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createDeps(
      {
        opus: createMentionService('opus', '独立意见 A'),
        codex: createMentionService('codex', '独立意见 B'),
      },
      { appendCalls },
    );

    for await (const _ of routeParallel(deps, ['opus', 'codex'], 'ideate', 'user1', 'thread-quiet')) {
    }

    assert.equal(findNotice(appendCalls), undefined, 'no handoff means no notice');
  });

  test('emits a single notice for several cats handing off to the same target', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createDeps(
      {
        opus: createMentionService('opus', '@sonnet 交给你'),
        codex: createMentionService('codex', '@sonnet 也交给你'),
        sonnet: createMentionService('sonnet', '我先看看'),
      },
      { appendCalls },
    );

    for await (const _ of routeParallel(deps, ['opus', 'codex', 'sonnet'], 'ideate', 'user1', 'thread-fanin')) {
    }

    const notices = appendCalls.filter((c) => c.source?.connector === 'parallel-handoff-suppressed');
    assert.equal(notices.length, 1, 'one round produces at most one notice');
    assert.deepStrictEqual(notices[0].source.meta.suppressedHandoffs, { sonnet: ['opus', 'codex'] });
  });

  test('a failing notice never breaks the round', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const deps = createDeps(
      {
        opus: createMentionService('opus', '@codex 交给你'),
        codex: createMentionService('codex', '收到'),
      },
      { appendCalls },
    );
    const realAppend = deps.messageStore.append;
    deps.messageStore.append = async (payload) => {
      if (payload.source?.connector === 'parallel-handoff-suppressed') throw new Error('append exploded');
      return realAppend(payload);
    };

    const events = [];
    for await (const msg of routeParallel(deps, ['opus', 'codex'], 'ideate', 'user1', 'thread-boom')) {
      events.push(msg);
    }

    assert.ok(
      events.some((e) => e.type === 'done' && e.isFinal),
      'the round must still terminate normally',
    );
  });
});
