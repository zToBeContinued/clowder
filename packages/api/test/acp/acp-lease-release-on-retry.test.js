// @ts-check

/**
 * 回归：provider 重试 / 中断路径不得泄漏 ACP 进程池租约
 *
 * 现场症状（2026-07-28 thread_ms16zvb8ex5mdwem）：
 *   1. `Kiro 服务端瞬时故障…（Failed to start session: Session is active in another process (PID …)）`
 *   2. 紧接着 `Kiro CLI 启动失败：Pool at capacity — all processes have active leases`
 *
 * 根因：KiroAcpAdapter 在 `finally` 里 `lease.release()`，而 invoke-single-cat 用
 * `abortableNext` 手动驱动迭代器，在收到 `done` 后直接 `break` 去做重试 —— provider
 * 生成器仍挂在 `yield` 上，`finally` 永不执行，租约永久泄漏。泄漏满 maxLiveProcesses
 * 之后池彻底饿死，只能重启 API。
 *
 * 本测试用 maxLiveProcesses=1 的真实 AcpProcessPool + 真实 KiroAcpAdapter 复现：
 * 修复前第二次尝试必然拿到 `Pool at capacity`，修复后复用同一进程。
 */

import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const { AcpProcessPool } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpProcessPool.js');
const { KiroAcpAdapter } = await import('../../dist/domains/cats/services/agents/providers/acp/KiroAcpAdapter.js');
const { AcpProtocolError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');

let tempDir;
let invokeSingleCat;

async function collect(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

/** Kiro CLI 的会话独占锁错误 —— 会被 classifyKiroError 归到 provider_transient。 */
function sessionLockError(pid) {
  return new AcpProtocolError(-32603, 'Internal error', `Failed to start session: Session is active in another process (PID ${pid})`);
}

/**
 * 假 Kiro ACP 客户端。`behavior` 决定每次 newSession/promptStream 的结果。
 */
function createMockKiroClient(state) {
  let alive = false;
  let closed = false;
  const id = ++state.spawnCount;
  return {
    id,
    get isAlive() {
      return alive && !closed;
    },
    async initialize() {
      alive = true;
      return { agentInfo: { name: 'mock-kiro', version: '1.0' } };
    },
    async newSession() {
      state.newSessionCount += 1;
      if (state.failNewSessionTimes > 0) {
        state.failNewSessionTimes -= 1;
        throw sessionLockError(40000 + id);
      }
      return { sessionId: `kiro-sess-${id}` };
    },
    async loadSession(sessionId) {
      return { sessionId };
    },
    async setSessionModel() {},
    cancelSession() {},
    async *promptStream(sessionId) {
      state.promptCount += 1;
      if (state.stallForever) {
        // 模拟“回复流卡死”，让调用方靠超时/取消退出。
        await new Promise(() => {});
      }
      yield {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'recovered' } },
      };
    },
    async close() {
      closed = true;
      alive = false;
      state.closeCount += 1;
    },
  };
}

function createPool(state, maxLiveProcesses = 1) {
  return new AcpProcessPool(
    { maxLiveProcesses, idleTtlMs: 5 * 60 * 1000, healthCheckIntervalMs: 60_000 },
    { supportsMultiplexing: false },
    () => createMockKiroClient(state),
  );
}

function makeDeps() {
  let counter = 0;
  return {
    registry: {
      create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => tempDir,
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };
}

describe('ACP pool lease is released on every invoke-single-cat exit path', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-lease-leak-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    process.env.CAT_CAFE_TRANSIENT_PROVIDER_RETRY_DELAY_MS = '10';
    const mod = await import('../../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('transient provider retry reuses the pooled process instead of starving the pool', async () => {
    const state = { spawnCount: 0, newSessionCount: 0, promptCount: 0, closeCount: 0, failNewSessionTimes: 1 };
    const pool = createPool(state, 1);
    const service = new KiroAcpAdapter({
      catId: 'kiro-cat',
      pool,
      projectRoot: tempDir,
      providerProfile: 'kiro-cat',
      mcpSupport: false,
    });

    try {
      const messages = await collect(
        invokeSingleCat(makeDeps(), {
          catId: 'kiro-cat',
          userId: 'u1',
          threadId: 't-lease-transient',
          prompt: 'do the work',
          service,
        }),
      );

      const capacityErrors = messages.filter((m) => m.type === 'error' && /Pool at capacity/.test(m.error ?? ''));
      assert.deepEqual(capacityErrors, [], 'retry must not hit "Pool at capacity" — the first attempt leaked its lease');
      assert.equal(state.newSessionCount, 2, 'should retry the session once');
      assert.equal(state.spawnCount, 1, 'retry must reuse the pooled process (warm hit), not cold-start a new one');
      assert.ok(
        messages.some((m) => m.type === 'text' && m.content === 'recovered'),
        'retry output should be streamed',
      );
      assert.equal(pool.getMetrics().activeLeaseCount, 0, 'no lease may outlive the invocation');
      assert.equal(pool.getMetrics().idleProcessCount, 1, 'the process should return to the idle set');
    } finally {
      await pool.closeAll();
    }
  });

  it('caller abort releases the lease even though the provider generator is mid-stream', async () => {
    const state = { spawnCount: 0, newSessionCount: 0, promptCount: 0, closeCount: 0, failNewSessionTimes: 0, stallForever: true };
    const pool = createPool(state, 1);
    const service = new KiroAcpAdapter({
      catId: 'kiro-cat',
      pool,
      projectRoot: tempDir,
      providerProfile: 'kiro-cat',
      mcpSupport: false,
    });
    const ac = new AbortController();

    try {
      const iterable = invokeSingleCat(makeDeps(), {
        catId: 'kiro-cat',
        userId: 'u1',
        threadId: 't-lease-abort',
        prompt: 'do the work',
        service,
        signal: ac.signal,
      });

      const messages = [];
      for await (const msg of iterable) {
        messages.push(msg);
        if (msg.type === 'session_init') ac.abort(new Error('user cancelled'));
        if (msg.type === 'done') break;
      }

      assert.equal(pool.getMetrics().activeLeaseCount, 0, 'aborted invocation must release its lease');

      // 池只有 1 个槽位：租约真的还回来了，下一次 acquire 才可能成功。
      const lease = await pool.acquire({ projectPath: tempDir, providerProfile: 'kiro-cat' });
      lease.release();
    } finally {
      await pool.closeAll();
    }
  });

  it('a provider generator wedged on an unresolvable await cannot stall invocation cleanup', async () => {
    // async generator 语义：`.return()` 只在生成器挂在 `yield` 上时才跑它的 finally。
    // 挂在永不 resolve 的 `await` 上时 return 请求会被无限排队 —— 清理必须有超时兜底，
    // 否则 invocation 的 finally 直接死锁（正是 F089 abortableNext 要防的那个场景）。
    const state = { spawnCount: 0, newSessionCount: 0, promptCount: 0, closeCount: 0, failNewSessionTimes: 0 };
    const pool = createPool(state, 1);
    // 连 session_init 都不给：newSession 就卡住，生成器停在 await 上而非 yield 上。
    const wedgedPool = {
      async acquire(key) {
        const lease = await pool.acquire(key);
        return {
          poolKey: key,
          release: () => lease.release(),
          client: Object.create(Object.getPrototypeOf(lease.client), {
            newSession: { value: () => new Promise(() => {}) },
          }),
        };
      },
    };
    const service = new KiroAcpAdapter({
      catId: 'kiro-cat',
      pool: wedgedPool,
      projectRoot: tempDir,
      providerProfile: 'kiro-cat',
      mcpSupport: false,
    });
    const ac = new AbortController();

    try {
      const iterable = invokeSingleCat(makeDeps(), {
        catId: 'kiro-cat',
        userId: 'u1',
        threadId: 't-lease-wedged',
        prompt: 'do the work',
        service,
        signal: ac.signal,
      });

      setTimeout(() => ac.abort(new Error('user cancelled')), 50);

      // 关键断言：这个 for-await 必须能走完。修复前它会永久挂在 finally 里。
      const started = Date.now();
      for await (const msg of iterable) {
        if (msg.type === 'done') break;
      }
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 20_000, `cleanup must not deadlock (took ${elapsed}ms)`);
    } finally {
      await pool.closeAll();
    }
  });

  it('release() after a zombie was reaped does not corrupt pool metrics', async () => {
    const state = { spawnCount: 0, newSessionCount: 0, promptCount: 0, closeCount: 0, failNewSessionTimes: 0 };
    // 健康检查间隔设得很短，方便手动触发前的确定性断言。
    const pool = new AcpProcessPool(
      { maxLiveProcesses: 2, idleTtlMs: 60_000, healthCheckIntervalMs: 10 },
      { supportsMultiplexing: false },
      () => createMockKiroClient(state),
    );

    try {
      const lease = await pool.acquire({ projectPath: tempDir, providerProfile: 'kiro-cat' });
      assert.equal(pool.getMetrics().activeLeaseCount, 1);

      // 进程猝死 → 健康检查把 entry 摘掉并把它的租约计数一次性抵扣。
      await lease.client.close();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(pool.getMetrics().zombieCleanupCount, 1, 'zombie should be reaped');
      const afterReap = pool.getMetrics();

      // 迟到的 release() 不得再动一次计数（否则 activeLeaseCount 变负、idleProcessCount 虚高）。
      lease.release();
      const afterRelease = pool.getMetrics();
      assert.equal(afterRelease.activeLeaseCount, afterReap.activeLeaseCount, 'activeLeaseCount must not go negative');
      assert.equal(afterRelease.idleProcessCount, afterReap.idleProcessCount, 'a dead process must not be counted as idle');
      assert.ok(afterRelease.activeLeaseCount >= 0 && afterRelease.idleProcessCount >= 0, 'metrics stay non-negative');
    } finally {
      await pool.closeAll();
    }
  });
});
