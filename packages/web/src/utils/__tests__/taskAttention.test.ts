import type { TaskItem } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { countAttentionTasks, getTaskAttentionToast, isTaskAttentionStatus } from '../taskAttention';

function task(overrides: Partial<TaskItem>): TaskItem {
  return {
    id: 't1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: null,
    title: 'Fix deploy',
    why: '',
    createdBy: 'user',
    createdAt: 1,
    updatedAt: 1,
    ownerCatId: null,
    status: 'todo',
    ...overrides,
  };
}

describe('taskAttention', () => {
  it('marks only human-attention statuses as actionable', () => {
    expect(isTaskAttentionStatus('in_review')).toBe(true);
    expect(isTaskAttentionStatus('blocked')).toBe(true);
    expect(isTaskAttentionStatus('failed')).toBe(true);
    expect(isTaskAttentionStatus('doing')).toBe(false);
    expect(isTaskAttentionStatus('todo')).toBe(false);
    expect(isTaskAttentionStatus('done')).toBe(false);
  });

  it('counts attention tasks but excludes PR tracking automation', () => {
    const tasks = [
      task({ id: 'review', status: 'in_review' }),
      task({ id: 'blocked', status: 'blocked' }),
      task({ id: 'pr', kind: 'pr_tracking', status: 'failed' }),
      task({ id: 'done', status: 'done' }),
    ];
    expect(countAttentionTasks(tasks)).toBe(2);
  });

  it('formats toast for review, blocked, and failed tasks', () => {
    expect(getTaskAttentionToast(task({ status: 'in_review' }))).toMatchObject({
      type: 'success',
      title: '任务待验收',
    });
    expect(getTaskAttentionToast(task({ status: 'blocked' }))).toMatchObject({ type: 'error', title: '任务阻塞' });
    expect(getTaskAttentionToast(task({ status: 'failed' }))).toMatchObject({ type: 'error', title: '任务失败' });
    expect(getTaskAttentionToast(task({ status: 'doing' }))).toBeNull();
  });
});
