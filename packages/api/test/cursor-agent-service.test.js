import assert from 'node:assert/strict';
import { test } from 'node:test';

const { CursorAgentService } = await import('../dist/domains/cats/services/agents/providers/CursorAgentService.js');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createSpawnOverride(capture) {
  return async function* spawnCliOverride(options) {
    capture.options = options;
    yield { type: 'system', subtype: 'init', session_id: 'cursor-session-1', model: 'cursor-test-model' };
    yield {
      type: 'assistant',
      timestamp_ms: Date.now(),
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    };
    yield { type: 'result', subtype: 'success', is_error: false };
  };
}

test('starts Cursor with approvals bypassed and sandbox disabled', async () => {
  const capture = {};
  const service = new CursorAgentService({ cliCommand: 'cursor-test', model: 'cursor-test-model' });

  const messages = await collect(
    service.invoke('full access', {
      workingDirectory: 'D:\\workspace',
      spawnCliOverride: createSpawnOverride(capture),
    }),
  );

  assert.equal(capture.options.command, 'cursor-test');
  const args = capture.options.args;
  assert.ok(args.includes('--force'));
  assert.ok(args.includes('--trust'));
  assert.ok(args.includes('--approve-mcps'));
  const sandboxIndex = args.lastIndexOf('--sandbox');
  assert.ok(sandboxIndex >= 0);
  assert.equal(args[sandboxIndex + 1], 'disabled');
  assert.equal(args.at(-1), 'full access', 'prompt must remain the final positional argument');
  assert.equal(messages.find((message) => message.type === 'text')?.content, 'done');
  assert.equal(messages.at(-1)?.type, 'done');
});

test('thinking 逐词 delta 缓冲为整块（不再一词一行）', async () => {
  const service = new CursorAgentService({ model: 'cursor-test-model' });
  const spawnOverride = async function* spawnCliOverride() {
    yield { type: 'system', subtype: 'init', session_id: 's1', model: 'm' };
    // Cursor 实际会把 thinking 拆成逐词 delta 流出
    yield { type: 'thinking', subtype: 'delta', text: '让我', timestamp_ms: 1 };
    yield { type: 'thinking', subtype: 'delta', text: '想一想', timestamp_ms: 2 };
    yield { type: 'thinking', subtype: 'delta', text: '这个问题', timestamp_ms: 3 };
    yield { type: 'thinking', subtype: 'completed' };
    yield {
      type: 'assistant',
      timestamp_ms: Date.now(),
      message: { role: 'assistant', content: [{ type: 'text', text: '答案' }] },
    };
    yield { type: 'result', subtype: 'success', is_error: false };
  };

  const messages = await collect(service.invoke('q', { spawnCliOverride: spawnOverride }));

  const thinkingEvents = messages.filter(
    (m) => m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('"thinking"'),
  );
  assert.equal(thinkingEvents.length, 1, '多个 delta 必须合并为一条 thinking 事件（此前每个 delta 一条）');
  const payload = JSON.parse(thinkingEvents[0].content);
  assert.equal(payload.text, '让我想一想这个问题', 'delta 必须按序拼接为完整段落');
});

test('重放守卫：断线重连(resuming)后重放的已发文本被吞掉', async () => {
  const service = new CursorAgentService({ model: 'cursor-test-model' });
  const spawnOverride = async function* spawnCliOverride() {
    yield { type: 'system', subtype: 'init', session_id: 's-replay', model: 'm' };
    yield asmDelta('测试通过，866 passed。');
    yield asmDelta('我把窗口加宽。');
    // 网络断开 → CLI 从 checkpoint 恢复并重放（chunk 边界与原发不同）
    yield { type: 'connection', subtype: 'reconnecting', attempt: 1 };
    yield { type: 'retry', subtype: 'resuming', checkpoint_turn_count: 83, attempt: 1 };
    yield asmDelta('测试通过，');
    yield asmDelta('866 passed。');
    yield asmDelta('我把窗口加宽。');
    // 重放结束，新内容开始
    yield asmDelta('接下来做字段级校验。');
    yield { type: 'result', subtype: 'success', is_error: false };
  };

  const messages = await collect(service.invoke('q', { spawnCliOverride: spawnOverride }));
  const fullText = messages
    .filter((m) => m.type === 'text')
    .map((m) => m.content)
    .join('');
  assert.equal(
    fullText,
    '测试通过，866 passed。我把窗口加宽。接下来做字段级校验。',
    '重放的片段必须被吞掉，新内容正常透传',
  );
});

test('重放守卫：无 resuming 时同文正常输出（合法重复不受影响）', async () => {
  const service = new CursorAgentService({ model: 'cursor-test-model' });
  const spawnOverride = async function* spawnCliOverride() {
    yield { type: 'system', subtype: 'init', session_id: 's-legit', model: 'm' };
    yield asmDelta('866 passed, exit 0。');
    yield asmDelta('重跑一遍：');
    yield asmDelta('866 passed, exit 0。');
    yield { type: 'result', subtype: 'success', is_error: false };
  };

  const messages = await collect(service.invoke('q', { spawnCliOverride: spawnOverride }));
  const fullText = messages
    .filter((m) => m.type === 'text')
    .map((m) => m.content)
    .join('');
  assert.equal(fullText, '866 passed, exit 0。重跑一遍：866 passed, exit 0。', '没有重连事件时不做任何去重');
});

function asmDelta(text) {
  return {
    type: 'assistant',
    timestamp_ms: Date.now(),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

test('流中断时已缓冲的 thinking 不丢失（收尾 flush）', async () => {
  const service = new CursorAgentService({ model: 'cursor-test-model' });
  const spawnOverride = async function* spawnCliOverride() {
    yield { type: 'system', subtype: 'init', session_id: 's2', model: 'm' };
    yield { type: 'thinking', subtype: 'delta', text: '想到一半', timestamp_ms: 1 };
    // 流在这里意外结束：无 completed、无 assistant、无 result
  };

  const messages = await collect(service.invoke('q', { spawnCliOverride: spawnOverride }));
  const thinkingEvents = messages.filter(
    (m) => m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('"thinking"'),
  );
  assert.equal(thinkingEvents.length, 1, '收尾必须 flush 残余缓冲');
  assert.equal(JSON.parse(thinkingEvents[0].content).text, '想到一半');
});

test('full-access flags override conflicting member args and survive resume', async () => {
  const capture = {};
  const service = new CursorAgentService({ model: 'cursor-test-model' });

  await collect(
    service.invoke('continue', {
      sessionId: 'existing-cursor-session',
      cliConfigArgs: ['--sandbox enabled', '--auto-review'],
      spawnCliOverride: createSpawnOverride(capture),
    }),
  );

  const args = capture.options.args;
  const resumeIndex = args.indexOf('--resume');
  assert.ok(resumeIndex >= 0);
  assert.equal(args[resumeIndex + 1], 'existing-cursor-session');
  const sandboxIndex = args.lastIndexOf('--sandbox');
  assert.equal(args[sandboxIndex + 1], 'disabled', 'provider-owned sandbox setting must be last');
  assert.ok(args.includes('--force'));
  assert.ok(args.includes('--trust'));
  assert.ok(args.includes('--approve-mcps'));
  assert.equal(args.at(-1), 'continue');
});
