'use client';

import type { TaskEvidence, TaskItem, TaskStatus } from '@cat-cafe/shared';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { TaskComposer } from './TaskComposer';

type TaskViewMode = 'board' | 'list';
type TaskBoardStyle = CSSProperties & Record<string, string>;

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  in_review: '待验收',
  blocked: '阻塞',
  done: '已完成',
  failed: '失败',
};

const TASK_STATUS_META: Record<
  TaskStatus,
  {
    chip: string;
    badge: string;
    dot: string;
    next: TaskStatus;
  }
> = {
  todo: {
    chip: 'border-[var(--task-todo)] bg-[var(--task-todo-bg)] text-[var(--task-todo-text)]',
    badge: 'border-[var(--task-todo)] bg-[var(--task-todo-soft)] text-[var(--task-todo-text)]',
    dot: 'bg-[var(--task-todo)]',
    next: 'doing',
  },
  doing: {
    chip: 'border-[var(--task-doing)] bg-[var(--task-doing-bg)] text-[var(--task-doing-text)]',
    badge: 'border-[var(--task-doing)] bg-[var(--task-doing-soft)] text-[var(--task-doing-text)]',
    dot: 'bg-[var(--task-doing)]',
    next: 'in_review',
  },
  in_review: {
    chip: 'border-[var(--task-review)] bg-[var(--task-review-bg)] text-[var(--task-review-text)]',
    badge: 'border-[var(--task-review)] bg-[var(--task-review-soft)] text-[var(--task-review-text)]',
    dot: 'bg-[var(--task-review)]',
    next: 'done',
  },
  blocked: {
    chip: 'border-[var(--task-blocked)] bg-[var(--task-blocked-bg)] text-[var(--task-blocked-text)]',
    badge: 'border-[var(--task-blocked)] bg-[var(--task-blocked-soft)] text-[var(--task-blocked-text)]',
    dot: 'bg-[var(--task-blocked)]',
    next: 'doing',
  },
  // next must be a legal backend transition (done→failed, failed→todo),
  // otherwise the click PATCHes an illegal move and 409s.
  done: {
    chip: 'border-[var(--task-done)] bg-[var(--task-done-bg)] text-[var(--task-done-text)]',
    badge: 'border-[var(--task-done)] bg-[var(--task-done-soft)] text-[var(--task-done-text)]',
    dot: 'bg-[var(--task-done)]',
    next: 'failed',
  },
  failed: {
    chip: 'border-[var(--task-failed)] bg-[var(--task-failed-bg)] text-[var(--task-failed-text)]',
    badge: 'border-[var(--task-failed)] bg-[var(--task-failed-soft)] text-[var(--task-failed-text)]',
    dot: 'bg-[var(--task-failed)]',
    next: 'todo',
  },
};

const taskBoardStyle: TaskBoardStyle = {
  '--task-ink': '#111111',
  '--task-panel': '#efefef',
  '--task-card': '#ffffff',
  '--task-column': '#f9f9f9',
  '--task-control': '#f7f7f7',
  '--task-muted': '#666666',
  '--task-subtle': '#777777',
  '--task-border-muted': '#999999',
  '--task-border-soft': '#d0d0d0',
  '--task-evidence': '#ffe1f0',
  '--task-accent': '#ff4fa3',
  '--task-active': '#fff14f',
  '--task-warning': '#fff1d6',
  '--task-warning-text': '#9a5b00',
  '--task-input-focus': '#fff8db',
  '--task-danger': '#aa3333',
  '--task-on-accent': '#ffffff',
  '--task-todo': '#f5a524',
  '--task-todo-bg': '#fff1d6',
  '--task-todo-soft': '#fff7e8',
  '--task-todo-text': '#9a5b00',
  '--task-doing': '#00a7c7',
  '--task-doing-bg': '#dff8ff',
  '--task-doing-soft': '#effcff',
  '--task-doing-text': '#006579',
  '--task-review': '#b69cff',
  '--task-review-bg': '#f0eaff',
  '--task-review-soft': '#f8f5ff',
  '--task-review-text': '#5940aa',
  '--task-blocked': '#ff6b4a',
  '--task-blocked-bg': '#ffe8df',
  '--task-blocked-soft': '#fff4ef',
  '--task-blocked-text': '#9a321a',
  '--task-done': '#6ccf8d',
  '--task-done-bg': '#e7f8ec',
  '--task-done-soft': '#f1fff5',
  '--task-done-text': '#1f7a3d',
  '--task-failed': '#d83a34',
  '--task-failed-bg': '#ffe4e1',
  '--task-failed-soft': '#fff3f1',
  '--task-failed-text': '#9f211c',
};

const BOARD_COLUMNS: ReadonlyArray<{ status: TaskStatus; title: string }> = [
  { status: 'todo', title: '待办' },
  { status: 'doing', title: '进行中' },
  { status: 'in_review', title: '待验收' },
  { status: 'blocked', title: '阻塞' },
  { status: 'failed', title: '失败' },
  { status: 'done', title: '已完成' },
];

const EVIDENCE_FIELDS = [
  { key: 'tests', label: '测试', placeholder: '例：pnpm --filter @cat-cafe/web exec tsc --noEmit 通过' },
  { key: 'build', label: 'Build', placeholder: '例：pnpm --filter @cat-cafe/web build 通过' },
  { key: 'screenshot', label: '截图', placeholder: '例：附件 ID / 截图路径 / 验收截图说明' },
  { key: 'review', label: 'Review', placeholder: '例：@专家-Claude review 通过，发现项已处理' },
  { key: 'lesson', label: 'Lesson', placeholder: '例：已补录 LL-054 或本次无需新增 lesson' },
] as const satisfies ReadonlyArray<{
  key: keyof Omit<TaskEvidence, 'updatedAt'>;
  label: string;
  placeholder: string;
}>;

function formatTaskTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function countEvidence(evidence?: TaskEvidence): number {
  if (!evidence) return 0;
  return EVIDENCE_FIELDS.filter((field) => evidence[field.key]?.trim()).length;
}

function getOwnerLabel(task: TaskItem): string {
  return task.ownerCatId ?? '未分配';
}

function TaskStatusChip({ status, count }: { status: TaskStatus; count: number }) {
  const meta = TASK_STATUS_META[status];
  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border-2 px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em] ${meta.chip}`}
      >
        <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
        {TASK_STATUS_LABELS[status]}
      </span>
      <span className="rounded-full border-2 border-[var(--task-ink)] bg-[var(--task-card)] px-2 py-0.5 text-[11px] font-black text-[var(--task-ink)]">
        {count}
      </span>
    </div>
  );
}

interface TaskCardViewProps {
  task: TaskItem;
  expanded: boolean;
  draft: TaskEvidence;
  saving: boolean;
  onToggleEvidence: (task: TaskItem) => void;
  onDraftChange: (taskId: string, key: keyof Omit<TaskEvidence, 'updatedAt'>, value: string) => void;
  onSaveEvidence: (taskId: string) => Promise<boolean>;
  onCycleStatus: (task: TaskItem) => void;
  onOpenThread?: (task: TaskItem) => void;
  saveError: string | null;
}

function TaskCardView({
  task,
  expanded,
  draft,
  saving,
  onToggleEvidence,
  onDraftChange,
  onSaveEvidence,
  onCycleStatus,
  onOpenThread,
  saveError,
}: TaskCardViewProps) {
  // 展开区分「查看态 / 编辑态」：默认阅读视图（有什么证据展示什么），
  // 点「✎ 填写」才出表单——窄列里常驻 5 个空 textarea 视觉爆炸且无信息量。
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!expanded) setEditing(false);
  }, [expanded]);

  const evidence = task.evidence;
  const evidenceCount = countEvidence(evidence);
  const meta = TASK_STATUS_META[task.status] ?? TASK_STATUS_META.todo;
  const filledFields = EVIDENCE_FIELDS.filter((field) => Boolean(evidence?.[field.key]?.trim()));
  const emptyFields = EVIDENCE_FIELDS.filter((field) => !evidence?.[field.key]?.trim());

  return (
    // 卡片整体可点但内部嵌有原生按钮(保存证据等),不能用 <button> 包裹;
    // <article> 等语义元素不允许再赋 button 角色(a11y 语义冲突),用中性 <div>。
    <div
      className="rounded-[14px] border-2 border-[var(--task-ink)] bg-[var(--task-card)] p-3 text-[var(--task-ink)] shadow-[5px_5px_0_#111] transition-transform hover:-translate-y-0.5"
      role="button"
      tabIndex={0}
      title={expanded ? '收起任务详情' : '展开任务详情与交付证据'}
      onClick={() => onToggleEvidence(task)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onToggleEvidence(task);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {/* id 以创建时间戳开头，前缀在同一时段全相同——取尾部随机段才有区分度 */}
          <div className="text-[11px] font-black uppercase tracking-[0.12em] text-[var(--task-subtle)]">
            #{task.id.slice(-6)}
          </div>
          <h3 className="mt-1 line-clamp-2 text-sm font-black leading-snug text-[var(--task-ink)]" title={task.title}>
            {task.title}
          </h3>
        </div>
        <button
          type="button"
          className={`shrink-0 rounded-full border-2 px-2 py-0.5 text-[10px] font-black transition hover:brightness-95 ${meta.badge}`}
          title={`切换到 ${TASK_STATUS_LABELS[meta.next]}`}
          onClick={(event) => {
            event.stopPropagation();
            onCycleStatus(task);
          }}
        >
          ✎ {TASK_STATUS_LABELS[task.status]}
        </button>
      </div>

      {/* 展开后详情区会显示完整 WHY，这里的截断版收起，避免同屏重复两遍 */}
      {task.why && !expanded && (
        <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-[var(--task-muted)]">{task.why}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t-2 border-dashed border-[var(--task-ink)]/20 pt-2 text-[11px] font-semibold text-[var(--task-muted)]">
        <span>Owner: {getOwnerLabel(task)}</span>
        {onOpenThread && (
          <button
            type="button"
            className="rounded-full border border-[var(--task-ink)]/40 bg-[var(--task-control)] px-2 py-0.5 text-[10px] font-black text-[var(--task-ink)] transition hover:border-[var(--task-ink)]"
            title="打开任务 Thread（猫的接手工作区）"
            onClick={(event) => {
              event.stopPropagation();
              onOpenThread(task);
            }}
          >
            任务 Thread ↗
          </button>
        )}
        <span>{formatTaskTime(task.updatedAt || task.createdAt)}</span>
        <span>By: {task.createdBy === 'user' ? 'user' : task.createdBy}</span>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {EVIDENCE_FIELDS.map((field) => {
            const filled = Boolean(evidence?.[field.key]?.trim());
            return (
              <span
                key={field.key}
                className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${
                  filled
                    ? 'border-[var(--task-ink)] bg-[var(--task-evidence)] text-[var(--task-ink)]'
                    : 'border-[var(--task-border-soft)] bg-[var(--task-control)] text-[var(--task-subtle)]'
                }`}
              >
                {field.label}
              </span>
            );
          })}
        </div>
        <button
          type="button"
          className="rounded-lg border-2 border-[var(--task-ink)] bg-[var(--task-control)] px-2.5 py-1 text-[11px] font-black text-[var(--task-ink)] shadow-[2px_2px_0_#111] transition hover:-translate-y-0.5"
          onClick={(event) => {
            event.stopPropagation();
            onToggleEvidence(task);
          }}
        >
          交付证据 {evidenceCount}/5
        </button>
      </div>

      {expanded && (
        <div
          className="mt-3 rounded-xl border-2 border-[var(--task-ink)] bg-[var(--task-control)] p-3"
          onClick={(event) => event.stopPropagation()}
        >
          {task.why && (
            <div className="mb-3 rounded-lg border border-[var(--task-ink)]/20 bg-[var(--task-card)] px-3 py-2">
              <div className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--task-subtle)]">
                Why · 任务背景
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-[var(--task-ink)]">{task.why}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-black text-[var(--task-ink)]">交付证据 {evidenceCount}/5</div>
            <div className="flex items-center gap-2">
              {evidence?.updatedAt && (
                <span className="text-[10px] text-[var(--task-muted)]">更新 {formatTaskTime(evidence.updatedAt)}</span>
              )}
              <button
                type="button"
                className="rounded-full border-2 border-[var(--task-ink)] bg-[var(--task-card)] px-2.5 py-0.5 text-[10px] font-black text-[var(--task-ink)] shadow-[2px_2px_0_#111] transition hover:-translate-y-0.5"
                onClick={(event) => {
                  event.stopPropagation();
                  setEditing((current) => !current);
                }}
              >
                {editing ? '取消' : '✎ 填写'}
              </button>
            </div>
          </div>

          {!editing ? (
            <div className="mt-2 flex flex-col gap-2">
              {filledFields.length === 0 && (
                <p className="rounded-lg border border-dashed border-[var(--task-border-muted)] bg-[var(--task-card)] px-3 py-2 text-[11px] font-semibold leading-relaxed text-[var(--task-subtle)]">
                  暂无交付证据——点「✎ 填写」记录测试 / Build / 截图 / Review / Lesson。
                </p>
              )}
              {filledFields.map((field) => (
                <div
                  key={field.key}
                  className="rounded-lg border border-[var(--task-ink)]/25 bg-[var(--task-card)] px-3 py-2"
                >
                  <div className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--task-subtle)]">
                    {field.label}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-[var(--task-ink)]">
                    {evidence?.[field.key]?.trim()}
                  </p>
                </div>
              ))}
              {filledFields.length > 0 && emptyFields.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-[var(--task-subtle)]">
                  待补：
                  {emptyFields.map((field) => (
                    <span
                      key={field.key}
                      className="rounded-full border border-[var(--task-border-soft)] bg-[var(--task-card)] px-2 py-0.5"
                    >
                      {field.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <div className="mt-2 flex flex-col gap-2.5">
                {EVIDENCE_FIELDS.map((field) => (
                  <label key={field.key} className="block">
                    <span className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--task-muted)]">
                      {field.label}
                    </span>
                    <textarea
                      className="mt-1 min-h-14 w-full resize-y rounded-lg border-2 border-[var(--task-ink)] bg-[var(--task-card)] px-2.5 py-1.5 text-xs leading-[1.5] text-[var(--task-ink)] outline-none transition placeholder:text-[var(--task-border-muted)] focus:bg-[var(--task-input-focus)]"
                      value={draft[field.key] ?? ''}
                      placeholder={field.placeholder}
                      onChange={(event) => onDraftChange(task.id, field.key, event.target.value)}
                    />
                  </label>
                ))}
              </div>

              {saveError && <div className="mt-2 text-xs font-semibold text-[var(--task-danger)]">{saveError}</div>}

              <div className="mt-2.5 flex justify-end">
                <button
                  type="button"
                  className="rounded-lg border-2 border-[var(--task-ink)] bg-[var(--task-accent)] px-3 py-1.5 text-xs font-black text-[var(--task-on-accent)] shadow-[3px_3px_0_#111] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={saving}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onSaveEvidence(task.id).then((ok) => {
                      if (ok) setEditing(false);
                    });
                  }}
                >
                  {saving ? '保存中...' : '保存证据'}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyColumn({ status }: { status: TaskStatus }) {
  return (
    <div className="rounded-[14px] border-2 border-dashed border-[var(--task-border-muted)] bg-[var(--task-card)]/55 px-4 py-8 text-center text-xs font-bold text-[var(--task-subtle)]">
      暂无 {TASK_STATUS_LABELS[status]} 任务
    </div>
  );
}

interface TasksPanelProps {
  threadId: string;
  onOpenTaskThread?: (task: TaskItem) => void;
}

export function TasksPanel({ threadId, onOpenTaskThread }: TasksPanelProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<TaskViewMode>('board');
  const [composerOpen, setComposerOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [evidenceDrafts, setEvidenceDrafts] = useState<Record<string, TaskEvidence>>({});
  const [savingTaskId, setSavingTaskId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);

    apiFetch(`/api/tasks?threadId=${encodeURIComponent(threadId)}&kind=work`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { tasks?: TaskItem[] };
      })
      .then((data) => {
        if (cancelled) return;
        setTasks(data.tasks ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setTasks([]);
        setError('任务列表加载失败');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId, refreshKey]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }, [tasks]);

  const groupedTasks = useMemo(() => {
    return BOARD_COLUMNS.map((column) => ({
      ...column,
      tasks: sortedTasks.filter((task) => task.status === column.status),
    }));
  }, [sortedTasks]);

  function closeComposerAndRefresh() {
    setComposerOpen(false);
    setRefreshKey((current) => current + 1);
  }

  function toggleEvidence(task: TaskItem) {
    setSaveError(null);
    setExpandedTaskId((current) => (current === task.id ? null : task.id));
    setEvidenceDrafts((current) => {
      if (current[task.id]) return current;
      return { ...current, [task.id]: task.evidence ?? {} };
    });
  }

  function updateEvidenceDraft(taskId: string, key: keyof Omit<TaskEvidence, 'updatedAt'>, value: string) {
    setEvidenceDrafts((current) => ({
      ...current,
      [taskId]: {
        ...(current[taskId] ?? {}),
        [key]: value,
      },
    }));
  }

  async function saveEvidence(taskId: string): Promise<boolean> {
    const evidence = evidenceDrafts[taskId] ?? {};
    setSavingTaskId(taskId);
    setSaveError(null);

    try {
      const res = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ evidence }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as TaskItem;
      setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)));
      setEvidenceDrafts((current) => ({ ...current, [updated.id]: updated.evidence ?? {} }));
      return true;
    } catch {
      setSaveError('交付证据保存失败，请稍后重试');
      return false;
    } finally {
      setSavingTaskId(null);
    }
  }

  async function cycleTaskStatus(task: TaskItem) {
    const nextStatus = (TASK_STATUS_META[task.status] ?? TASK_STATUS_META.todo).next;
    setStatusError(null);
    try {
      const res = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = (await res.json()) as TaskItem;
      setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch {
      setStatusError('状态更新失败，请稍后重试');
    }
  }

  const cardHandlers = {
    onToggleEvidence: toggleEvidence,
    onDraftChange: updateEvidenceDraft,
    onSaveEvidence: (taskId: string) => saveEvidence(taskId),
    onCycleStatus: (task: TaskItem) => void cycleTaskStatus(task),
    onOpenThread: onOpenTaskThread,
  };

  return (
    <section className="h-full overflow-y-auto bg-[var(--task-panel)] text-[var(--task-ink)]" style={taskBoardStyle}>
      <div className="mx-auto flex min-h-full max-w-[1440px] flex-col gap-4 p-4 md:p-6">
        <header className="rounded-[18px] border-2 border-[var(--task-ink)] bg-[var(--task-card)] px-4 py-3 shadow-[5px_5px_0_#111]">
          <div className="flex flex-wrap items-center gap-3">
            <div className="mr-auto">
              <h2 className="text-base font-black uppercase tracking-[0.08em] text-[var(--task-ink)]">Tasks</h2>
              <p className="mt-1 text-xs font-semibold text-[var(--task-muted)]">
                主会话任务卡 · 任务 Thread 接手区 · {tasks.length} 个
              </p>
            </div>

            <button
              type="button"
              className="rounded-full border-2 border-[var(--task-ink)] bg-[var(--task-control)] px-3 py-1.5 text-xs font-black uppercase text-[var(--task-ink)] shadow-[2px_2px_0_#111]"
              title="Phase 1 占位：后续接入创建人筛选"
            >
              CREATOR ▾
            </button>
            <button
              type="button"
              className="rounded-full border-2 border-[var(--task-ink)] bg-[var(--task-control)] px-3 py-1.5 text-xs font-black uppercase text-[var(--task-ink)] shadow-[2px_2px_0_#111]"
              title="Phase 1 占位：后续接入负责人筛选"
            >
              ASSIGNEE ▾
            </button>
            <button
              type="button"
              className="rounded-full border-2 border-[var(--task-ink)] bg-[var(--task-accent)] px-4 py-1.5 text-xs font-black text-[var(--task-on-accent)] shadow-[3px_3px_0_#111] transition hover:-translate-y-0.5"
              onClick={() => setComposerOpen((current) => !current)}
            >
              + 新任务
            </button>

            <div className="flex rounded-full border-2 border-[var(--task-ink)] bg-[var(--task-ink)] p-0.5">
              {(['board', 'list'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`rounded-full px-3 py-1 text-xs font-black uppercase transition ${
                    viewMode === mode
                      ? 'bg-[var(--task-active)] text-[var(--task-ink)]'
                      : 'text-[var(--task-on-accent)] hover:bg-[var(--task-card)]/10'
                  }`}
                  onClick={() => setViewMode(mode)}
                >
                  {mode === 'board' ? 'Board' : 'List'}
                </button>
              ))}
            </div>
          </div>
        </header>

        {composerOpen && (
          <div className="rounded-[18px] border-2 border-[var(--task-ink)] bg-[var(--task-card)] p-2 shadow-[5px_5px_0_#111]">
            <TaskComposer threadId={threadId} onClose={closeComposerAndRefresh} />
          </div>
        )}

        {isLoading && (
          <div className="rounded-[18px] border-2 border-[var(--task-ink)] bg-[var(--task-card)] p-6 text-sm font-bold text-[var(--task-muted)] shadow-[5px_5px_0_#111]">
            加载任务中...
          </div>
        )}

        {!isLoading && error && (
          <div className="rounded-[18px] border-2 border-[var(--task-ink)] bg-[var(--task-warning)] p-6 text-sm font-black text-[var(--task-warning-text)] shadow-[5px_5px_0_#111]">
            {error}
          </div>
        )}

        {!isLoading && !error && statusError && (
          <div className="rounded-xl border-2 border-[var(--task-ink)] bg-[var(--task-warning)] px-4 py-2 text-xs font-black text-[var(--task-warning-text)]">
            {statusError}
          </div>
        )}

        {!isLoading && !error && sortedTasks.length === 0 && !composerOpen && (
          <div className="rounded-[18px] border-2 border-dashed border-[var(--task-subtle)] bg-[var(--task-card)]/70 p-10 text-center text-sm font-black text-[var(--task-muted)]">
            当前频道暂无任务。新任务会成为主会话里的任务卡。
          </div>
        )}

        {!isLoading && !error && sortedTasks.length > 0 && viewMode === 'board' && (
          <div className="grid items-start gap-4 pb-4 [grid-template-columns:repeat(auto-fit,minmax(225px,1fr))]">
            {groupedTasks.map((column) => (
              <section
                key={column.status}
                className="flex min-w-0 flex-col gap-3 rounded-[18px] border-2 border-[var(--task-ink)] bg-[var(--task-column)] p-3 shadow-[5px_5px_0_#111]"
              >
                <div className="flex items-center justify-between gap-2 border-b-2 border-[var(--task-ink)] pb-3">
                  <TaskStatusChip status={column.status} count={column.tasks.length} />
                  <span className="text-lg font-black text-[var(--task-ink)]">⌄</span>
                </div>
                <div className="flex flex-col gap-3">
                  {column.tasks.length === 0 ? (
                    <EmptyColumn status={column.status} />
                  ) : (
                    column.tasks.map((task) => (
                      <TaskCardView
                        key={task.id}
                        task={task}
                        expanded={expandedTaskId === task.id}
                        draft={evidenceDrafts[task.id] ?? task.evidence ?? {}}
                        saving={savingTaskId === task.id}
                        saveError={saveError}
                        {...cardHandlers}
                      />
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        )}

        {!isLoading && !error && sortedTasks.length > 0 && viewMode === 'list' && (
          <div className="grid gap-3">
            {sortedTasks.map((task) => (
              <TaskCardView
                key={task.id}
                task={task}
                expanded={expandedTaskId === task.id}
                draft={evidenceDrafts[task.id] ?? task.evidence ?? {}}
                saving={savingTaskId === task.id}
                saveError={saveError}
                {...cardHandlers}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
