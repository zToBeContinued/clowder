'use client';

import { useCountUp } from '@/hooks/useCountUp';
import type { ContextHealthData, TokenUsage } from '@/stores/chat-types';
import { isInvocationCostPanelEnabled } from '@/utils/invocationCostPanel';
import { getUsageRisk } from '@/utils/usageRisk';
import { ContextHealthBar } from './ContextHealthBar';
import { formatCost, formatDuration, formatTokenCount } from './status-helpers';
import { TokenCacheBar } from './TokenCacheBar';

export interface CatTokenUsageProps {
  catId: string;
  usage: TokenUsage;
  /** F24: Context health data */
  contextHealth?: ContextHealthData;
}

const CAT_TEXT_COLORS: Record<string, string> = {
  opus: 'text-opus-dark',
  codex: 'text-codex-dark',
  gemini: 'text-gemini-dark',
  dare: 'text-dare-dark',
};

function cachePercent(usage: TokenUsage): number {
  if (!usage.cacheReadTokens || !usage.inputTokens) return 0;
  return Math.round((usage.cacheReadTokens / usage.inputTokens) * 100);
}

function AnimatedTokenCount({ value, label }: { value: number; label: string }) {
  const display = useCountUp(value);
  return (
    <span className="tabular-nums" title={`${label}: ${value.toLocaleString()}`}>
      {formatTokenCount(display)}
    </span>
  );
}

function formatContextWindowShort(value: number): string {
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return value.toLocaleString();
}

function formatMonthDay(tsMs: number): string {
  const date = new Date(tsMs);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/**
 * F8: Per-cat token usage dashboard card.
 * Dynamic display with count-up animations, cache progress bar, and brand colors.
 */
export function CatTokenUsage({ catId, usage, contextHealth }: CatTokenUsageProps) {
  const hasDetailed = usage.inputTokens != null || usage.outputTokens != null;
  const hasTotalOnly = !hasDetailed && usage.totalTokens != null;
  const deliveryOnlyWarning = usage.deliveryOnlyMode === 'degraded';

  if (!hasDetailed && !hasTotalOnly && !deliveryOnlyWarning) return null;

  const textColor = CAT_TEXT_COLORS[catId] ?? 'text-cafe-secondary';
  const cachePct = cachePercent(usage);
  const hasExactContextSummary =
    usage.contextUsedTokens != null && usage.contextWindowSize != null && usage.contextWindowSize > 0;
  const contextLeftPct = hasExactContextSummary
    ? Math.max(0, Math.round((1 - usage.contextUsedTokens! / usage.contextWindowSize!) * 100))
    : null;
  const contextSummary = hasExactContextSummary
    ? `Context: ${contextLeftPct}% left (${usage.contextUsedTokens?.toLocaleString()} used / ${formatContextWindowShort(usage.contextWindowSize!)})`
    : null;
  const contextResetDay = usage.contextResetsAtMs != null ? formatMonthDay(usage.contextResetsAtMs) : '';
  const contextResetLabel = contextResetDay ? `(resets ${contextResetDay})` : null;
  const showCostPanel = isInvocationCostPanelEnabled();
  const usageRisk = getUsageRisk(usage);

  return (
    <div className="mt-1.5 space-y-1 animate-fade-in" data-testid={`token-usage-${catId}`}>
      {/* Token counts row */}
      <div className="flex items-baseline gap-2 font-mono text-[11px]">
        {hasDetailed && (
          <>
            {usage.inputTokens != null && (
              <span className={textColor}>
                <AnimatedTokenCount value={usage.inputTokens} label="Input" />
                <span className="text-cafe-muted ml-0.5">↓</span>
              </span>
            )}
            {usage.outputTokens != null && (
              <span className="text-cafe-secondary">
                <AnimatedTokenCount value={usage.outputTokens} label="Output" />
                <span className="text-cafe-muted ml-0.5">↑</span>
              </span>
            )}
          </>
        )}
        {hasTotalOnly && usage.totalTokens != null && (
          <span className={textColor}>
            <AnimatedTokenCount value={usage.totalTokens} label="Total" />
            <span className="text-cafe-muted ml-0.5">tok</span>
          </span>
        )}
      </div>

      {deliveryOnlyWarning && (
        <div className="text-[10px] text-conn-amber-text [overflow-wrap:anywhere]">
          ⚠ deliveryOnly 降级 · {usage.deliveryOnlyDegradedIssue ?? 'unknown'}
        </div>
      )}

      {/* Cache bar */}
      {cachePct > 0 && (
        <div>
          <div className="text-[10px] text-cafe-muted mb-0.5">缓存命中</div>
          <TokenCacheBar percent={cachePct} catId={catId} />
        </div>
      )}

      {/* Cost + duration row */}
      <div className="flex items-center gap-2 text-[10px]">
        {showCostPanel && usage.cacheReadTokens != null && (
          <span className="text-conn-emerald-text tabular-nums">
            cacheRead {formatTokenCount(usage.cacheReadTokens)}
          </span>
        )}
        {showCostPanel && usage.cacheCreationTokens != null && (
          <span className="text-cafe-muted tabular-nums">
            cacheCreate {formatTokenCount(usage.cacheCreationTokens)}
          </span>
        )}
        {usage.costUsd != null && (
          <span className="text-conn-amber-text font-medium tabular-nums animate-cost-glow">
            {formatCost(usage.costUsd)}
          </span>
        )}
        {usage.numTurns != null && usage.numTurns > 1 && (
          <span className="text-cafe-muted">{usage.numTurns} turns</span>
        )}
        {usage.durationApiMs != null && (
          <span className="text-cafe-muted">API {formatDuration(usage.durationApiMs)}</span>
        )}
        {showCostPanel && usage.durationMs != null && (
          <span className="text-cafe-muted">duration {formatDuration(usage.durationMs)}</span>
        )}
        {usageRisk && (
          <span
            className="rounded-full border border-conn-red-text/40 bg-conn-red-bg px-1.5 py-0.5 font-semibold text-conn-red-text"
            title={usageRisk.reason}
          >
            {usageRisk.label}
          </span>
        )}
        {showCostPanel && usage.budgetGateTriggered && (
          <span
            className="rounded-full border border-conn-amber-text/40 bg-conn-amber-bg/40 px-1.5 py-0.5 font-semibold text-conn-amber-text"
            title={
              usage.historyFullTokensBeforeGate != null
                ? `裁剪前历史约 ${usage.historyFullTokensBeforeGate.toLocaleString()} tokens`
                : '本轮触发 Claude 预算闸门，已丢弃旧 resume session'
            }
          >
            预算闸门
            {usage.historyFullTokensBeforeGate != null
              ? ` · 裁剪前 ${formatTokenCount(usage.historyFullTokensBeforeGate)}`
              : ''}
          </span>
        )}
      </div>

      {contextSummary && (
        <div className="text-[10px] text-cafe-secondary font-mono">
          {contextSummary}
          {contextResetLabel && <span className="text-cafe-muted ml-1">{contextResetLabel}</span>}
        </div>
      )}

      {/* F24: Context health bar */}
      {contextHealth && (
        <div>
          <div className="text-[10px] text-cafe-muted mb-0.5">上下文占用</div>
          <ContextHealthBar catId={catId} health={contextHealth} />
        </div>
      )}
    </div>
  );
}
