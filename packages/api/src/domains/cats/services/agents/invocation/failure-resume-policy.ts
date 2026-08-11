/**
 * 失败自动续跑策略（纯决策，无副作用）。
 *
 * 背景：无人值守的 A2A 接力 / 派工中，某只猫的 CLI 偶发异常退出（cursor
 * exit code 1 等瞬态崩溃）后，那一棒就停了——球僵在它手里，没有下一棒，
 * 铲屎官必须回到网页手动重发。本策略让队列在这种失败后自动让同一只猫
 * resume 续跑一次（带退避），耗尽仍失败则明确通知铲屎官，不再静默卡死。
 *
 * 只对「自动执行（autoExecute）且来源为 agent（A2A/派工）」的条目生效：
 * 用户手动发的消息失败时用户在场，不自动烧额度重试。
 */

export type FailureResumeInput = {
  /** executeEntry 的终态 */
  readonly status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user';
  /** 条目是否为无人值守自动执行 */
  readonly autoExecute: boolean;
  /** 条目来源：只有 agent（A2A/派工）续跑 */
  readonly source: 'user' | 'connector' | 'agent';
  /** 该 (thread×cat) 槽位已用的续跑次数 */
  readonly usedRetries: number;
  /** 上限（env CAT_CAFE_AUTO_RESUME_ON_FAILURE，默认 1；≤0 关闭） */
  readonly maxRetries: number;
};

/**
 * - `resume`：重新入队同猫续跑（调用方随后 +1 计数并退避入队）
 * - `notify`：续跑已耗尽，通知铲屎官介入（调用方随后清零计数）
 * - `clear`：成功/用户取消，清零计数
 * - `ignore`：不关心（非终态失败、非自动执行、来源非 agent、已关闭）
 */
export type FailureResumeDecision = 'resume' | 'notify' | 'clear' | 'ignore';

export function decideFailureResume(input: FailureResumeInput): FailureResumeDecision {
  const { status, autoExecute, source, usedRetries, maxRetries } = input;

  // 成功 / 用户主动取消 → 清零，后续该槽位重新计数
  if (status === 'succeeded' || status === 'canceled_by_user') return 'clear';
  // 系统取消（抢占等）→ 不续跑也不通知；顺带清零避免陈旧计数
  if (status === 'canceled') return 'clear';
  if (status !== 'failed') return 'ignore';

  // 只对无人值守的 agent 自动执行续跑；用户手动消息失败不自动重试
  if (!autoExecute || source !== 'agent') return 'ignore';
  if (!(maxRetries > 0)) return 'ignore';

  if (usedRetries >= maxRetries) return 'notify';
  return 'resume';
}

/** 上限：env CAT_CAFE_AUTO_RESUME_ON_FAILURE，默认 1，≤0 关闭。 */
export function getAutoResumeMaxRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CAT_CAFE_AUTO_RESUME_ON_FAILURE);
  if (!Number.isFinite(raw)) return 1;
  return raw;
}

/** 续跑退避毫秒：env CAT_CAFE_AUTO_RESUME_DELAY_MS，默认 15000。 */
export function getAutoResumeDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CAT_CAFE_AUTO_RESUME_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}
