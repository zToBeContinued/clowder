/**
 * 2026-08-13 现场回归:fable 一条消息同时 @ opus 和 sol,队列按接收方拆成
 * 两条条目(幂等键不同,派发语义正确),但面板把同一份正文渲染两遍,
 * 被铲屎官读成「两条一模一样的消息又重复了」。UI 需要标注同源扇出关系。
 */
import { describe, expect, it } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { annotateFanOut } from '../queue-fanout';

function entry(partial: Partial<QueueEntry> & { id: string }): QueueEntry {
  return {
    threadId: 't1',
    userId: 'default-user',
    content: '同一段很长的传球正文',
    messageId: null,
    mergedMessageIds: [],
    source: 'agent',
    targetCats: ['cat-a'],
    intent: 'execute',
    status: 'queued',
    createdAt: 1,
    ...partial,
  };
}

describe('annotateFanOut', () => {
  it('同一条源消息扇出给两只猫 → 两条都标注 total=2,第二条是前一条的兄弟', () => {
    const entries = [
      entry({ id: 'e1', messageId: 'm-9', callerCatId: 'fable', targetCats: ['opus'] }),
      entry({ id: 'e2', messageId: 'm-9', callerCatId: 'fable', targetCats: ['sol'] }),
    ];
    const info = annotateFanOut(entries);
    expect(info[0]).toEqual({ total: 2, position: 1, siblingOfPrevious: false });
    expect(info[1]).toEqual({ total: 2, position: 2, siblingOfPrevious: true });
  });

  it('不同源消息互不影响,单条扇出不标注', () => {
    const entries = [
      entry({ id: 'e1', messageId: 'm-1', callerCatId: 'fable', targetCats: ['sol'] }),
      entry({ id: 'e2', messageId: 'm-2', callerCatId: 'fable', targetCats: ['opus'] }),
    ];
    const info = annotateFanOut(entries);
    expect(info[0]).toBeNull();
    expect(info[1]).toBeNull();
  });

  it('中间隔了别的条目 → 同源仍计入 total,但不算相邻兄弟(正文照常显示)', () => {
    const entries = [
      entry({ id: 'e1', messageId: 'm-9', callerCatId: 'fable', targetCats: ['opus'] }),
      entry({ id: 'e2', messageId: 'm-5', callerCatId: 'sol', targetCats: ['fable'] }),
      entry({ id: 'e3', messageId: 'm-9', callerCatId: 'fable', targetCats: ['sol'] }),
    ];
    const info = annotateFanOut(entries);
    expect(info[0]).toEqual({ total: 2, position: 1, siblingOfPrevious: false });
    expect(info[1]).toBeNull();
    expect(info[2]).toEqual({ total: 2, position: 2, siblingOfPrevious: false });
  });

  it('用户消息与无 messageId 的条目从不标注', () => {
    const entries = [
      entry({ id: 'e1', source: 'user', messageId: 'm-9' }),
      entry({ id: 'e2', source: 'user', messageId: 'm-9' }),
      entry({ id: 'e3', messageId: null, callerCatId: 'fable' }),
    ];
    const info = annotateFanOut(entries);
    expect(info).toEqual([null, null, null]);
  });
});
