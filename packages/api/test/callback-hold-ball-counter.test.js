/**
 * F167 C1 — hold-ball counter window semantic tests
 *
 * Review finding (gpt52 on PR #1289): the original wording was
 *   `MAX_CONSECUTIVE_HOLDS` + `maxConsecutiveHolds reached`
 * but the implementation is a rolling ~1h window counter, not a true
 * consecutive counter. These tests lock in the window semantic so
 * future code/wording cannot drift back to "consecutive".
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('hold-ball counter — window semantic (F167 C1)', () => {
  async function loadModule() {
    return import('../dist/routes/callback-hold-ball-routes.js');
  }

  test('exports renamed constants: MAX_HOLDS_PER_WINDOW=3, HOLD_WINDOW_MS=1h', async () => {
    const m = await loadModule();
    assert.equal(m.MAX_HOLDS_PER_WINDOW, 3);
    assert.equal(m.HOLD_WINDOW_MS, 3_600_000);
  });

  test('does NOT export dead resetHoldCount (removed)', async () => {
    const m = await loadModule();
    assert.equal(m.resetHoldCount, undefined);
  });

  test('getHoldCount returns 0 for unseen (threadId, catId)', async () => {
    const { getHoldCount } = await loadModule();
    assert.equal(getHoldCount('t-unseen-1', 'c-unseen'), 0);
  });

  test('incrementHoldCount climbs 1→2→3 within window', async () => {
    const { incrementHoldCount, getHoldCount } = await loadModule();
    const base = Date.now();
    assert.equal(incrementHoldCount('t-win-1', 'cat-a', base), 1);
    assert.equal(incrementHoldCount('t-win-1', 'cat-a', base + 1_000), 2);
    assert.equal(incrementHoldCount('t-win-1', 'cat-a', base + 2_000), 3);
    assert.equal(getHoldCount('t-win-1', 'cat-a', base + 3_000), 3);
  });

  test('count resets after HOLD_WINDOW_MS elapses (window semantic, not true consecutive)', async () => {
    const { incrementHoldCount, getHoldCount, HOLD_WINDOW_MS } = await loadModule();
    const base = Date.now();
    incrementHoldCount('t-reset-1', 'cat-b', base);
    incrementHoldCount('t-reset-1', 'cat-b', base + 1_000);
    assert.equal(getHoldCount('t-reset-1', 'cat-b', base + 2_000), 2);
    // window check is `now - lastAt > HOLD_WINDOW_MS`; lastAt is base+1_000
    // so we need now > base + 1_000 + HOLD_WINDOW_MS to trigger the reset path
    const afterWindow = base + 1_000 + HOLD_WINDOW_MS + 1;
    assert.equal(getHoldCount('t-reset-1', 'cat-b', afterWindow), 0);
    // first hold after window → fresh count
    assert.equal(incrementHoldCount('t-reset-1', 'cat-b', afterWindow + 1), 1);
  });

  test('limit + window are runtime-configurable via env, read fresh on every call (UI hot reload)', async () => {
    const m = await loadModule();
    const { getMaxHoldsPerWindow, getHoldWindowMs, incrementHoldCount, getHoldCount } = m;
    const saved = {
      max: process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW,
      win: process.env.CAT_CAFE_HOLD_BALL_WINDOW_MS,
    };
    try {
      // 未配置 → 默认值
      delete process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW;
      delete process.env.CAT_CAFE_HOLD_BALL_WINDOW_MS;
      assert.equal(getMaxHoldsPerWindow(), 3);
      assert.equal(getHoldWindowMs(), 3_600_000);

      // 配了就用配的 —— 同一个已加载的模块实例，无需重新 import（这就是热更新）
      process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW = '10';
      process.env.CAT_CAFE_HOLD_BALL_WINDOW_MS = '7200000';
      assert.equal(getMaxHoldsPerWindow(), 10);
      assert.equal(getHoldWindowMs(), 7_200_000);

      // 再改一次，仍然立刻生效
      process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW = '1';
      assert.equal(getMaxHoldsPerWindow(), 1);

      // 窗口变长后，原本会过期的计数不再过期
      const base = Date.now();
      incrementHoldCount('t-hot-1', 'cat-h', base);
      const afterOneHour = base + 3_600_000 + 1;
      assert.equal(getHoldCount('t-hot-1', 'cat-h', afterOneHour), 1, '2h 窗口下，1h 后不应过期');
      process.env.CAT_CAFE_HOLD_BALL_WINDOW_MS = '60000';
      assert.equal(getHoldCount('t-hot-1', 'cat-h', afterOneHour), 0, '窗口调回 1min 后应立即判定过期');

      // 非法值静默回退，不能把机制搞坏
      for (const bad of ['0', '-5', 'abc', '2.5', '']) {
        process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW = bad;
        assert.equal(getMaxHoldsPerWindow(), 3, `非法限额 ${JSON.stringify(bad)} 应回退默认值`);
      }
      for (const bad of ['0', '-1', 'abc', '']) {
        process.env.CAT_CAFE_HOLD_BALL_WINDOW_MS = bad;
        assert.equal(getHoldWindowMs(), 3_600_000, `非法窗口 ${JSON.stringify(bad)} 应回退默认值`);
      }
    } finally {
      if (saved.max === undefined) delete process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW;
      else process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW = saved.max;
      if (saved.win === undefined) delete process.env.CAT_CAFE_HOLD_BALL_WINDOW_MS;
      else process.env.CAT_CAFE_HOLD_BALL_WINDOW_MS = saved.win;
    }
  });

  test('both env vars are registered so the UI env editor can surface them', async () => {
    const { ENV_VARS } = await import('../dist/config/env-registry.js');
    for (const name of ['CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW', 'CAT_CAFE_HOLD_BALL_WINDOW_MS']) {
      const def = ENV_VARS.find((v) => v.name === name);
      assert.ok(def, `${name} 必须注册到 env-registry，否则前端看不到`);
      assert.equal(def.runtimeEditable, true, `${name} 必须可运行时编辑（热更新）`);
      assert.notEqual(def.hubVisible, false, `${name} 必须在 Hub 环境编辑器可见`);
      assert.notEqual(def.restartRequired, true, `${name} 不应标记为需要重启`);
    }
  });

  test('distinct (threadId, catId) pairs are independent', async () => {
    const { incrementHoldCount, getHoldCount } = await loadModule();
    const base = Date.now();
    incrementHoldCount('t-iso-A', 'cat-x', base);
    incrementHoldCount('t-iso-A', 'cat-x', base + 100);
    incrementHoldCount('t-iso-B', 'cat-x', base + 200);
    assert.equal(getHoldCount('t-iso-A', 'cat-x', base + 300), 2);
    assert.equal(getHoldCount('t-iso-B', 'cat-x', base + 300), 1);
    assert.equal(getHoldCount('t-iso-A', 'cat-y', base + 300), 0);
  });
});
