import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

const DELIVERY_ONLY_ENV = 'CAT_CAFE_DELIVERY_ONLY_THREADS';
const ISOLATED_ENV_KEYS = [
  DELIVERY_ONLY_ENV,
  'CAT_CAFE_CONTENT_FREE_INBOX_THREADS',
  'CAT_CAFE_HISTORY_GOVERNANCE',
  'CAT_CAFE_HISTORY_GOVERNANCE_OBSERVE',
  'CAT_CAFE_HISTORY_GOVERNANCE_SUMMARY',
  'CAT_CAFE_HISTORY_GOVERNANCE_CANARY_THREADS',
  'CAT_CAFE_HISTORY_GOVERNANCE_CANARY_CATS',
];

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function countAnchorLines(prompt) {
  return (prompt.match(/^\[(?:Thread opener|Anchor \d+\/\d+) @/gm) ?? []).length;
}

function systemInfoPayloads(messages, type) {
  return messages
    .filter((message) => message.type === 'system_info')
    .map((message) => {
      try {
        return JSON.parse(message.content);
      } catch {
        return null;
      }
    })
    .filter((payload) => payload?.type === type);
}

function createCapturingService(catId, response = `${catId}-done`) {
  const prompts = [];
  return {
    prompts,
    async *invoke(prompt) {
      prompts.push(prompt);
      yield { type: 'text', catId, content: response, timestamp: Date.now() };
      yield {
        type: 'done',
        catId,
        timestamp: Date.now(),
        metadata: {
          provider: 'delivery-only-route-test',
          model: 'fixture',
          usage: { inputTokens: 100, outputTokens: 10 },
        },
      };
    },
  };
}

function makeSummaryStore(threadId, boundaryId, kind = 'valid') {
  if (kind === 'missing') {
    return { listLatestByThread: async () => [] };
  }

  const summary =
    kind === 'unsafe'
      ? [
          '范围：已压缩的旧消息。',
          '当前状态：等待路由层验收。',
          '已确认决策/约束：独立调用使用 deliveryOnly。',
          '下一步：执行专项测试。',
          '风险锚点：API_TOKEN=sk-dangerous-summary-secret。',
          'UNSAFE_SUMMARY_SENTINEL',
        ].join('\n')
      : [
          '范围：已压缩的旧消息。',
          '当前状态：等待路由层验收。',
          '已确认决策/约束：独立调用使用 deliveryOnly。',
          '下一步：执行专项测试。',
          '风险锚点：需要精确证据时回看原文。',
          'SUMMARY_SENTINEL',
        ].join('\n');

  return {
    listLatestByThread: async () => [
      {
        id: `summary-${kind}`,
        threadId,
        fromMessageId: boundaryId,
        toMessageId: boundaryId,
        messageCount: 2,
        summary,
        generatedAt: '2026-07-13T00:00:00.000Z',
        modelId: 'delivery-only-summary-fixture',
        promptVersion: 'history-v1',
      },
    ],
  };
}

async function buildRouteFixture({ threadId, summaryKind = 'valid', opusResponse }) {
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const messageStore = new MessageStore();
  const baseTimestamp = Date.now() - 60_000;

  const summarized = [];
  for (let index = 0; index < 2; index += 1) {
    summarized.push(
      messageStore.append({
        threadId,
        userId: 'user-1',
        catId: null,
        content: `SUMMARIZED_OLD_MESSAGE_${index}`,
        mentions: [],
        timestamp: baseTimestamp + index * 1_000,
      }),
    );
  }
  const summaryBoundaryId = summarized.at(-1).id;

  for (let index = 0; index < 13; index += 1) {
    messageStore.append({
      threadId,
      userId: 'user-1',
      catId: null,
      content: `ANCHOR_CANDIDATE_${String(index).padStart(2, '0')} ${'历史上下文 '.repeat(8)}`,
      mentions: [],
      timestamp: baseTimestamp + (index + 2) * 1_000,
    });
  }

  const trigger = `ROUTE_TRIGGER_SENTINEL_${threadId}`;
  const current = messageStore.append({
    threadId,
    userId: 'user-1',
    catId: null,
    content: trigger,
    mentions: ['opus'],
    timestamp: baseTimestamp + 15_000,
  });

  const cursorByCat = new Map();
  const deliveryCursorStore = {
    getCursor: async (_userId, catId) => cursorByCat.get(catId) ?? summaryBoundaryId,
    ackCursor: async (_userId, catId, _threadId, boundaryId) => {
      cursorByCat.set(catId, boundaryId);
    },
  };
  const opus = createCapturingService('opus', opusResponse);
  const codex = createCapturingService('codex');
  let invocationSequence = 0;

  return {
    threadId,
    trigger,
    currentUserMessageId: current.id,
    services: { opus, codex },
    deps: {
      services: { opus, codex },
      messageStore,
      deliveryCursorStore,
      threadHistorySummaryStore: makeSummaryStore(threadId, summaryBoundaryId, summaryKind),
      invocationDeps: {
        registry: {
          create: () => {
            invocationSequence += 1;
            return {
              invocationId: `delivery-route-inv-${invocationSequence}`,
              callbackToken: `delivery-route-token-${invocationSequence}`,
            };
          },
          verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => undefined,
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/delivery-only-route-test',
        },
        threadStore: null,
        apiUrl: 'http://127.0.0.1:3004',
      },
    },
  };
}

async function runSerial(fixture, targetCats) {
  const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
  const emitted = [];
  for await (const message of routeSerial(fixture.deps, targetCats, fixture.trigger, 'user-1', fixture.threadId, {
    currentUserMessageId: fixture.currentUserMessageId,
    thinkingMode: 'play',
  })) {
    emitted.push(message);
  }
  return emitted;
}

async function withIsolatedEnv(overrides, fn) {
  const previous = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('routeSerial deliveryOnly boundary', () => {
  test('R1: canary single-target independent prompt contains trigger once, mandatory summary, and at most 3 anchors', async () => {
    const threadId = 'delivery-only-independent';
    await withIsolatedEnv({ [DELIVERY_ONLY_ENV]: threadId }, async () => {
      const fixture = await buildRouteFixture({ threadId });

      const emitted = await runSerial(fixture, ['opus']);

      assert.equal(fixture.services.opus.prompts.length, 1);
      const prompt = fixture.services.opus.prompts[0];
      assert.equal(countOccurrences(prompt, fixture.trigger), 1, '完整 route message 必须且只能出现一次');
      assert.equal(countOccurrences(prompt, 'SUMMARY_SENTINEL'), 1, '有效摘要必须且只能注入一段');
      assert.ok(prompt.includes('[Thread History Summary]'), 'deliveryOnly 必须携带 provenance-backed 摘要');
      assert.ok(countAnchorLines(prompt) <= 3, 'deliveryOnly 最多携带 3 条锚点');
      assert.ok(!prompt.includes('[对话历史增量'), 'deliveryOnly 不得携带 recent history window');
      assert.ok(!prompt.includes('[Recent Messages]'), 'deliveryOnly 不得携带 summary-active recent section');
      assert.equal(systemInfoPayloads(emitted, 'invocation_created')[0].contextBudget.deliveryOnlyMode, 'active');
      assert.equal(systemInfoPayloads(emitted, 'invocation_usage')[0].usage.deliveryOnlyMode, 'active');
    });
  });

  test('canary off: single-target route preserves the normal bounded incremental history baseline', async () => {
    const threadId = 'delivery-only-canary-off';
    await withIsolatedEnv({}, async () => {
      const fixture = await buildRouteFixture({ threadId });

      await runSerial(fixture, ['opus']);

      const prompt = fixture.services.opus.prompts[0];
      assert.ok(prompt.includes('[对话历史增量'), '未命中 canary 时必须保留正常 per-cat history');
      assert.ok(prompt.includes(fixture.trigger), '正常路径仍应收到当前触发消息');
      assert.ok(!prompt.includes('[Thread History Summary]'), 'canary off 不应强制启用 deliveryOnly 摘要');
    });
  });

  test('R2: canary two-target serial route keeps the normal per-cat history window for both targets', async () => {
    const threadId = 'delivery-only-known-serial';
    await withIsolatedEnv({ [DELIVERY_ONLY_ENV]: threadId }, async () => {
      const fixture = await buildRouteFixture({ threadId });

      await runSerial(fixture, ['opus', 'codex']);

      assert.equal(fixture.services.opus.prompts.length, 1);
      assert.equal(fixture.services.codex.prompts.length, 1);
      for (const prompt of [fixture.services.opus.prompts[0], fixture.services.codex.prompts[0]]) {
        assert.ok(prompt.includes('[对话历史增量'), 'serial chain 中每只猫都必须保留正常 history window');
        assert.ok(!prompt.includes('[Thread History Summary]'), 'deliveryOnly 不得套用到 serial route');
      }
    });
  });

  test('R2: a target added by a dynamic serial chain receives normal history instead of deliveryOnly', async () => {
    const threadId = 'delivery-only-dynamic-serial';
    await withIsolatedEnv({ [DELIVERY_ONLY_ENV]: threadId }, async () => {
      const fixture = await buildRouteFixture({
        threadId,
        opusResponse: 'OPUS_HANDOFF_SENTINEL\n@缅因猫 请继续串行复核',
      });

      await runSerial(fixture, ['opus']);

      assert.equal(fixture.services.opus.prompts.length, 1);
      assert.equal(fixture.services.codex.prompts.length, 1, 'A2A mention 应把 codex 加入动态 serial worklist');
      assert.ok(
        fixture.services.opus.prompts[0].includes('[Thread History Summary]'),
        '链尚未形成时的初始独立调用可使用 deliveryOnly',
      );
      const chainedPrompt = fixture.services.codex.prompts[0];
      assert.ok(chainedPrompt.includes('[对话历史增量'), '动态加入的 serial hop 必须恢复正常 history window');
      assert.ok(!chainedPrompt.includes('[Thread History Summary]'), '动态 serial hop 不得继续套用 deliveryOnly');
    });
  });

  for (const summaryKind of ['missing', 'unsafe']) {
    test(`fail-safe: ${summaryKind} mandatory summary degrades to normal bounded history`, async () => {
      const threadId = `delivery-only-failsafe-${summaryKind}`;
      await withIsolatedEnv({ [DELIVERY_ONLY_ENV]: threadId }, async () => {
        const fixture = await buildRouteFixture({ threadId, summaryKind });

        const emitted = await runSerial(fixture, ['opus']);

        const prompt = fixture.services.opus.prompts[0];
        assert.ok(prompt.includes('[对话历史增量'), '摘要不可用时不能裸投 trigger，必须回退正常 bounded history');
        assert.ok(prompt.includes(fixture.trigger), '降级路径必须保留当前触发消息');
        assert.ok(!prompt.includes('UNSAFE_SUMMARY_SENTINEL'), '质量门失败的摘要不得进入 prompt');
        assert.ok(!prompt.includes('[Thread History Summary]'), '缺失/坏摘要不得伪装为 deliveryOnly active');
        assert.ok(
          !emitted.some(
            (message) =>
              message.type === 'system_info' &&
              typeof message.content === 'string' &&
              message.content.includes('deliveryOnly 已降级'),
          ),
          'deliveryOnly 降级不得生成频道 warning bubble',
        );
        const expectedIssue = summaryKind === 'missing' ? 'missing_summary' : 'summary_quality_failed';
        assert.equal(systemInfoPayloads(emitted, 'invocation_created')[0].contextBudget.deliveryOnlyMode, 'degraded');
        assert.equal(
          systemInfoPayloads(emitted, 'invocation_created')[0].contextBudget.deliveryOnlyDegradedIssue,
          expectedIssue,
        );
        assert.equal(systemInfoPayloads(emitted, 'invocation_usage')[0].usage.deliveryOnlyMode, 'degraded');
        assert.equal(systemInfoPayloads(emitted, 'invocation_usage')[0].usage.deliveryOnlyDegradedIssue, expectedIssue);
      });
    });
  }
});
