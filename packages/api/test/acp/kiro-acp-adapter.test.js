import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { KiroAcpAdapter } = await import('../../dist/domains/cats/services/agents/providers/acp/KiroAcpAdapter.js');
const { AcpProtocolError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

function createHarness(overrides = {}) {
  const calls = {
    acquire: [],
    newSession: [],
    loadSession: [],
    setSessionModel: [],
    promptStream: [],
    cancelSession: [],
    release: 0,
  };
  const client = {
    async newSession(cwd, mcpServers) {
      calls.newSession.push({ cwd, mcpServers });
      return { sessionId: 'kiro-new-session' };
    },
    async loadSession(sessionId, cwd, mcpServers) {
      calls.loadSession.push({ sessionId, cwd, mcpServers });
      return { sessionId };
    },
    async setSessionModel(sessionId, modelId) {
      calls.setSessionModel.push({ sessionId, modelId });
    },
    async *promptStream(sessionId, text) {
      calls.promptStream.push({ sessionId, text });
      yield {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from Kiro' } },
      };
    },
    cancelSession(sessionId) {
      calls.cancelSession.push(sessionId);
    },
    ...overrides,
  };
  const pool = {
    async acquire(key) {
      calls.acquire.push(key);
      return {
        client,
        poolKey: key,
        release() {
          calls.release += 1;
        },
      };
    },
  };
  return { calls, client, pool };
}

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

describe('KiroAcpAdapter', () => {
  const tempDirs = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('uses actual cwd pool key, creates a persistent session, sets model, prepends system prompt and releases', async () => {
    const { calls, pool } = createHarness();
    const adapter = new KiroAcpAdapter({
      catId: 'kiro-cat',
      pool,
      projectRoot: '/clowder',
      providerProfile: 'kiro-cat',
      model: 'gpt-5.6-sol',
      mcpSupport: true,
    });

    const messages = await collect(
      adapter.invoke('user question', { workingDirectory: '/work/project', systemPrompt: 'You are a cat.' }),
    );

    assert.deepEqual(calls.acquire, [{ projectPath: '/work/project', providerProfile: 'kiro-cat' }]);
    assert.deepEqual(calls.newSession, [{ cwd: '/work/project', mcpServers: [] }]);
    assert.equal(calls.loadSession.length, 0);
    assert.deepEqual(calls.setSessionModel, [{ sessionId: 'kiro-new-session', modelId: 'gpt-5.6-sol' }]);
    assert.equal(calls.promptStream[0].text, 'You are a cat.\n\nuser question');
    assert.equal(calls.release, 1);

    const sessionInit = messages.find((message) => message.type === 'session_init');
    assert.equal(sessionInit.sessionId, 'kiro-new-session');
    assert.equal(Object.hasOwn(sessionInit, 'ephemeralSession'), false);
    assert.equal(sessionInit.metadata.provider, 'kiro');
    assert.equal(messages.find((message) => message.type === 'text').content, 'Hello from Kiro');
    assert.equal(messages.at(-1).type, 'done');
  });

  it('loads an existing session without creating a replacement', async () => {
    const { calls, pool } = createHarness();
    const adapter = new KiroAcpAdapter({ catId: 'kiro-cat', pool, projectRoot: '/clowder' });

    const messages = await collect(adapter.invoke('continue', { sessionId: 'kiro-existing' }));

    assert.equal(calls.newSession.length, 0);
    assert.deepEqual(calls.loadSession, [{ sessionId: 'kiro-existing', cwd: '/clowder', mcpServers: [] }]);
    assert.equal(messages.find((message) => message.type === 'session_init').sessionId, 'kiro-existing');
  });

  it('maps only the observed Kiro missing-session fixture to the canonical message', async () => {
    const { calls, pool } = createHarness({
      async loadSession() {
        throw new AcpProtocolError(
          -32603,
          'Internal error',
          'Failed to start session: Session not found: kiro-missing',
        );
      },
    });
    const adapter = new KiroAcpAdapter({ catId: 'kiro-cat', pool, projectRoot: '/clowder' });

    const messages = await collect(adapter.invoke('continue', { sessionId: 'kiro-missing' }));
    const error = messages.find((message) => message.type === 'error');

    assert.equal(calls.newSession.length, 0);
    assert.match(error.error, /No conversation found with session ID: kiro-missing/);
    assert.doesNotMatch(error.error, /Gemini|Google/i);
    assert.equal(calls.release, 1);
  });

  it('classifies a mid-stream server 500 as a retryable provider_transient failure', async () => {
    const { calls, pool } = createHarness({
      async *promptStream(sessionId) {
        calls.promptStream.push({ sessionId });
        throw new AcpProtocolError(
          -32603,
          'Internal error',
          'InternalServerError: Encountered an unexpected error when processing the request, please try again.',
        );
      },
    });
    const adapter = new KiroAcpAdapter({ catId: 'kiro-cat', pool, projectRoot: '/clowder' });

    const messages = await collect(adapter.invoke('hello'));
    const error = messages.find((message) => message.type === 'error');

    assert.equal(error.errorCode, 'provider_transient');
    assert.match(error.error, /Kiro 服务端瞬时故障/);
    assert.match(error.error, /Encountered an unexpected error/);
    assert.equal(calls.release, 1);
  });

  it('keeps context-window overflow out of the transient retry path', async () => {
    const { pool } = createHarness({
      async *promptStream() {
        throw new AcpProtocolError(-32603, 'Internal error', {
          reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD',
          message: 'Input content length exceeds threshold.',
        });
      },
    });
    const adapter = new KiroAcpAdapter({ catId: 'kiro-cat', pool, projectRoot: '/clowder' });

    const error = (await collect(adapter.invoke('hello'))).find((message) => message.type === 'error');
    assert.equal(error.errorCode, 'context_window_overflow');
  });

  it('keeps a missing session out of the transient retry path', async () => {
    const { pool } = createHarness({
      async *promptStream() {
        throw new AcpProtocolError(-32603, 'Internal error', 'Session not found: kiro-gone');
      },
    });
    const adapter = new KiroAcpAdapter({ catId: 'kiro-cat', pool, projectRoot: '/clowder' });

    const error = (await collect(adapter.invoke('hello'))).find((message) => message.type === 'error');
    assert.equal(error.errorCode, 'prompt_failure');
  });

  it('filters SSE while retaining stdio and HTTP MCP servers', async () => {
    const { calls, pool } = createHarness();
    const adapter = new KiroAcpAdapter({
      catId: 'kiro-cat',
      pool,
      projectRoot: '/clowder',
      mcpSupport: true,
      mcpServers: [
        { name: 'stdio', command: 'node', args: [], env: [] },
        { type: 'http', name: 'http', url: 'https://example.test/mcp', headers: [] },
        { type: 'sse', name: 'sse', url: 'https://example.test/sse', headers: [] },
      ],
    });

    await collect(adapter.invoke('hello'));
    assert.deepEqual(
      calls.newSession[0].mcpServers.map((server) => server.name),
      ['stdio', 'http'],
    );
  });

  it('does not inject builtin or user-project MCP when mcpSupport is false', async () => {
    const userRoot = mkdtempSync(join(tmpdir(), 'clowder-kiro-no-mcp-'));
    tempDirs.push(userRoot);
    writeFileSync(
      join(userRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { user: { command: 'node', args: ['user.js'] } } }),
    );
    const { calls, pool } = createHarness();
    const adapter = new KiroAcpAdapter({
      catId: 'kiro-cat',
      pool,
      projectRoot: '/clowder',
      mcpSupport: false,
      mcpServers: [{ name: 'cat-cafe', command: 'node', args: ['builtin.js'], env: [] }],
    });

    await collect(adapter.invoke('hello', { workingDirectory: userRoot }));
    assert.deepEqual(calls.newSession[0].mcpServers, []);
  });

  it('merges supported user-project MCP servers and filters user SSE', async () => {
    const userRoot = mkdtempSync(join(tmpdir(), 'clowder-kiro-mcp-'));
    tempDirs.push(userRoot);
    writeFileSync(
      join(userRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          userStdio: { command: 'node', args: ['user.js'] },
          userSse: { type: 'sse', url: 'https://example.test/sse' },
        },
      }),
    );
    const { calls, pool } = createHarness();
    const adapter = new KiroAcpAdapter({
      catId: 'kiro-cat',
      pool,
      projectRoot: '/clowder',
      mcpSupport: true,
      mcpServers: [{ name: 'cat-cafe', command: 'node', args: ['builtin.js'], env: [] }],
    });

    await collect(adapter.invoke('hello', { workingDirectory: userRoot }));
    assert.deepEqual(
      calls.newSession[0].mcpServers.map((server) => server.name),
      ['cat-cafe', 'userStdio'],
    );
  });

  it('cancels a session exactly once when aborted after session_init', async () => {
    const controller = new AbortController();
    const { calls, pool } = createHarness();
    const adapter = new KiroAcpAdapter({ catId: 'kiro-cat', pool, projectRoot: '/clowder' });
    const iterator = adapter.invoke('hello', { signal: controller.signal })[Symbol.asyncIterator]();

    const first = await iterator.next();
    assert.equal(first.value.type, 'session_init');
    controller.abort();
    const remaining = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }

    assert.deepEqual(calls.cancelSession, ['kiro-new-session']);
    assert.equal(calls.release, 1);
    assert.equal(remaining.at(-1).type, 'done');
  });

  it('cancels before model setup when abort fires during newSession', async () => {
    const controller = new AbortController();
    const { calls, pool } = createHarness({
      async newSession() {
        controller.abort();
        return { sessionId: 'kiro-init-aborted' };
      },
    });
    const adapter = new KiroAcpAdapter({
      catId: 'kiro-cat',
      pool,
      projectRoot: '/clowder',
      model: 'gpt-5.6-sol',
    });

    const messages = await collect(adapter.invoke('hello', { signal: controller.signal }));

    assert.deepEqual(calls.cancelSession, ['kiro-init-aborted']);
    assert.deepEqual(calls.setSessionModel, []);
    assert.equal(calls.release, 1);
    assert.equal(messages.find((message) => message.type === 'error')?.errorCode, 'prompt_failure');
    assert.equal(messages.at(-1).type, 'done');
  });

  it('delegates active-prompt abort to AcpClient without double cancel and releases in finally', async () => {
    const controller = new AbortController();
    const { calls, client, pool } = createHarness();
    let observedSignal;
    client.promptStream = async function* (sessionId, text, options) {
      calls.promptStream.push({ sessionId, text });
      observedSignal = options?.signal;
      if (!observedSignal) throw new Error('AbortSignal was not delegated to promptStream');
      await new Promise((resolve) => {
        if (observedSignal.aborted) resolve();
        else observedSignal.addEventListener('abort', resolve, { once: true });
      });
      client.cancelSession(sessionId);
      return 'cancelled';
    };

    const adapter = new KiroAcpAdapter({ catId: 'kiro-cat', pool, projectRoot: '/clowder' });
    const iterator = adapter.invoke('hello', { signal: controller.signal })[Symbol.asyncIterator]();
    const sessionInit = await iterator.next();
    assert.equal(sessionInit.value.type, 'session_init');

    const pending = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const doneMessage = await pending;
    assert.equal(doneMessage.value.type, 'done');
    assert.equal((await iterator.next()).done, true);

    assert.strictEqual(observedSignal, controller.signal);
    assert.deepEqual(calls.cancelSession, ['kiro-new-session']);
    assert.equal(calls.release, 1);
  });
});
