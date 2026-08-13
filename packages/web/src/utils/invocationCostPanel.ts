import type { TaskEvent, TaskItem } from '@cat-cafe/shared';
import type {
  HistoryGovernanceMode,
  PromptSource,
  PromptSourceBreakdown,
  PromptSourceBreakdownItem,
} from '@/stores/chat-types';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const PROMPT_SOURCES = new Set<PromptSource>(['history', 'project', 'skill', 'rules', 'memory']);

export interface InvocationUsageSummary {
  catId: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  durationApiMs?: number;
  sourceBreakdown?: PromptSourceBreakdown;
  historyMode?: HistoryGovernanceMode;
  historyFullTokens?: number;
  historySummaryTokens?: number;
  historyBudgetRatio?: number;
  summarySegmentId?: string;
  historyGovernanceDegraded?: boolean;
  deliveryOnlyMode?: 'active' | 'degraded';
  deliveryOnlyDegradedIssue?:
    | 'missing_trigger'
    | 'missing_summary'
    | 'summary_quality_failed'
    | 'summary_budget_exhausted'
    | 'unrevealed_whisper';
  budgetGateTriggered?: boolean;
  historyFullTokensBeforeGate?: number;
}

export function isInvocationCostPanelEnabled(): boolean {
  const value =
    process.env.NEXT_PUBLIC_CAT_CAFE_INVOCATION_COST_PANEL ?? process.env.NEXT_PUBLIC_CAT_CAFE_USAGE_COST_PANEL ?? '';
  return ENABLED_VALUES.has(value.trim().toLowerCase());
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asHistoryMode(value: unknown): HistoryGovernanceMode | undefined {
  return value === 'observe' || value === 'shadow-summary' || value === 'summary-active' ? value : undefined;
}

function asDeliveryOnlyIssue(value: unknown): InvocationUsageSummary['deliveryOnlyDegradedIssue'] {
  return value === 'missing_trigger' ||
    value === 'missing_summary' ||
    value === 'summary_quality_failed' ||
    value === 'summary_budget_exhausted' ||
    value === 'unrevealed_whisper'
    ? value
    : undefined;
}

function readSourceBreakdown(value: unknown): PromptSourceBreakdown | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { totalEstimatedTokens?: unknown; sources?: unknown };
  if (!Array.isArray(raw.sources)) return undefined;
  const sources: PromptSourceBreakdownItem[] = raw.sources
    .map((item): PromptSourceBreakdownItem | null => {
      if (!item || typeof item !== 'object') return null;
      const parsed = item as { source?: unknown; chars?: unknown; estimatedTokens?: unknown };
      if (typeof parsed.source !== 'string' || !PROMPT_SOURCES.has(parsed.source as PromptSource)) return null;
      const estimatedTokens = asNumber(parsed.estimatedTokens);
      if (estimatedTokens == null || estimatedTokens <= 0) return null;
      return {
        source: parsed.source as PromptSource,
        chars: asNumber(parsed.chars) ?? 0,
        estimatedTokens,
      };
    })
    .filter((item): item is PromptSourceBreakdownItem => item != null);
  if (sources.length === 0) return undefined;
  const totalEstimatedTokens =
    asNumber(raw.totalEstimatedTokens) ?? sources.reduce((sum, source) => sum + source.estimatedTokens, 0);
  return { totalEstimatedTokens, sources };
}

function mergeSourceBreakdown(
  current: PromptSourceBreakdown | undefined,
  incoming: PromptSourceBreakdown | undefined,
): PromptSourceBreakdown | undefined {
  if (!incoming) return current;
  const bySource = new Map<PromptSource, PromptSourceBreakdownItem>();
  for (const item of [...(current?.sources ?? []), ...incoming.sources]) {
    const existing = bySource.get(item.source);
    bySource.set(item.source, {
      source: item.source,
      chars: (existing?.chars ?? 0) + item.chars,
      estimatedTokens: (existing?.estimatedTokens ?? 0) + item.estimatedTokens,
    });
  }
  const sources = Array.from(bySource.values()).filter((item) => item.estimatedTokens > 0);
  const totalEstimatedTokens = sources.reduce((sum, source) => sum + source.estimatedTokens, 0);
  return totalEstimatedTokens > 0 ? { totalEstimatedTokens, sources } : undefined;
}

function readUsageEvent(event: TaskEvent): InvocationUsageSummary | null {
  if (event.type !== 'usage') return null;
  const data = event.data ?? {};
  const inputTokens = asNumber(data.inputTokens);
  const outputTokens = asNumber(data.outputTokens);
  const totalTokens = asNumber(data.totalTokens) ?? ((inputTokens ?? 0) + (outputTokens ?? 0) || undefined);
  const summary: InvocationUsageSummary = {
    catId: event.catId,
    provider: asString(data.provider),
    model: asString(data.model),
    inputTokens,
    cacheReadTokens: asNumber(data.cacheReadTokens),
    cacheCreationTokens: asNumber(data.cacheCreationTokens),
    outputTokens,
    totalTokens,
    costUsd: asNumber(data.costUsd),
    durationMs: asNumber(data.durationMs),
    durationApiMs: asNumber(data.durationApiMs),
    sourceBreakdown: readSourceBreakdown(data.sourceBreakdown),
  };
  const historyMode = asHistoryMode(data.historyMode);
  if (historyMode) summary.historyMode = historyMode;
  const historyFullTokens = asNumber(data.historyFullTokens);
  if (historyFullTokens != null) summary.historyFullTokens = historyFullTokens;
  const historySummaryTokens = asNumber(data.historySummaryTokens);
  if (historySummaryTokens != null) summary.historySummaryTokens = historySummaryTokens;
  const historyBudgetRatio = asNumber(data.historyBudgetRatio);
  if (historyBudgetRatio != null) summary.historyBudgetRatio = historyBudgetRatio;
  const summarySegmentId = asString(data.summarySegmentId);
  if (summarySegmentId) summary.summarySegmentId = summarySegmentId;
  if (typeof data.historyGovernanceDegraded === 'boolean') {
    summary.historyGovernanceDegraded = data.historyGovernanceDegraded;
  }
  if (data.deliveryOnlyMode === 'active' || data.deliveryOnlyMode === 'degraded') {
    summary.deliveryOnlyMode = data.deliveryOnlyMode;
  }
  const deliveryOnlyDegradedIssue = asDeliveryOnlyIssue(data.deliveryOnlyDegradedIssue);
  if (deliveryOnlyDegradedIssue) summary.deliveryOnlyDegradedIssue = deliveryOnlyDegradedIssue;
  if (typeof data.budgetGateTriggered === 'boolean') {
    summary.budgetGateTriggered = data.budgetGateTriggered;
  }
  const historyFullTokensBeforeGate = asNumber(data.historyFullTokensBeforeGate);
  if (historyFullTokensBeforeGate != null) {
    summary.historyFullTokensBeforeGate = historyFullTokensBeforeGate;
  }
  const hasSignal =
    summary.inputTokens != null ||
    summary.outputTokens != null ||
    summary.totalTokens != null ||
    summary.cacheReadTokens != null ||
    summary.cacheCreationTokens != null ||
    summary.costUsd != null ||
    summary.durationMs != null ||
    summary.durationApiMs != null ||
    summary.sourceBreakdown != null ||
    summary.historyMode != null ||
    summary.historyFullTokens != null ||
    summary.historySummaryTokens != null ||
    summary.historyBudgetRatio != null ||
    summary.summarySegmentId != null ||
    summary.historyGovernanceDegraded != null ||
    summary.deliveryOnlyMode != null ||
    summary.deliveryOnlyDegradedIssue != null ||
    summary.budgetGateTriggered != null ||
    summary.historyFullTokensBeforeGate != null;
  return hasSignal ? summary : null;
}

export function readTaskUsageSummaries(task: TaskItem): InvocationUsageSummary[] {
  return (task.events ?? []).map(readUsageEvent).filter((event): event is InvocationUsageSummary => event != null);
}

export function summarizeTaskUsage(events: readonly InvocationUsageSummary[]): InvocationUsageSummary | null {
  if (events.length === 0) return null;
  const total: InvocationUsageSummary = { catId: events.length === 1 ? events[0].catId : `${events.length} turns` };
  for (const event of events) {
    total.inputTokens = (total.inputTokens ?? 0) + (event.inputTokens ?? 0);
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + (event.cacheReadTokens ?? 0);
    total.cacheCreationTokens = (total.cacheCreationTokens ?? 0) + (event.cacheCreationTokens ?? 0);
    total.outputTokens = (total.outputTokens ?? 0) + (event.outputTokens ?? 0);
    total.totalTokens = (total.totalTokens ?? 0) + (event.totalTokens ?? 0);
    total.costUsd = (total.costUsd ?? 0) + (event.costUsd ?? 0);
    total.durationMs = (total.durationMs ?? 0) + (event.durationMs ?? 0);
    total.durationApiMs = (total.durationApiMs ?? 0) + (event.durationApiMs ?? 0);
    total.sourceBreakdown = mergeSourceBreakdown(total.sourceBreakdown, event.sourceBreakdown);
    if (event.historyMode != null) total.historyMode = event.historyMode;
    if (event.historyFullTokens != null) total.historyFullTokens = event.historyFullTokens;
    if (event.historySummaryTokens != null) total.historySummaryTokens = event.historySummaryTokens;
    if (event.historyBudgetRatio != null) total.historyBudgetRatio = event.historyBudgetRatio;
    if (event.summarySegmentId != null) total.summarySegmentId = event.summarySegmentId;
    if (event.historyGovernanceDegraded != null) {
      total.historyGovernanceDegraded = event.historyGovernanceDegraded;
    }
    if (event.deliveryOnlyMode === 'degraded') {
      total.deliveryOnlyMode = 'degraded';
      if (event.deliveryOnlyDegradedIssue) {
        total.deliveryOnlyDegradedIssue = event.deliveryOnlyDegradedIssue;
      }
    } else if (event.deliveryOnlyMode === 'active' && total.deliveryOnlyMode !== 'degraded') {
      total.deliveryOnlyMode = 'active';
    }
    if (event.budgetGateTriggered != null) {
      total.budgetGateTriggered = total.budgetGateTriggered === true || event.budgetGateTriggered;
    }
    if (event.historyFullTokensBeforeGate != null) {
      total.historyFullTokensBeforeGate = (total.historyFullTokensBeforeGate ?? 0) + event.historyFullTokensBeforeGate;
    }
  }
  return total;
}
