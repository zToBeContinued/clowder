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
