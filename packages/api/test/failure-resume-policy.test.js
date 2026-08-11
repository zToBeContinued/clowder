import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { decideFailureResume, getAutoResumeMaxRetries, getAutoResumeDelayMs } = await import(
  '../dist/domains/cats/services/agents/invocation/failure-resume-policy.js'
);

const base = { autoExecute: true, source: 'agent', usedRetries: 0, maxRetries: 1 };

describe('decideFailureResume', () => {
  it('成功 / 用户取消 → clear（清零重试计数）', () => {
    assert.equal(decideFailureResume({ ...base, status: 'succeeded' }), 'clear');
    assert.equal(decideFailureResume({ ...base, status: 'canceled_by_user' }), 'clear');
  });

  it('系统取消 → clear（不续跑不通知）', () => {
    assert.equal(decideFailureResume({ ...base, status: 'canceled' }), 'clear');
  });

  it('失败 + 无人值守 agent + 未耗尽 → resume', () => {
    assert.equal(decideFailureResume({ ...base, status: 'failed', usedRetries: 0, maxRetries: 1 }), 'resume');
  });

  it('失败 + 已耗尽 → notify（通知铲屎官）', () => {
    assert.equal(decideFailureResume({ ...base, status: 'failed', usedRetries: 1, maxRetries: 1 }), 'notify');
  });

  it('失败 + 非自动执行 → ignore（用户在场,不自动烧额度）', () => {
    assert.equal(decideFailureResume({ ...base, status: 'failed', autoExecute: false }), 'ignore');
  });

  it('失败 + 来源为 user → ignore（只对 A2A/派工续跑）', () => {
    assert.equal(decideFailureResume({ ...base, status: 'failed', source: 'user' }), 'ignore');
  });

  it('失败 + 来源为 connector → ignore', () => {
    assert.equal(decideFailureResume({ ...base, status: 'failed', source: 'connector' }), 'ignore');
  });

  it('maxRetries<=0（关闭）→ ignore', () => {
    assert.equal(decideFailureResume({ ...base, status: 'failed', maxRetries: 0 }), 'ignore');
    assert.equal(decideFailureResume({ ...base, status: 'failed', maxRetries: -1 }), 'ignore');
  });

  it('续跑上限可 >1：用尽前每次 resume,达到即 notify', () => {
    const mk = (used) => decideFailureResume({ ...base, status: 'failed', usedRetries: used, maxRetries: 2 });
    assert.equal(mk(0), 'resume');
    assert.equal(mk(1), 'resume');
    assert.equal(mk(2), 'notify');
  });
});

describe('env 读取', () => {
  it('getAutoResumeMaxRetries 默认 1,可配', () => {
    assert.equal(getAutoResumeMaxRetries({}), 1);
    assert.equal(getAutoResumeMaxRetries({ CAT_CAFE_AUTO_RESUME_ON_FAILURE: '3' }), 3);
    assert.equal(getAutoResumeMaxRetries({ CAT_CAFE_AUTO_RESUME_ON_FAILURE: '0' }), 0);
    assert.equal(getAutoResumeMaxRetries({ CAT_CAFE_AUTO_RESUME_ON_FAILURE: 'x' }), 1);
  });

  it('getAutoResumeDelayMs 默认 15000,可配', () => {
    assert.equal(getAutoResumeDelayMs({}), 15_000);
    assert.equal(getAutoResumeDelayMs({ CAT_CAFE_AUTO_RESUME_DELAY_MS: '3000' }), 3000);
    assert.equal(getAutoResumeDelayMs({ CAT_CAFE_AUTO_RESUME_DELAY_MS: 'x' }), 15_000);
  });
});
