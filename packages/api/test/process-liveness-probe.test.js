// @ci-tier slow reason="uses real CPU sampling and multi-second timing thresholds"
/**
 * ProcessLivenessProbe Tests — F118 Phase B
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { ProcessLivenessProbe } = await import('../dist/utils/ProcessLivenessProbe.js');

// Windows CPU sampling goes through PowerShell CIM (~1-2s per sample, WMI cold
// start can be slower) — give it a much wider window than the fast Unix `ps`.
const busyWaitTimeoutMs = process.platform === 'win32' ? 15_000 : 3_000;

async function waitForBusySilent(probe, { timeoutMs = busyWaitTimeoutMs, burnMs = 180, settleMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const burnUntil = Date.now() + burnMs;
    while (Date.now() < burnUntil) {
      Math.random() * Math.random();
    }
    await new Promise((r) => setTimeout(r, settleMs));
    if (probe.getState() === 'busy-silent') {
      return true;
    }
  }
  return false;
}

async function waitForState(probe, expectedState, { timeoutMs = 5_000, settleMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe.getState() === expectedState) return true;
    await new Promise((r) => setTimeout(r, settleMs));
  }
  return false;
}

test('new probe starts in active state', () => {
  const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
  assert.equal(probe.getState(), 'active');
  probe.stop();
});

test('detects dead process (PID does not exist)', async () => {
  const probe = new ProcessLivenessProbe(99999, { sampleIntervalMs: 50 });
  probe.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(probe.getState(), 'dead');
  probe.stop();
});

test('classifies as busy-silent when CPU grows but no output (ps on Unix, PowerShell CIM on Windows)', async () => {
  const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
  probe.start();
  const reachedBusySilent = await waitForBusySilent(probe);
  const state = probe.getState();
  assert.ok(reachedBusySilent, `expected busy-silent within timeout, got ${state}`);
  assert.equal(state, 'busy-silent');
  probe.stop();
});

test('generates alive_but_silent warning at soft threshold', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 50,
    stallWarningMs: 500,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 250));
  const warnings = probe.drainWarnings();
  assert.ok(warnings.some((w) => w.level === 'alive_but_silent'));
  probe.stop();
});

test('generates suspected_stall warning at stall threshold', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 30,
    stallWarningMs: 100,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 350));
  const warnings = probe.drainWarnings();
  assert.ok(warnings.some((w) => w.level === 'suspected_stall'));
  probe.stop();
});

test('notifyActivity resets silence timer and clears warning state', async () => {
  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 150,
    stallWarningMs: 500,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 30));
  probe.notifyActivity();
  await new Promise((r) => setTimeout(r, 30));
  const warnings = probe.drainWarnings();
  const softWarnings = warnings.filter((w) => w.level === 'alive_but_silent');
  assert.equal(softWarnings.length, 0);
  probe.stop();
});

test('shouldExtendTimeout returns true when busy-silent', async () => {
  const probe = new ProcessLivenessProbe(process.pid, { sampleIntervalMs: 100 });
  probe.start();
  const reachedBusySilent = await waitForBusySilent(probe);
  assert.ok(reachedBusySilent, `expected busy-silent within timeout, got ${probe.getState()}`);
  assert.equal(probe.shouldExtendTimeout(), true);
  probe.stop();
});

test('isHardCapExceeded returns true when elapsed >= factor * timeout', () => {
  const probe = new ProcessLivenessProbe(process.pid, { boundedExtensionFactor: 2 });
  assert.equal(probe.isHardCapExceeded(500, 300), false);
  assert.equal(probe.isHardCapExceeded(600, 300), true, 'exactly 2x should be exceeded');
  assert.equal(probe.isHardCapExceeded(601, 300), true);
  probe.stop();
});

test('classifies as busy-silent when child process has growing CPU', async () => {
  const { spawn } = await import('node:child_process');
  // Spawn a parent that is idle but has a CPU-busy child.
  // Parent: just waits (idle CPU). Child: bounded busy loop (busy CPU).
  // The busy loop is time-bounded (not while(true)) because on Windows
  // SIGTERM handlers never run (kill = hard terminate), which would leak
  // an orphaned CPU-burning child. The 40s bound self-cleans in all cases.
  const parent = spawn(
    'node',
    [
      '-e',
      `const { spawn } = require('child_process');
     const c = spawn('node', ['-e', 'const t=Date.now();while(Date.now()-t<40000){}'], { stdio: 'ignore' });
     process.on('SIGTERM', () => { c.kill(); process.exit(0); });
     c.on('exit', () => process.exit(0));
     setInterval(() => {}, 60000);`,
    ],
    { stdio: 'ignore' },
  );

  let probe = null;
  try {
    // Give child time to start burning CPU
    await new Promise((r) => setTimeout(r, 300));

    probe = new ProcessLivenessProbe(parent.pid, { sampleIntervalMs: 100 });
    probe.start();

    const reachedBusySilent = await waitForState(probe, 'busy-silent', { timeoutMs: busyWaitTimeoutMs });
    const state = probe.getState();
    assert.ok(reachedBusySilent, `parent with busy child should reach busy-silent, got ${state}`);
    assert.equal(state, 'busy-silent', `parent with busy child should be busy-silent, got ${state}`);
  } finally {
    probe?.stop();
    parent.kill('SIGTERM');
  }
});

const { parseCpuTime } = await import('../dist/utils/ProcessLivenessProbe.js');

test('parseCpuTime handles mm:ss.SS format', () => {
  assert.equal(parseCpuTime('1:30.50'), (1 * 60 + 30.5) * 1000);
  assert.equal(parseCpuTime('0:00.00'), 0);
});

test('parseCpuTime handles h:mm:ss format', () => {
  assert.equal(parseCpuTime('1:02:03'), (1 * 3600 + 2 * 60 + 3) * 1000);
});

test('parseCpuTime handles empty/invalid input', () => {
  assert.equal(parseCpuTime(''), 0);
  assert.equal(parseCpuTime('  '), 0);
});

// --- Idle classification (both platforms; was the Windows "no CPU sampling" guard) ---

test('classifies idle child process as idle-silent (no false busy)', async () => {
  // An idle process must NOT be classified busy-silent — otherwise stallAutoKill
  // would never fire for a hung CLI. Uses a sleeping child (not process.pid:
  // the test runner itself burns CPU). Startup CPU makes the first sample look
  // "growing", so wait for a second sample where CPU is flat.
  const { spawn } = await import('node:child_process');
  const child = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  let probe = null;
  try {
    await new Promise((r) => setTimeout(r, 300));
    probe = new ProcessLivenessProbe(child.pid, {
      sampleIntervalMs: 100,
      softWarningMs: 100_000,
      stallWarningMs: 200_000,
    });
    probe.start();
    const reachedIdle = await waitForState(probe, 'idle-silent', { timeoutMs: busyWaitTimeoutMs });
    assert.ok(reachedIdle, `idle child should classify idle-silent, got ${probe.getState()}`);
    assert.equal(probe.shouldExtendTimeout(), false, 'idle-silent must NOT extend timeout');
  } finally {
    probe?.stop();
    child.kill();
  }
});

test('on Windows, silence warnings still fire correctly', async () => {
  if (process.platform !== 'win32') {
    return;
  }

  const probe = new ProcessLivenessProbe(process.pid, {
    sampleIntervalMs: 20,
    softWarningMs: 50,
    stallWarningMs: 150,
  });
  probe.start();
  await new Promise((r) => setTimeout(r, 200));

  const warnings = probe.drainWarnings();
  assert.ok(
    warnings.some((w) => w.level === 'alive_but_silent'),
    'should emit alive_but_silent warning on Windows',
  );
  assert.ok(
    warnings.some((w) => w.level === 'suspected_stall'),
    'should emit suspected_stall warning on Windows',
  );
  probe.stop();
});
