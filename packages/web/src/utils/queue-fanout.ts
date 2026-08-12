/**
 * 队列扇出标注(2026-08-13「队列里两条一模一样的消息」误读修复)。
 *
 * 一条 A2A 消息行首 @ 多只猫时,路由为每个接收方生成一条独立队列条目
 * (各自的幂等键、各自的接棒生命周期)——数据正确,但两条条目携带同一份
 * 正文,面板原样渲染两遍会被读成「消息重复了」。本工具按「发起猫 + 触发
 * 消息 ID」识别同源扇出组,供 UI 合并/降噪显示,不改动任何派发语义。
 */
import type { QueueEntry } from '@/stores/chat-types';

export interface FanOutInfo {
  /** 同源扇出条目总数(仅 total>1 的组才会被标注) */
  total: number;
  /** 本条在组内的序号(1-based,按当前列表顺序) */
  position: number;
  /** 与列表中紧邻的前一条同源 → 渲染时可省略重复正文 */
  siblingOfPrevious: boolean;
}

/** 分组键:A2A 扇出条目共享同一条触发消息与同一发起猫 */
function fanOutKey(entry: QueueEntry): string | null {
  if (entry.source !== 'agent' || !entry.messageId) return null;
  return `${entry.callerCatId ?? ''}::${entry.messageId}`;
}

/**
 * 为队列条目逐位标注同源扇出信息;非扇出条目(用户消息、单接收方、无
 * 触发消息 ID)对应位置为 null。返回数组与入参等长、按位对齐。
 */
export function annotateFanOut(entries: readonly QueueEntry[]): Array<FanOutInfo | null> {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const key = fanOutKey(entry);
    if (key) totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const positions = new Map<string, number>();
  return entries.map((entry, index) => {
    const key = fanOutKey(entry);
    if (!key) return null;
    const total = totals.get(key) ?? 1;
    if (total < 2) return null;
    const position = (positions.get(key) ?? 0) + 1;
    positions.set(key, position);
    const previousKey = index > 0 ? fanOutKey(entries[index - 1]) : null;
    return { total, position, siblingOfPrevious: previousKey === key };
  });
}
