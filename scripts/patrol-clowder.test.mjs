/**
 * patrol-clowder 判定逻辑回归测试
 *
 * 判定规则源自 2026-08-12/13 通宵实战:
 * - 端口挂了 = critical(修复动作:带代理重启)
 * - 0 活跃 + 有排队 + 静默超过阈值 = stalled(修复动作:queue/next 推进)
 *   —— 05:07 事故:回合收口未消费条目 + 事件驱动无兜底,停摆 15 分钟
 * - 有活跃调用时永远不判 stalled(严禁打扰在途工作)
 * - 高级别错误/孤儿进程 = warning(只取证告警,不自动动手)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessPatrol } from './patrol-clowder.mjs';

const HEALTHY = {
  apiUp: true,
  webUp: true,
  activeCount: 1,
  queuedCount: 0,
  recentErrorCount: 0,
  orphanCount: 0,
  minutesSinceLastInvocationWrite: 0.5,
};

test('全绿状态 → healthy,无动作', () => {
  const r = assessPatrol(HEALTHY);
  assert.equal(r.verdict, 'healthy');
  assert.deepEqual(r.actions, []);
});

test('API 端口挂了 → critical + 重启动作', () => {
  const r = assessPatrol({ ...HEALTHY, apiUp: false });
  assert.equal(r.verdict, 'critical');
  assert.ok(r.actions.some((a) => a.kind === 'restart'));
});

test('0 活跃 + 有排队 + 静默超阈值 → stalled + 队列推进动作', () => {
  const r = assessPatrol({
    ...HEALTHY,
    activeCount: 0,
    queuedCount: 2,
    minutesSinceLastInvocationWrite: 5,
  });
  assert.equal(r.verdict, 'stalled');
  assert.ok(r.actions.some((a) => a.kind === 'queue-next'));
});

test('0 活跃 + 有排队但刚有写入(转场窗口)→ 不判 stalled', () => {
  const r = assessPatrol({
    ...HEALTHY,
    activeCount: 0,
    queuedCount: 1,
    minutesSinceLastInvocationWrite: 0.5,
  });
  assert.notEqual(r.verdict, 'stalled');
  assert.ok(!r.actions.some((a) => a.kind === 'queue-next'));
});

test('有活跃调用时即使有排队也是 healthy(排队等位是常态)', () => {
  const r = assessPatrol({ ...HEALTHY, activeCount: 2, queuedCount: 3 });
  assert.equal(r.verdict, 'healthy');
  assert.deepEqual(r.actions, []);
});

test('高级别错误 → warning + 读日志动作,不自动修', () => {
  const r = assessPatrol({ ...HEALTHY, recentErrorCount: 2 });
  assert.equal(r.verdict, 'warning');
  assert.ok(r.actions.some((a) => a.kind === 'inspect-errors'));
  assert.ok(!r.actions.some((a) => a.kind === 'restart'));
});

test('孤儿 agent → warning + 清扫建议', () => {
  const r = assessPatrol({ ...HEALTHY, orphanCount: 1 });
  assert.equal(r.verdict, 'warning');
  assert.ok(r.actions.some((a) => a.kind === 'sweep-orphans'));
});

test('critical 优先级高于 stalled 与 warning', () => {
  const r = assessPatrol({
    ...HEALTHY,
    apiUp: false,
    activeCount: 0,
    queuedCount: 1,
    recentErrorCount: 3,
    minutesSinceLastInvocationWrite: 10,
  });
  assert.equal(r.verdict, 'critical');
});
