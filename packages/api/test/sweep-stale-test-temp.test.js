/**
 * 2026-08-13 铲屎官在 %TEMP% 发现数百个 cat-cafe-test-template-* 残留
 * (7/16、7/26 的测试垃圾)。exit 钩子在硬杀/崩溃/worker 线程场景不执行,
 * 永远会有漏网——改为每次测试启动时自愈清扫上一轮残留。
 * 安全铁律:名字里的 pid 还活着绝不删(并行测试保护)。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sweepStaleTestTemp } from './helpers/sweep-stale-test-temp.js';

const HOUR = 3600_000;

function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sweep-stale-fixture-'));
  const mk = (name, ageMs) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cat-template.json'), '{}');
    const t = new Date(Date.now() - ageMs);
    utimesSync(dir, t, t);
    return dir;
  };
  return { root, mk };
}

test('年轻目录:pid 已死 → 删,pid 活着 → 保留(并行测试保护)', () => {
  const { root, mk } = makeFixtureRoot();
  try {
    const deadDir = mk('cat-cafe-test-template-99999999-abc', 0.1 * HOUR);
    const aliveDir = mk(`cat-cafe-test-template-${process.pid}-def`, 1 * HOUR);

    const result = sweepStaleTestTemp({ root });

    assert.equal(existsSync(deadDir), false, 'pid 已死 → 删');
    assert.equal(existsSync(aliveDir), true, '年轻 + pid 活着 → 保留');
    assert.equal(result.removed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('超过 24h 一律删,「pid 活着」不构成保护(防 PID 复用骗过清扫)', () => {
  const { root, mk } = makeFixtureRoot();
  try {
    // 现实场景:7 月的老垃圾,名字里的 pid 恰被今天的无关进程复用
    const ancientReusedPid = mk(`cat-cafe-test-template-${process.pid}-old`, 100 * HOUR);

    const result = sweepStaleTestTemp({ root });

    assert.equal(existsSync(ancientReusedPid), false, '超龄必删,不看 pid');
    assert.equal(result.removed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无法解析 pid 的 template 目录与 home 目录按年龄(24h)裁决', () => {
  const { root, mk } = makeFixtureRoot();
  try {
    const oldWeird = mk('cat-cafe-test-template-notapid', 30 * HOUR);
    const youngWeird = mk('cat-cafe-test-template-alsonotapid', 1 * HOUR);
    const oldHome = mk('cat-cafe-test-home-xyz', 30 * HOUR);
    const youngHome = mk('cat-cafe-test-home-uvw', 1 * HOUR);

    const result = sweepStaleTestTemp({ root });

    assert.equal(existsSync(oldWeird), false);
    assert.equal(existsSync(youngWeird), true);
    assert.equal(existsSync(oldHome), false);
    assert.equal(existsSync(youngHome), true);
    assert.equal(result.removed, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('不相关目录一律不动;root 不存在时安静返回 0', () => {
  const { root, mk } = makeFixtureRoot();
  try {
    const unrelated = mk('some-other-app-temp', 100 * HOUR);
    const result = sweepStaleTestTemp({ root });
    assert.equal(existsSync(unrelated), true);
    assert.equal(result.removed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const missing = sweepStaleTestTemp({ root: join(tmpdir(), 'definitely-not-here-xyz') });
  assert.equal(missing.removed, 0);
});
