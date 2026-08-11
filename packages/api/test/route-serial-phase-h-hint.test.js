/**
 * F167 Phase H AC-H3/H5 — route-serial integration: routing-syntax-hint emission.
 *
 * Pure detector coverage is in `final-routing-slot.test.js`. This suite locks
 * the wire-up between route-serial and the validator:
 *   - Inline @ in final routing slot + no legitimate exit → appends
 *     `source.connector === 'routing-syntax-hint'` system message
 *   - Legitimate exit (line-start @ / hold_ball / MCP targetCats) → no emit
 *   - Structural exemptions (fenced code, blockquote, URL) → no emit
 *   - Old verdict-no-pass/hold-ball hints are removed; Phase H remains the
 *     only syntax hint for inline @ routing mistakes.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

function createCapturingService(catId, text) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createToolCallingService(catId, text, toolName, toolInput) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield {
        type: 'tool_use',
        catId,
        toolName,
        toolInput,
        id: `tool-${Date.now()}`,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendedMessages) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++counter}`,
          userId: msg.userId ?? '',
          catId: msg.catId ?? null,
          content: msg.content ?? '',
          mentions: msg.mentions ?? [],
          timestamp: msg.timestamp ?? 0,
          source: msg.source,
        };
        appendedMessages.push(stored);
        return stored;
      },
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

async function runRoute(text, threadId) {
  const original = catRegistry.getAllConfigs();
  await loadRealRoster();
  const appended = [];
  try {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opusService = createCapturingService('opus', text);
    const codexService = createCapturingService('codex', 'ack, no further action.');
    const deps = createMockDeps({ opus: opusService, codex: codexService }, appended);
    for await (const _ of routeSerial(deps, ['opus'], 'phase-h test', 'user1', threadId, {
      thinkingMode: 'play',
    })) {
    }
    return { appended, opusCalls: opusService.calls };
  } finally {
    catRegistry.reset();
    for (const [id, config] of Object.entries(original)) {
      catRegistry.register(id, config);
    }
  }
}

async function runRouteWithTool(text, threadId, toolName, toolInput) {
  const original = catRegistry.getAllConfigs();
  await loadRealRoster();
  const appended = [];
  try {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const opusService = createToolCallingService('opus', text, toolName, toolInput);
    const codexService = createCapturingService('codex', 'ack, no further action.');
    const deps = createMockDeps({ opus: opusService, codex: codexService }, appended);
    for await (const _ of routeSerial(deps, ['opus'], 'phase-h test', 'user1', threadId, {
      thinkingMode: 'play',
    })) {
    }
    return { appended };
  } finally {
    catRegistry.reset();
    for (const [id, config] of Object.entries(original)) {
      catRegistry.register(id, config);
    }
  }
}

describe('F167 Phase H AC-H3: route-serial routing-syntax-hint emission', () => {
  test('inline @ routes directly → NO routing-syntax-hint (2026-08-11: @ anywhere = call)', async () => {
    const { appended } = await runRoute('我让 @codex 看了下', 'thread-ph-1');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'inline @ is now a legitimate route — no syntax hint');
  });

  test('legitimate @ exit → NO routing-syntax-hint', async () => {
    // Plain-text gpt52 (no @) is a pure mention — new rule: 提及不呼叫用纯文本名。
    const { appended } = await runRoute('之前我问过 gpt52 的意见。\n\n@codex review', 'thread-ph-2');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, '@ exit must suppress routing-syntax-hint');
  });

  test('@ only inside fenced code block → NO routing-syntax-hint', async () => {
    const { appended } = await runRoute('示例用法：\n\n```\necho "@codex review"\n```', 'thread-ph-3');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'fenced code exempts @; no hint');
  });

  test('@ only inside blockquote → NO routing-syntax-hint', async () => {
    const { appended } = await runRoute('> 铲屎官说：让 @codex 看看', 'thread-ph-4');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'blockquote exempts @; no hint');
  });

  test('plain text with no @ → NO routing-syntax-hint', async () => {
    const { appended } = await runRoute('普通回复，没有任何 mention', 'thread-ph-5');
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'no @ means no hint');
  });

  test('structured MCP routing (post_message.targetCats) suppresses routing-syntax-hint', async () => {
    const { appended } = await runRouteWithTool('让 @codex 看了下', 'thread-ph-6', 'cat_cafe_post_message', {
      content: 'review needed',
      targetCats: ['codex'],
    });
    const hint = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    assert.equal(hint, undefined, 'structured routing is a legitimate exit; no hint');
  });
});

describe('F167 Phase H after legacy hold hint removal', () => {
  test('inline @ + LGTM in slot → routes directly, no hints (2026-08-11)', async () => {
    const { appended } = await runRoute('LGTM, 我让 @codex 看了下', 'thread-ph-7');
    const phaseH = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    const verdictHint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(phaseH, undefined, 'inline @ routes directly — Phase H hint no longer fires');
    assert.equal(verdictHint, undefined, 'legacy verdict-no-pass-hint must not emit');
  });

  test('verdict LGTM without inline @ → no legacy hold hint', async () => {
    const { appended } = await runRoute('LGTM, all tests pass', 'thread-ph-8');
    const phaseH = appended.find((m) => m.source?.connector === 'routing-syntax-hint');
    const verdictHint = appended.find((m) => m.source?.connector === 'verdict-no-pass-hint');
    assert.equal(phaseH, undefined, 'Phase H does not fire without inline @ in slot');
    assert.equal(verdictHint, undefined, 'legacy verdict-only hold hint was removed');
  });
});
