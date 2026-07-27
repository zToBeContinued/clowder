/**
 * Task State Machine (毛线球状态机)
 *
 * 显式定义任务状态合法转换表。
 * 设计原则：
 * - done/failed 是终态，不可回退到 doing/todo（语义上「完成」一旦发出就不可撤回）
 * - 如果需要重做，应创建新任务并关联 retryOf/branchOf
 * - blocked ↔ doing 允许但有频率限制（防抖动）
 * - needs_attention 是系统自动状态，不由猫手动切入
 */

import type { TaskStatus } from './task.js';

/**
 * 扩展状态：增加 needs_attention（超时/owner失联时系统自动标记）
 */
export type TaskStatusExtended = TaskStatus | 'needs_attention';

/**
 * 合法状态转换表。
 * key = 当前状态，value = 允许转到的状态集合。
 *
 * 不在表中的转换一律拒绝（返回 409）。
 */
export const TASK_VALID_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  todo: ['doing', 'blocked', 'done', 'failed'],
  doing: ['in_review', 'blocked', 'done', 'failed', 'todo'],
  in_review: ['doing', 'done', 'failed', 'blocked'],
  blocked: ['doing', 'todo', 'failed'],
  // done 是终态：不允许回退到 doing/todo/in_review
  // 如需重做应创建 retryOf 新任务
  done: ['failed'],
  // failed 可以通过创建 retryOf 新任务来"重试"
  // 仅允许切回 todo（重开）作为兜底
  failed: ['todo'],
} as const;

/**
 * 校验状态转换是否合法。
 * @returns null 表示合法，否则返回错误描述
 */
export function validateStatusTransition(
  from: TaskStatus,
  to: TaskStatus,
): { valid: true } | { valid: false; reason: string } {
  if (from === to) return { valid: true }; // 无变化，允许（幂等）

  const allowed = TASK_VALID_TRANSITIONS[from];
  if (!allowed) {
    return { valid: false, reason: `Unknown source status: ${from}` };
  }

  if (allowed.includes(to)) {
    return { valid: true };
  }

  return {
    valid: false,
    reason: `Transition ${from} → ${to} is not allowed. Allowed from '${from}': [${allowed.join(', ')}]. If the task needs to be redone after completion, create a new task with retryOf link.`,
  };
}

/**
 * 状态抖动检测：检查事件历史中是否存在高频反复切换。
 * @param events - 任务事件数组
 * @param windowMs - 检测窗口（默认 30 分钟）
 * @param maxFlips - 窗口内允许的最大切换次数（默认 4 次）
 * @returns true 表示检测到抖动
 */
export function detectStatusFlapping(
  events: readonly { ts: string; type: string; data?: Record<string, unknown> }[],
  windowMs = 30 * 60 * 1000,
  maxFlips = 4,
): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;

  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event || event.type !== 'status_changed') continue;
    const eventTime = new Date(event.ts).getTime();
    if (eventTime < cutoff) continue; // 容忍乱序事件，不 break
    count++;
    if (count >= maxFlips) return true;
  }

  return false;
}
