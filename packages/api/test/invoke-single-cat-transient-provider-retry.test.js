/**
 * Provider 瞬时 5xx 自动重试
 *
 * Kiro runtimeservice 在响应流中途抛 500 时，Kiro CLI 把它包成 JSON-RPC -32603，
 * KiroAcpAdapter 标注 errorCode=provider_transient。本轮若尚未产出任何内容，
 * invoke-single-cat 应退避后重试一次，并在重试成功时抑制首次的错误消息。
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

let tempDir;
let invokeSingleCat;

const TRANSIENT_ERROR =
  'Kiro 服务端瞬时故障（稍后自动重试）：ACP error -32603: Internal error' +
  '（InternalServerError: Encountered an unexpected error when processing the request, please try again.）';

describe('provider_transient retry', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-transient-retry-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    // Keep the backoff out of the test runtime — the retry path is what matters here.
    process.env.CAT_CAFE_TRANSIENT_PROVIDER_RETRY_DELAY_MS = '10';
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDeps(overrides = {}) {
    let counter = 0;
    return {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => 'kiro-session-1',
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      ...overrides,
    };
  }

  it('retries once on the same session and suppresses the first error when the retry succeeds', async () => {
    let attempt = 0;
    const optionsSeen = [];
    const sessionDeletes = [];
    const service = {
      async *invoke(_prompt, opts) {
        attempt++;
        optionsSeen.push(opts);
        if (attempt === 1) {
          yield { type: 'session_init', catId: 'codex', sessionId: 'kiro-session-1', timestamp: Date.now() };
          yield {
            type: 'error',
            catId: 'codex',
            error: TRANSIENT_ERROR,
            errorCode: 'provider_transient',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        } else {
          yield { type: 'text', catId: 'codex', content: 'recovered after 500', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        }
      },
    };

    const deps = makeDeps({
      sessionManager: {
        get: async () => 'kiro-session-1',
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async (userId, catId, threadId) => {
          sessionDeletes.push(`${userId}:${catId}:${threadId}`);
        },
        resolveWorkingDirectory: () => '/tmp/test',
      },
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        userId: 'u1',
        threadId: 't-transient-retry',
        prompt: 'do the work',
        service,
      }),
    );

    assert.equal(attempt, 2, 'should retry once after the provider 500');
    assert.equal(
      optionsSeen[1].sessionId,
      'kiro-session-1',
      'transient retry must keep the session (not a session fault)',
    );
    assert.deepEqual(sessionDeletes, [], 'transient retry must not drop the session');
    assert.ok(
      msgs.some((m) => m.type === 'text' && m.content === 'recovered after 500'),
      'retry output should be streamed',
    );
    assert.equal(
      msgs.some((m) => m.type === 'error'),
      false,
      'first-attempt transient error should be suppressed when the retry succeeds',
    );
  });

  it('delivers the error when the retry hits the same 500', async () => {
    let attempt = 0;
    const service = {
      async *invoke() {
        attempt++;
        yield {
          type: 'error',
          catId: 'codex',
          error: TRANSIENT_ERROR,
          errorCode: 'provider_transient',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        userId: 'u1',
        threadId: 't-transient-exhausted',
        prompt: 'do the work',
        service,
      }),
    );

    assert.equal(attempt, 2, 'should attempt exactly twice');
    const errors = msgs.filter((m) => m.type === 'error');
    assert.equal(errors.length, 1, 'the surviving error should be delivered once');
    assert.match(errors[0].error, /Kiro 服务端瞬时故障/);
  });

  it('does NOT retry when the attempt already produced content', async () => {
    let attempt = 0;
    const service = {
      async *invoke() {
        attempt++;
        yield { type: 'text', catId: 'codex', content: 'partial answer', timestamp: Date.now() };
        yield {
          type: 'error',
          catId: 'codex',
          error: TRANSIENT_ERROR,
          errorCode: 'provider_transient',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        userId: 'u1',
        threadId: 't-transient-partial',
        prompt: 'do the work',
        service,
      }),
    );

    assert.equal(attempt, 1, 'content already streamed → retry would duplicate output');
    assert.ok(
      msgs.some((m) => m.type === 'error' && /瞬时故障/.test(m.error)),
      'error should be delivered as-is',
    );
  });
});
