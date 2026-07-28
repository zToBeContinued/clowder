/**
 * 持球限额（数量 + 窗口）UI 可配 + 热更新 —— 端到端
 *
 * 只测 getter 不足以证明「在 UI 上改完立刻生效」：真正的链路是
 *   HubEnvFilesTab → PATCH /api/config/env → 写 .env + 写 process.env → getter 实时读
 * 本测试直接打这个接口，断言同一个已加载的模块实例在不重启、不重新 import 的前提下
 * 立刻按新值判定，并且值确实落盘到 .env（重启后不丢）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const HOLD_ENV_KEYS = ['CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW', 'CAT_CAFE_HOLD_BALL_WINDOW_MS'];

const saved = new Map();
function snapshotEnv() {
  for (const key of HOLD_ENV_KEYS) saved.set(key, process.env[key]);
}
function restoreEnv() {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
}

async function withApp(fn) {
  const Fastify = (await import('fastify')).default;
  const { configRoutes } = await import('../dist/routes/config.js');
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'hold-ball-hot-'));
  const envFilePath = resolve(tempRoot, '.env');
  writeFileSync(envFilePath, '', 'utf8');
  const app = Fastify();
  await app.register(configRoutes, { projectRoot: tempRoot, envFilePath });
  await app.ready();
  try {
    return await fn(app, envFilePath);
  } finally {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function patchEnv(app, updates) {
  return app.inject({
    method: 'PATCH',
    url: '/api/config/env',
    headers: { 'x-cat-cafe-user': 'you' },
    payload: { updates },
  });
}

describe('持球限额 UI 可配 + 热更新（端到端）', () => {
  afterEach(() => restoreEnv());

  it('PATCH /api/config/env 改完后，同一模块实例立刻按新限额判定（无需重启）', async () => {
    snapshotEnv();
    const { getMaxHoldsPerWindow, getHoldWindowMs, incrementHoldCount, getHoldCount } = await import(
      '../dist/routes/callback-hold-ball-routes.js'
    );

    delete process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW;
    delete process.env.CAT_CAFE_HOLD_BALL_WINDOW_MS;
    assert.equal(getMaxHoldsPerWindow(), 3, '默认 3 次');
    assert.equal(getHoldWindowMs(), 3_600_000, '默认 1 小时');

    await withApp(async (app, envFilePath) => {
      const res = await patchEnv(app, [
        { name: 'CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW', value: '12' },
        { name: 'CAT_CAFE_HOLD_BALL_WINDOW_MS', value: '10800000' },
      ]);
      assert.equal(res.statusCode, 200, res.payload);

      // 热更新：没有重启、没有重新 import，取值已经是新的
      assert.equal(getMaxHoldsPerWindow(), 12);
      assert.equal(getHoldWindowMs(), 10_800_000);

      // 落盘：重启后也不丢
      const envFile = readFileSync(envFilePath, 'utf8');
      assert.match(envFile, /CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW=12/);
      assert.match(envFile, /CAT_CAFE_HOLD_BALL_WINDOW_MS=10800000/);

      // 窗口拉长到 3h 后，2h 前的计数不再过期
      const base = Date.now();
      incrementHoldCount('t-e2e', 'cat-e2e', base);
      assert.equal(getHoldCount('t-e2e', 'cat-e2e', base + 2 * 3_600_000), 1);
    });
  });

  it('清空值（UI 留空）回退到默认，不会把持球机制关掉', async () => {
    snapshotEnv();
    const { getMaxHoldsPerWindow, getHoldWindowMs } = await import('../dist/routes/callback-hold-ball-routes.js');

    await withApp(async (app) => {
      await patchEnv(app, [{ name: 'CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW', value: '9' }]);
      assert.equal(getMaxHoldsPerWindow(), 9);

      const res = await patchEnv(app, [{ name: 'CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW', value: '' }]);
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(process.env.CAT_CAFE_HOLD_BALL_MAX_PER_WINDOW, undefined, '留空应删除该 env');
      assert.equal(getMaxHoldsPerWindow(), 3, '回退默认 3，而不是变成 0/无限');
      assert.equal(getHoldWindowMs(), 3_600_000);
    });
  });

  it('两个变量都出现在 env-summary 的 A2A 分组里（UI 能看到才能改）', async () => {
    await withApp(async (app) => {
      const res = await app.inject({ method: 'GET', url: '/api/config/env-summary' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload);
      const names = new Set(
        (Array.isArray(body.variables) ? body.variables : Object.values(body.variables ?? {}).flat()).map(
          (v) => v?.name,
        ),
      );
      for (const key of HOLD_ENV_KEYS) {
        assert.ok(names.has(key), `${key} 必须出现在 env-summary，否则 UI 上看不到`);
      }
      assert.ok(body.categories?.a2a, 'a2a 分类应存在');
    });
  });
});
