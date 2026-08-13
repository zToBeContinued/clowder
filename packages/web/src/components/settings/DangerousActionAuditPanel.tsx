'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface DangerousActionEvent {
  id: string;
  timestamp: number;
  threadId?: string;
  data: {
    actorId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    severity?: string;
    result?: string;
    confirmation?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  };
}

interface DangerousActionAuditResponse {
  events: DangerousActionEvent[];
  total: number;
  actions: string[];
  results: string[];
  files: string[];
  query: {
    date: string | null;
    days: number | null;
    action: string | null;
    result: string | null;
    limit: number;
  };
}

const RESULT_LABELS: Record<string, string> = {
  attempted: '尝试',
  blocked: '已拦截',
  succeeded: '成功',
  failed: '失败',
};

const RESULT_TONE: Record<string, string> = {
  attempted: 'bg-[var(--console-card-soft-bg)] text-cafe-secondary',
  blocked: 'bg-conn-red-bg text-conn-red-text',
  succeeded: 'bg-conn-emerald-bg text-conn-emerald-text',
  failed: 'bg-conn-red-bg text-conn-red-text',
};

function todayString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp));
}

function formatTarget(event: DangerousActionEvent): string {
  const { targetType, targetId } = event.data;
  if (!targetType && !targetId) return '-';
  if (!targetType) return targetId ?? '-';
  if (!targetId) return targetType;
  return `${targetType}:${targetId}`;
}

export function DangerousActionAuditPanel() {
  const [date, setDate] = useState(todayString);
  const [action, setAction] = useState('');
  const [result, setResult] = useState('');
  const [data, setData] = useState<DangerousActionAuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (action) params.set('action', action);
    if (result) params.set('result', result);
    params.set('limit', '200');
    return params.toString();
  }, [action, date, result]);

  const fetchAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/audit/dangerous-actions?${query}`);
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((payload.error as string) ?? `审计日志加载失败 (${res.status})`);
        return;
      }
      setData((await res.json()) as DangerousActionAuditResponse);
    } catch {
      setError('审计日志加载失败，请确认 API 服务可用');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  return (
    <div className="space-y-4">
      <div className="console-card rounded-2xl p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-cafe-secondary">
            日期
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 rounded-lg border border-[var(--console-border)] bg-[var(--console-card-bg)] px-3 text-sm text-cafe outline-none focus:border-cafe-accent"
            />
          </label>
          <label className="flex min-w-[180px] flex-col gap-1 text-xs font-medium text-cafe-secondary">
            动作
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="h-9 rounded-lg border border-[var(--console-border)] bg-[var(--console-card-bg)] px-3 text-sm text-cafe outline-none focus:border-cafe-accent"
            >
              <option value="">全部动作</option>
              {data?.actions.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-[140px] flex-col gap-1 text-xs font-medium text-cafe-secondary">
            结果
            <select
              value={result}
              onChange={(e) => setResult(e.target.value)}
              className="h-9 rounded-lg border border-[var(--console-border)] bg-[var(--console-card-bg)] px-3 text-sm text-cafe outline-none focus:border-cafe-accent"
            >
              <option value="">全部结果</option>
              {(data?.results ?? ['attempted', 'blocked', 'succeeded', 'failed']).map((item) => (
                <option key={item} value={item}>
                  {RESULT_LABELS[item] ?? item}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={fetchAudit}
            className="h-9 rounded-lg bg-cafe-accent px-4 text-sm font-semibold text-[var(--cafe-surface)] transition-opacity hover:opacity-90"
          >
            刷新
          </button>
        </div>
        <p className="mt-3 text-xs text-cafe-muted">
          只展示 dangerous_action 审计事件，用于复盘删除、清队列、文件操作等高风险动作。
        </p>
      </div>

      <div className="console-card rounded-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-cafe">危险动作审计</h3>
            <p className="mt-0.5 text-xs text-cafe-muted">
              {loading ? '加载中...' : `匹配 ${data?.total ?? 0} 条，显示 ${data?.events.length ?? 0} 条`}
            </p>
          </div>
          <span className="rounded-full bg-[var(--console-card-soft-bg)] px-2.5 py-1 text-xs text-cafe-muted">
            {data?.files.length ?? 0} 个日志文件
          </span>
        </div>

        {error ? (
          <div className="px-4 py-8 text-sm text-[var(--semantic-error-text)]">{error}</div>
        ) : loading ? (
          <div className="px-4 py-8 text-sm text-cafe-muted">正在读取审计日志...</div>
        ) : data && data.events.length > 0 ? (
          <div className="divide-y divide-[var(--console-border-soft)]">
            {data.events.map((event) => {
              const itemResult = event.data.result ?? 'unknown';
              const expanded = expandedId === event.id;
              return (
                <button
                  key={event.id}
                  type="button"
                  data-testid="dangerous-audit-row"
                  onClick={() => setExpandedId(expanded ? null : event.id)}
                  className="block w-full px-4 py-3 text-left transition-colors hover:bg-[var(--console-hover-bg)]"
                >
                  <div className="grid gap-2 md:grid-cols-[120px_1fr_150px_110px] md:items-center">
                    <span className="text-xs tabular-nums text-cafe-muted">{formatTime(event.timestamp)}</span>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-cafe">
                        {event.data.action ?? 'unknown_action'}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-cafe-muted">{formatTarget(event)}</div>
                    </div>
                    <span className="truncate text-xs text-cafe-secondary">{event.data.actorId ?? 'unknown'}</span>
                    <span
                      className={`w-fit rounded-full px-2 py-0.5 text-xs font-semibold ${RESULT_TONE[itemResult] ?? RESULT_TONE.attempted}`}
                    >
                      {RESULT_LABELS[itemResult] ?? itemResult}
                    </span>
                  </div>
                  {expanded && (
                    <pre className="mt-3 overflow-x-auto rounded-xl bg-[var(--console-card-soft-bg)] p-3 text-xs text-cafe-secondary">
                      {JSON.stringify(event.data, null, 2)}
                    </pre>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="px-4 py-8 text-sm text-cafe-muted">当前筛选条件下没有危险动作审计记录。</div>
        )}
      </div>
    </div>
  );
}
