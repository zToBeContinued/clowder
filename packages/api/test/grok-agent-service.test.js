import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stubBinDir = mkdtempSync(join(tmpdir(), 'grok-stub-bin-'));
writeFileSync(join(stubBinDir, 'grok'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${stubBinDir}:${process.env.PATH}`;

const { GrokAgentService } = await import('../dist/domains/cats/services/agents/providers/GrokAgentService.js');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test.after(() => {
  rmSync(stubBinDir, { recursive: true, force: true });
});

test('streams thought, text, session_init and done from grok streaming-json', async () => {
  let spawnOptions;
  async function* spawnCliOverride(options) {
    spawnOptions = options;
    yield { type: 'thought', data: 'checking' };
    yield { type: 'text', data: 'GROK_' };
    yield { type: 'text', data: 'OK' };
    yield { type: 'end', stopReason: 'EndTurn', sessionId: 'grok-session-1', requestId: 'req-1' };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  const messages = await collect(
    service.invoke('Reply briefly', {
      systemPrompt: 'Be precise.',
      callbackEnv: { XAI_API_KEY: 'test-key' },
      accountEnv: { CUSTOM_ENV: 'enabled' },
      spawnCliOverride,
    }),
  );

  assert.deepEqual(
    messages.map((message) => message.type),
    ['system_info', 'text', 'text', 'session_init', 'done'],
  );
  assert.match(messages[0].content, /checking/);
  assert.equal(messages[1].content, 'GROK_');
  assert.equal(messages[2].content, 'OK');
  assert.equal(messages[3].sessionId, 'grok-session-1');
  assert.equal(messages[4].metadata.sessionId, 'grok-session-1');

  assert.equal(spawnOptions.command.endsWith('/grok'), true);
  assert.deepEqual(spawnOptions.args.slice(0, 2), ['-p', 'Be precise.\n\nReply briefly']);
  assert.ok(spawnOptions.args.includes('--output-format'));
  assert.ok(spawnOptions.args.includes('streaming-json'));
  assert.ok(spawnOptions.args.includes('--model'));
  assert.ok(spawnOptions.args.includes('grok-4.5'));
  const permissionModeIndex = spawnOptions.args.indexOf('--permission-mode');
  assert.ok(permissionModeIndex >= 0);
  assert.equal(spawnOptions.args[permissionModeIndex + 1], 'default');
  const allowedTools = spawnOptions.args.flatMap((value, index, args) =>
    value === '--allow' && args[index + 1] ? [args[index + 1]] : [],
  );
  assert.deepEqual(allowedTools, ['MCPTool(cat-cafe-clowder-runtime__*)', 'Bash', 'Write', 'Edit']);
  assert.equal(spawnOptions.args.includes('--always-approve'), false);
  assert.equal(spawnOptions.args.includes('bypassPermissions'), false);
  assert.equal(spawnOptions.env.XAI_API_KEY, 'test-key');
  assert.equal(spawnOptions.env.CUSTOM_ENV, 'enabled');
});

test('resumes the requested session and reports CLI failures', async () => {
  let args = [];
  async function* spawnCliOverride(options) {
    args = options.args;
    yield { __cliError: true, exitCode: 2, message: 'resume failed', command: 'grok', signal: null };
  }

  const service = new GrokAgentService({ model: 'grok-composer-2.5-fast' });
  const messages = await collect(service.invoke('Continue', { sessionId: 'grok-session-old', spawnCliOverride }));

  assert.equal(messages[0].type, 'session_init');
  assert.equal(messages[0].sessionId, 'grok-session-old');
  const resumeIndex = args.indexOf('--resume');
  assert.ok(resumeIndex >= 0);
  assert.equal(args[resumeIndex + 1], 'grok-session-old');
  assert.equal(
    messages.some((message) => message.type === 'error'),
    true,
  );
  assert.equal(messages.at(-1).type, 'done');
});

test('surfaces streaming error events without exposing the Grok API key', async () => {
  const apiKey = 'xai-test-secret-key';
  async function* spawnCliOverride() {
    yield { type: 'error', message: `Authentication failed for ${apiKey}` };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  const messages = await collect(
    service.invoke('Hello', {
      callbackEnv: { XAI_API_KEY: apiKey },
      spawnCliOverride,
    }),
  );

  assert.deepEqual(
    messages.map((message) => message.type),
    ['error', 'done'],
  );
  assert.match(messages[0].error, /Authentication failed/);
  assert.doesNotMatch(messages[0].error, new RegExp(apiKey));
});

test('marks a non-aborted cancelled Grok turn as a visible permission failure', async () => {
  async function* spawnCliOverride() {
    yield { type: 'text', data: '收到，开始执行。' };
    yield { type: 'end', stopReason: 'Cancelled', sessionId: 'grok-cancelled-session' };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  const messages = await collect(service.invoke('Write a file', { spawnCliOverride }));

  assert.deepEqual(
    messages.map((message) => message.type),
    ['text', 'error', 'session_init', 'done'],
  );
  assert.equal(messages[1].errorCode, 'permission_cancelled');
  assert.match(messages[1].error, /权限|取消/);
  assert.equal(messages.at(-1).errorCode, 'permission_cancelled');
});

test('still emits the permission failure when another stream error precedes cancellation', async () => {
  async function* spawnCliOverride() {
    yield {
      __cliError: true,
      exitCode: 1,
      signal: null,
      message: 'transient stream diagnostic',
      command: 'grok',
    };
    yield { type: 'end', stopReason: 'Cancelled' };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  const messages = await collect(service.invoke('Write a file', { spawnCliOverride }));

  const permissionErrors = messages.filter(
    (message) => message.type === 'error' && message.errorCode === 'permission_cancelled',
  );
  assert.equal(permissionErrors.length, 1);
  assert.match(permissionErrors[0].error, /权限|取消/);
  assert.equal(messages.at(-1).errorCode, 'permission_cancelled');
});

test('does not misclassify an AbortSignal cancellation as a permission failure', async () => {
  const controller = new AbortController();
  controller.abort('user_cancel');
  async function* spawnCliOverride() {
    yield { type: 'end', stopReason: 'Cancelled' };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  const messages = await collect(
    service.invoke('Stop', {
      signal: controller.signal,
      spawnCliOverride,
    }),
  );

  assert.deepEqual(
    messages.map((message) => message.type),
    ['done'],
  );
  assert.equal(messages[0].errorCode, undefined);
});

test('subscription mode removes an inherited XAI_API_KEY from the child environment', async () => {
  let spawnOptions;
  async function* spawnCliOverride(options) {
    spawnOptions = options;
    yield { type: 'text', data: 'ok' };
    yield { type: 'end', sessionId: 'grok-subscription-session' };
  }

  const service = new GrokAgentService({ model: 'grok-4.5' });
  await collect(
    service.invoke('Hello', {
      callbackEnv: { CAT_CAFE_GROK_PROFILE_MODE: 'subscription' },
      spawnCliOverride,
    }),
  );

  assert.equal(spawnOptions.env.XAI_API_KEY, null);
});

test('injects an isolated native MCP config without persisting callback or account secrets', async () => {
  const sourceGrokHome = mkdtempSync(join(tmpdir(), 'grok-source-home-'));
  const mcpServerPath = join(sourceGrokHome, 'mcp-server.js');
  writeFileSync(mcpServerPath, '// test MCP entry\n');
  let runtimeHome;
  let config = '';
  let bridge = '';
  let authPath;
  let runtimeSessions;
  let configMode;
  let bridgeMode;

  async function* spawnCliOverride(options) {
    runtimeHome = options.env.GROK_HOME;
    authPath = options.env.GROK_AUTH_PATH;
    if (runtimeHome) {
      config = readFileSync(join(runtimeHome, 'config.toml'), 'utf8');
      bridge = readFileSync(join(runtimeHome, 'cat-cafe-mcp-bridge.mjs'), 'utf8');
      runtimeSessions = realpathSync(join(runtimeHome, 'sessions'));
      configMode = statSync(join(runtimeHome, 'config.toml')).mode & 0o777;
      bridgeMode = statSync(join(runtimeHome, 'cat-cafe-mcp-bridge.mjs')).mode & 0o777;
    }

    yield { type: 'text', data: 'ok' };
    yield { type: 'end', sessionId: 'grok-native-mcp-session' };
  }

  try {
    const service = new GrokAgentService({ model: 'grok-4.5', grokHome: sourceGrokHome, mcpServerPath });
    await collect(
      service.invoke('Use a task tool', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-native-mcp',
          CAT_CAFE_CALLBACK_TOKEN: 'callback-secret',
          CLOWDER_API_BEARER_TOKEN: 'api-bearer-secret',
          CAT_CAFE_USER_ID: 'user-1',
          CAT_CAFE_CAT_ID: 'grok',
          CAT_CAFE_THREAD_ID: 'thread-1',
          CAT_CAFE_GROK_PROFILE_MODE: 'api_key',
          XAI_API_KEY: 'xai-account-secret',
          ALLOWED_WORKSPACE_DIRS: sourceGrokHome,
        },
        spawnCliOverride,
      }),
    );

    assert.ok(runtimeHome, 'native MCP invocation should receive an isolated GROK_HOME');
    assert.match(config, /cat-cafe-clowder-runtime/);
    assert.match(config, new RegExp(mcpServerPath.replaceAll('\\', '\\\\')));
    assert.doesNotMatch(config, /callback-secret/);
    assert.doesNotMatch(config, /xai-account-secret/);
    assert.match(bridge, /CAT_CAFE_CALLBACK_TOKEN/);
    assert.match(bridge, /CLOWDER_API_BEARER_TOKEN/);
    assert.doesNotMatch(config, /api-bearer-secret/);
    assert.match(bridge, /ALLOWED_WORKSPACE_DIRS/);
    assert.doesNotMatch(bridge, /XAI_API_KEY/);
    assert.equal(configMode, 0o600);
    assert.equal(bridgeMode, 0o600);
    assert.equal(authPath, join(runtimeHome, 'auth.json'));
    assert.equal(runtimeSessions, realpathSync(join(sourceGrokHome, 'sessions')));
    assert.equal(existsSync(runtimeHome), false, 'ephemeral Grok home should be removed after invocation');
  } finally {
    rmSync(sourceGrokHome, { recursive: true, force: true });
  }
});

test('subscription native MCP mode reuses the existing Grok auth and session store', async () => {
  const sourceGrokHome = mkdtempSync(join(tmpdir(), 'grok-subscription-home-'));
  const sourceSessions = join(sourceGrokHome, 'sessions');
  const sourceAuth = join(sourceGrokHome, 'auth.json');
  const mcpServerPath = join(sourceGrokHome, 'mcp-server.js');
  mkdirSync(sourceSessions);
  writeFileSync(sourceAuth, '{}\n');
  writeFileSync(mcpServerPath, '// test MCP entry\n');
  let runtimeHome;
  let authPath;
  let xaiApiKey;
  let runtimeSessions;

  async function* spawnCliOverride(options) {
    runtimeHome = options.env.GROK_HOME;
    authPath = options.env.GROK_AUTH_PATH;
    xaiApiKey = options.env.XAI_API_KEY;
    if (runtimeHome) runtimeSessions = realpathSync(join(runtimeHome, 'sessions'));
    yield { type: 'text', data: 'ok' };
    yield { type: 'end', sessionId: 'grok-subscription-native-mcp-session' };
  }

  try {
    const service = new GrokAgentService({ model: 'grok-4.5', grokHome: sourceGrokHome, mcpServerPath });
    await collect(
      service.invoke('Continue with tools', {
        callbackEnv: {
          CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
          CAT_CAFE_INVOCATION_ID: 'inv-subscription-mcp',
          CAT_CAFE_CALLBACK_TOKEN: 'callback-secret',
          CAT_CAFE_GROK_PROFILE_MODE: 'subscription',
        },
        spawnCliOverride,
      }),
    );

    assert.ok(runtimeHome, 'subscription invocation should receive an isolated GROK_HOME');
    assert.equal(xaiApiKey, null);
    assert.equal(authPath, sourceAuth);
    assert.equal(runtimeSessions, realpathSync(sourceSessions));
  } finally {
    rmSync(sourceGrokHome, { recursive: true, force: true });
  }
});
