'use client';

import type { TaskEvent, TaskItem, TaskStatus } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import type { PromptSource, PromptSourceBreakdown } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import {
  type InvocationUsageSummary,
  isInvocationCostPanelEnabled,
  readTaskUsageSummaries,
  summarizeTaskUsage,
} from '@/utils/invocationCostPanel';
import { getUsageRisk } from '@/utils/usageRisk';
import { CatAvatar } from './CatAvatar';
import { formatCost, formatDuration, formatTokenCount } from './status-helpers';

const SOURCE_LABELS: Record<PromptSource, string> = {
  history: 'history',
  project: 'project',
  skill: 'skill',
  rules: 'rules',
  memory: 'memory',
};

// Must follow the backend TASK_VALID_TRANSITIONS, otherwise clicking the pill
// PATCHes an illegal transition and 409s (looked like "点了没反应/卡住"):
//   done → only failed;  failed → only todo.
const STATUS_CYCLE: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'in_review',
  in_review: 'done',
  blocked: 'doing',
  done: 'failed',
  failed: 'todo',
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  in_review: '待验收',
  blocked: '阻塞中',
  done: '已完成',
  failed: '失败',
};

const STATUS_STYLES: Record<TaskStatus, { text: string; border: string; pillBg: string }> = {
  doing: {
    text: 'text-cafe-crosspost',
    border: 'border-l-cafe-crosspost',
    pillBg: 'bg-cafe-crosspost/10 text-cafe-crosspost',
  },
  blocked: {
    text: 'text-conn-red-text',
    border: 'border-l-conn-red-text',
    pillBg: 'bg-conn-red-bg text-conn-red-text',
  },
  in_review: {
    text: 'text-cafe-accent',
    border: 'border-l-cafe-accent',
    pillBg: 'bg-cafe-accent/10 text-cafe-accent',
  },
  todo: {
    text: 'text-cafe-muted',
    border: 'border-l-cafe-muted',
    pillBg: 'bg-cafe-surface-elevated text-cafe-muted',
  },
  done: {
    text: 'text-conn-emerald-text',
    border: 'border-l-green-600',
    pillBg: 'bg-conn-emerald-bg text-conn-emerald-text',
  },
  failed: {
    text: 'text-conn-red-text',
    border: 'border-l-conn-red-text',
    pillBg: 'bg-conn-red-bg text-conn-red-text',
  },
};

interface CapabilityOption {
  id: string;
  type: 'mcp' | 'skill' | 'limb';
  description?: string;
  enabled: boolean;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function UsageChip({ usage }: { usage: InvocationUsageSummary }) {
  const usageRisk = getUsageRisk(usage);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-cafe-muted">
      {usage.totalTokens != null && (
        <span className="rounded-full border border-[var(--console-border-soft)] bg-cafe-surface px-1.5 py-0.5 tabular-nums">
          {formatTokenCount(usage.totalTokens)} tok
        </span>
      )}
      {usage.costUsd != null && (
        <span className="rounded-full border border-conn-amber-text/40 bg-conn-amber-bg/40 px-1.5 py-0.5 text-conn-amber-text tabular-nums">
          {formatCost(usage.costUsd)}
        </span>
      )}
      {usage.durationMs != null && (
        <span className="rounded-full border border-[var(--console-border-soft)] bg-cafe-surface px-1.5 py-0.5 tabular-nums">
          {formatDuration(usage.durationMs)}
        </span>
      )}
      {usage.budgetGateTriggered && (
        <span className="rounded-full border border-conn-amber-text/40 bg-conn-amber-bg/40 px-1.5 py-0.5 text-conn-amber-text">
          预算闸门
          {usage.historyFullTokensBeforeGate != null
            ? ` · 裁剪前 ${formatTokenCount(usage.historyFullTokensBeforeGate)}`
            : ''}
        </span>
      )}
      {usage.deliveryOnlyMode === 'degraded' && (
        <span className="rounded-full border border-conn-amber-text/40 bg-conn-amber-bg/40 px-1.5 py-0.5 text-conn-amber-text [overflow-wrap:anywhere]">
          ⚠ deliveryOnly 降级 · {usage.deliveryOnlyDegradedIssue ?? 'unknown'}
        </span>
      )}
      {usageRisk && (
        <span
          className="rounded-full border border-conn-red-text/40 bg-conn-red-bg px-1.5 py-0.5 font-semibold text-conn-red-text"
          title={usageRisk.reason}
        >
          {usageRisk.label}
        </span>
      )}
    </div>
  );
}

function UsageDetailRow({ usage }: { usage: InvocationUsageSummary }) {
  const label = [usage.catId, usage.model].filter(Boolean).join(' · ');
  const usageRisk = getUsageRisk(usage);
  return (
    <div className="rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface px-2 py-1.5 text-[10px]">
      <div className="mb-1 flex items-center gap-1 text-cafe-muted">
        <span className="font-semibold text-cafe-secondary">{label || usage.catId}</span>
        {usage.provider && <span>· {usage.provider}</span>}
        {usageRisk && (
          <span
            className="rounded-full bg-conn-red-bg px-1.5 py-0.5 font-semibold text-conn-red-text"
            title={usageRisk.reason}
          >
            {usageRisk.label}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-cafe-muted tabular-nums">
        {usage.inputTokens != null && <span>input {formatTokenCount(usage.inputTokens)}</span>}
        {usage.cacheReadTokens != null && <span>cacheRead {formatTokenCount(usage.cacheReadTokens)}</span>}
        {usage.cacheCreationTokens != null && <span>cacheCreate {formatTokenCount(usage.cacheCreationTokens)}</span>}
        {usage.outputTokens != null && <span>output {formatTokenCount(usage.outputTokens)}</span>}
        {usage.costUsd != null && <span className="text-conn-amber-text">cost {formatCost(usage.costUsd)}</span>}
        {usage.durationMs != null && <span>duration {formatDuration(usage.durationMs)}</span>}
        {usage.historyMode === 'observe' && usage.historyFullTokens != null && (
          <span className="text-conn-amber-text">
            history {formatTokenCount(usage.historyFullTokens)}
            {usage.historyBudgetRatio != null ? ` · ${Math.round(usage.historyBudgetRatio * 100)}%` : ''}
          </span>
        )}
        {usage.budgetGateTriggered && (
          <span className="text-conn-amber-text">
            预算闸门已触发
            {usage.historyFullTokensBeforeGate != null
              ? ` · 裁剪前历史约 ${formatTokenCount(usage.historyFullTokensBeforeGate)}`
              : ''}
          </span>
        )}
        {usage.deliveryOnlyMode === 'degraded' && (
          <span className="col-span-2 text-conn-amber-text [overflow-wrap:anywhere]">
            ⚠ deliveryOnly 降级 · {usage.deliveryOnlyDegradedIssue ?? 'unknown'}
          </span>
        )}
      </div>
      {usage.sourceBreakdown && <UsageSourceBreakdown breakdown={usage.sourceBreakdown} />}
    </div>
  );
}

function UsageSourceBreakdown({ breakdown }: { breakdown: PromptSourceBreakdown }) {
  const sources = breakdown.sources
    .filter((source) => source.estimatedTokens > 0)
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  if (sources.length === 0 || breakdown.totalEstimatedTokens <= 0) return null;
  return (
    <div className="mt-1.5 border-t border-[var(--console-border-soft)] pt-1.5">
      <div className="mb-1 text-[10px] font-semibold text-cafe-muted">来源估算</div>
      <div className="flex flex-wrap gap-1">
        {sources.map((source) => {
          const ratio = Math.round((source.estimatedTokens / breakdown.totalEstimatedTokens) * 100);
          return (
            <span
              key={source.source}
              className="rounded-full border border-[var(--console-border-soft)] bg-cafe-surface-elevated px-1.5 py-0.5 text-[10px] text-cafe-muted tabular-nums"
            >
              {SOURCE_LABELS[source.source]} {ratio}% · {formatTokenCount(source.estimatedTokens)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function isControlledExternalTool(item: {
  id: string;
  description?: string;
  mcpServer?: { command?: string; args?: string[]; url?: string };
}): boolean {
  const haystack = [
    item.id,
    item.description,
    item.mcpServer?.command,
    item.mcpServer?.url,
    ...(item.mcpServer?.args ?? []),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return /opencli|figma/.test(haystack);
}

function readCapabilityEvents(
  events: readonly TaskEvent[] | undefined,
  type: 'capability_authorized' | 'capability_usage',
) {
  return (events ?? []).filter((event) => event.type === type);
}

function CapabilityTaskPanel({ task }: { task: TaskItem }) {
  const [capabilities, setCapabilities] = useState<CapabilityOption[]>([]);
  const [events, setEvents] = useState<readonly TaskEvent[]>(task.events ?? []);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEvents(task.events ?? []);
  }, [task.events]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch('/api/capabilities')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as {
          items?: Array<CapabilityOption & { mcpServer?: { command?: string; args?: string[]; url?: string } }>;
        };
      })
      .then((data) => {
        if (cancelled) return;
        setCapabilities(
          (data.items ?? [])
            .filter((item) => item.type === 'mcp' && isControlledExternalTool(item))
            .map((item) => ({
              id: item.id,
              type: item.type,
              description: item.description,
              enabled: item.enabled,
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setError('外部工具能力加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const authorizationEvents = useMemo(() => readCapabilityEvents(events, 'capability_authorized'), [events]);
  const usageEvents = useMemo(() => readCapabilityEvents(events, 'capability_usage'), [events]);
  const authorized = useMemo(
    () =>
      new Set(
        authorizationEvents
          .map((event) => event.data?.capabilityId)
          .filter((value): value is string => typeof value === 'string' && value.length > 0),
      ),
    [authorizationEvents],
  );

  async function authorize(capability: CapabilityOption) {
    setBusyId(capability.id);
    setError(null);
    try {
      const res = await apiFetch(`/api/tasks/${task.id}/capability-authorizations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          capabilityId: capability.id,
          capabilityType: capability.type,
          reason: `Task-scoped authorization for ${task.title}`,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `授权失败 (${res.status})`);
        return;
      }
      const data = (await res.json()) as { task?: TaskItem };
      setEvents(data.task?.events ?? events);
    } catch {
      setError('授权请求失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface px-2 py-2 text-[10px]">
      <div className="flex items-center justify-between gap-2">
        <p className="font-semibold text-cafe-secondary">外部工具授权</p>
        <span className="rounded-full border border-conn-amber-text/40 bg-conn-amber-bg/40 px-1.5 py-0.5 text-conn-amber-text">
          本任务范围
        </span>
      </div>
      <p className="mt-1 leading-5 text-cafe-muted">
        这里只记录任务级授权和使用回流；真实边界仍是本地进程、浏览器/Figma 账号和远端服务权限。
      </p>
      {error && <p className="mt-1 text-conn-red-text">{error}</p>}
      {loading && <p className="mt-1 text-cafe-muted">加载 opencli/Figma 接入位...</p>}
      {!loading && capabilities.length === 0 && (
        <p className="mt-1 text-cafe-muted">未检测到 opencli/Figma MCP。先到 MCP 管理新增，安装后默认关闭。</p>
      )}
      {capabilities.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {capabilities.map((capability) => {
            const isAuthorized = authorized.has(capability.id);
            return (
              <div
                key={`${capability.type}:${capability.id}`}
                className="flex items-center gap-2 rounded-md border border-[var(--console-border-soft)] bg-cafe-surface-elevated px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-cafe-secondary">{capability.id}</p>
                  <p className="truncate text-cafe-muted">
                    {capability.enabled ? '能力已启用' : '全局关闭'} · {capability.description ?? '外部工具'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isAuthorized || busyId === capability.id}
                  onClick={() => authorize(capability)}
                  className="rounded-full border border-cafe-accent px-2 py-0.5 font-semibold text-cafe-accent disabled:cursor-not-allowed disabled:border-[var(--console-border-soft)] disabled:text-cafe-muted"
                >
                  {isAuthorized ? '已授权' : busyId === capability.id ? '授权中' : '授权本任务'}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {usageEvents.length > 0 && (
        <div className="mt-2 border-t border-[var(--console-border-soft)] pt-1.5">
          <p className="mb-1 font-semibold text-cafe-muted">工具使用回流</p>
          <div className="space-y-1">
            {usageEvents.slice(-5).map((event, index) => (
              <p key={`${event.ts}-${index}`} className="truncate text-cafe-muted">
                {String(event.data?.capabilityId ?? 'capability')} · {String(event.data?.status ?? 'used')}
                {typeof event.data?.durationMs === 'number' ? ` · ${formatDuration(event.data.durationMs)}` : ''}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function TaskCard({
  task,
  onStatusChange,
}: {
  task: TaskItem;
  onStatusChange: (taskId: string, newStatus: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status = task.status as TaskStatus;
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.todo;
  const showCostPanel = isInvocationCostPanelEnabled();
  const allUsageEvents = readTaskUsageSummaries(task);
  const showUsagePanel = showCostPanel || allUsageEvents.some((usage) => usage.deliveryOnlyMode === 'degraded');
  const usageEvents = showUsagePanel ? allUsageEvents : [];
  const usageTotal = summarizeTaskUsage(usageEvents);

  return (
    <div
      className={`border-l-4 ${style.border} bg-cafe-surface-elevated border border-[var(--console-border-soft)] rounded-xl p-3 mx-3 mb-1.5 hover:-translate-y-0.5 transition-transform ease-out`}
    >
      <div className="flex items-center gap-2">
        {/* Title */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left text-sm font-medium text-cafe-secondary truncate"
        >
          {task.title}
        </button>

        {/* Owner avatar */}
        {task.ownerCatId && <CatAvatar catId={task.ownerCatId} size={14} />}

        {/* Status pill (clickable to cycle) */}
        <button
          type="button"
          onClick={() => onStatusChange(task.id, STATUS_CYCLE[status])}
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${style.pillBg} transition-colors hover:opacity-80`}
        >
          {STATUS_LABELS[status]}
        </button>
      </div>

      {showUsagePanel && usageTotal && <UsageChip usage={usageTotal} />}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-[var(--console-border-soft)]">
          {task.why && <p className="text-xs text-cafe-muted leading-relaxed">{task.why}</p>}
          <p className="text-[10px] text-cafe-muted mt-1">
            {formatRelativeTime(task.createdAt)} · {task.createdBy === 'user' ? '铲屎官' : task.createdBy}
          </p>
          {showUsagePanel && usageEvents.length > 0 && (
            <div className="mt-2 space-y-1.5">
              <p className="text-[10px] font-semibold text-cafe-muted">Invocation 成本明细</p>
              {usageEvents.map((usage, index) => (
                <UsageDetailRow key={`${usage.catId}-${index}`} usage={usage} />
              ))}
            </div>
          )}
          <CapabilityTaskPanel task={task} />
        </div>
      )}
    </div>
  );
}
