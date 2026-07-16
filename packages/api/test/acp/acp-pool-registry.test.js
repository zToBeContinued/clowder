import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AcpPoolRegistry, createAcpPoolFingerprint } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpPoolRegistry.js'
);

function createPool(activeLeaseCount = 0) {
  let active = activeLeaseCount;
  let closeCount = 0;
  return {
    getMetrics() {
      return { activeLeaseCount: active };
    },
    async closeAll() {
      closeCount += 1;
      active = 0;
    },
    setActiveLeaseCount(value) {
      active = value;
    },
    get closeCount() {
      return closeCount;
    },
  };
}

function fingerprint(carrier, supportsMultiplexing, command = `${carrier}-cli`) {
  return createAcpPoolFingerprint({
    carrier,
    projectRoot: '/project',
    command,
    startupArgs: carrier === 'kiro-acp' ? ['acp'] : ['--acp'],
    supportsMultiplexing,
    maxLiveProcesses: 3,
    idleTtlMs: 300_000,
    healthCheckIntervalMs: 30_000,
  });
}

describe('AcpPoolRegistry', () => {
  it('reuses only an identical provider/startup/capability fingerprint', async () => {
    const registry = new AcpPoolRegistry();
    let factoryCalls = 0;
    const first = await registry.getOrCreate('cat', fingerprint('kiro-acp', false), () => {
      factoryCalls += 1;
      return createPool();
    });
    const second = await registry.getOrCreate('cat', fingerprint('kiro-acp', false), () => {
      factoryCalls += 1;
      return createPool();
    });

    assert.strictEqual(second, first);
    assert.equal(factoryCalls, 1);
    await registry.closeAll();
  });

  it('does not reuse a multiplexing Gemini pool after the profile switches to Kiro', async () => {
    const registry = new AcpPoolRegistry();
    const geminiPool = createPool(1);
    const kiroPool = createPool();

    const first = await registry.getOrCreate(
      'runtime-cat',
      fingerprint('google-acp', true, 'gemini'),
      () => geminiPool,
    );
    const second = await registry.getOrCreate(
      'runtime-cat',
      fingerprint('kiro-acp', false, 'kiro-cli'),
      () => kiroPool,
    );

    assert.strictEqual(first, geminiPool);
    assert.strictEqual(second, kiroPool);
    assert.notStrictEqual(second, first);
    assert.equal(geminiPool.closeCount, 0, 'an active old lease must not be killed during reconciliation');

    geminiPool.setActiveLeaseCount(0);
    await registry.reapRetired();
    assert.equal(geminiPool.closeCount, 1);
    await registry.closeAll();
    assert.equal(kiroPool.closeCount, 1);
  });

  it('retires pools for profiles removed from the active catalog', async () => {
    const registry = new AcpPoolRegistry();
    const pool = createPool();
    await registry.getOrCreate('removed-cat', fingerprint('kiro-acp', false), () => pool);

    await registry.retainOnly(new Set());

    assert.equal(registry.size, 0);
    assert.equal(pool.closeCount, 1);
  });
});
