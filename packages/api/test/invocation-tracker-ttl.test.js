/**
 * F118 D3: InvocationTracker TTL Guard
 *
 * AC-D6: has() returns false and auto-deletes slots exceeding TTL (default 75min)
 * AC-D7: Long tool calls within TTL are NOT cleaned up (regression guard)
 * AC-D7b: Multi-cat — TTL sweep only clears the expired slot, not sibling cat slots
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

const SHORT_TTL = 1000; // 1s for testing
const T0 = 100_000; // arbitrary start time

describe('InvocationTracker TTL Guard (F118 D3)', () => {
  // ── AC-D6: expired slot auto-cleanup ──

  it('has(threadId, catId) returns false for slot exceeding TTL', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'opus', 'user1');
    assert.ok(tracker.has('t1', 'opus'), 'slot should exist immediately');

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(tracker.has('t1', 'opus'), false, 'expired slot should return false');
  });

  it('has(threadId) thread-level check returns false when all slots expired', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(tracker.has('t1'), false, 'thread-level check should return false');
  });

  it('expired slot is deleted from internal map (not just hidden)', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    tracker.has('t1', 'opus'); // triggers cleanup
    assert.deepEqual(tracker.getActiveSlots('t1'), [], 'slot should be physically removed');
  });

  // ── AC-D7: long tool calls within TTL are safe ──

  it('has() returns true for slot within TTL (long tool call regression)', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL - 100);
    assert.ok(tracker.has('t1', 'opus'), 'slot within TTL should still be active');
    assert.ok(tracker.has('t1'), 'thread-level check within TTL should be active');
  });

  // ── AC-D7b: multi-cat isolation ──

  it('TTL sweep only clears expired slot, not sibling cat in same thread', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'catA', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    // catA now expired. Start catB at the advanced clock — its startedAt is fresh.
    tracker.start('t1', 'catB', 'user1');

    assert.equal(tracker.has('t1', 'catA'), false, 'catA should be expired');
    assert.ok(tracker.has('t1', 'catB'), 'catB should still be alive');
    assert.ok(tracker.has('t1'), 'thread-level should be true (catB alive)');
  });

  it('getActiveSlots excludes expired slots', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    tracker.start('t1', 'catA', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    tracker.start('t1', 'catB', 'user1');

    const slots = tracker.getActiveSlots('t1');
    assert.equal(slots.length, 1, 'only catB should remain');
    assert.equal(slots[0].catId, 'catB');
  });
});

/**
 * 债务2(2026-08-13 立案): 调用释放与进程终止解耦
 *
 * 事故还原: 调用 2d033f73 在 75 分钟 TTL 后被 tracker 静默释放(active=0),
 * 但 isExpired 只删 map 不 abort——cursor-agent 进程(PID 38340)继续存活到
 * ~05:30 自然跑完,期间持续持有目标项目写权(同猫双进程残余路径);
 * cli-spawn 的 finally 树击杀因 generator 未结束、信号未到而从未执行。
 *
 * 契约: **释放槽位 ⇒ 进程树死亡**。tracker 任何强制释放路径(TTL 过期)都必须
 * 触发该调用的 AbortSignal → invoke-single-cat abortableNext → cli-spawn
 * killChild 树击杀。二者不允许解耦。
 */
describe('InvocationTracker TTL 释放必触发 AbortSignal(债务2)', () => {
  it('expired slot fires its AbortSignal when swept by has()', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(tracker.has('t1', 'opus'), false, 'slot must be released');
    assert.equal(controller.signal.aborted, true, 'release must abort the invocation signal');
    assert.equal(String(controller.signal.reason), 'slot_ttl_expired', 'abort reason must identify TTL expiry');
  });

  it('simulates provider stream still producing at release time: abort listener fires (kill chain entry)', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.start('t1', 'opus', 'user1');

    // provider 仍在产出 = 消费侧挂着 abort 监听(abortableNext / cli-spawn killChild)
    let killChainEntered = false;
    controller.signal.addEventListener('abort', () => {
      killChainEntered = true;
    });

    t.mock.timers.tick(SHORT_TTL + 1);
    tracker.getActiveSlots('t1'); // 任意读路径触发 TTL 清理(队列 API / 看守巡检)

    assert.equal(killChainEntered, true, 'tracker release must reach the provider kill chain');
  });

  it('expiry via cross-thread read paths (countActiveForCat) also aborts', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(tracker.countActiveForCat('opus'), 0, 'expired slot must not count as active');
    assert.equal(controller.signal.aborted, true, 'cross-thread sweep must abort too');
  });

  it('startAll batch expiry aborts the primary execution controller', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const primaryController = tracker.startAll('t1', ['catA', 'catB'], 'user1');

    t.mock.timers.tick(SHORT_TTL + 1);
    assert.equal(tracker.has('t1'), false, 'batch slots must be released');
    assert.equal(primaryController.signal.aborted, true, 'primary execution signal must be aborted');
  });

  it('normal complete() does NOT abort (regression: completion is not a forced release)', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.start('t1', 'opus', 'user1');

    tracker.complete('t1', 'opus', controller);
    assert.equal(tracker.has('t1', 'opus'), false, 'slot must be gone after completion');
    assert.equal(controller.signal.aborted, false, 'normal completion must not fire abort');
  });

  it('fresh slot within TTL keeps its signal live (no premature kill)', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const tracker = new InvocationTracker({ maxSlotTtlMs: SHORT_TTL });
    const controller = tracker.start('t1', 'opus', 'user1');

    t.mock.timers.tick(SHORT_TTL - 100);
    assert.ok(tracker.has('t1', 'opus'), 'slot within TTL stays active');
    assert.equal(controller.signal.aborted, false, 'live invocation must not be aborted');
  });
});
