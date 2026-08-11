'use client';

import type { TaskItem } from '@cat-cafe/shared';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { getMentionRe, getMentionToCat } from '@/lib/mention-highlight';
import { parseDirection } from '@/lib/parse-direction';
import { type ChatMessage as ChatMessageType, resolveBubbleExpanded, useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { getAgentVisibleContent, isUserVisibleChatMessage } from '@/utils/chat-message-visibility';
import { CatAvatar } from './CatAvatar';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';
import { ConnectorBubble } from './ConnectorBubble';
import { ContentBlocks } from './ContentBlocks';
import { DirectionPill } from './DirectionPill';
import { EvidencePanel } from './EvidencePanel';
import { GovernanceBlockedCard } from './GovernanceBlockedCard';
import { MarkdownContent } from './MarkdownContent';
import { MessageReactions } from './MessageReactions';
import { MetadataBadge } from './MetadataBadge';
import { ReplyPill } from './ReplyPill';
import { BriefingCard } from './rich/BriefingCard';
import { RichBlocks } from './rich/RichBlocks';
import { SummaryCard } from './SummaryCard';
import { SystemNoticeBar } from './SystemNoticeBar';
import { ThinkingContent } from './ThinkingContent';
import { getThreadHref, pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { TimeoutDiagnosticsPanel } from './TimeoutDiagnosticsPanel';

const BREED_STYLES: Record<string, { font?: string }> = {
  ragdoll: {},
  'maine-coon': { font: 'font-mono' },
  siamese: {},
  'dragon-li': { font: 'font-mono' },
};
const DEFAULT_BREED_STYLE = {};
const SCHEDULER_ACCENT_BADGE_CLASS =
  'inline-flex w-fit items-center gap-1.5 rounded-full border border-conn-amber-text/30 bg-conn-amber-bg px-2.5 py-1 text-[11px] font-semibold text-conn-amber-text shadow-sm';
const SCHEDULER_ACCENT_BUBBLE_CLASS = 'border-l-2 border-conn-amber-text/50 pl-3';
export function shouldRenderChatMessage(message: ChatMessageType): boolean {
  return isUserVisibleChatMessage(message);
}

export function shouldGroupAssistantMessage(message: ChatMessageType, isGrouped: boolean): boolean {
  return isGrouped && message.extra?.agentCommunication?.kind !== 'ack';
}

export function getProviderErrorDiagnostics(message: ChatMessageType): Record<string, unknown> | undefined {
  return message.extra?.providerDiagnostics ?? message.metadata?.diagnostics;
}

function formatProviderDiagnostics(diagnostics: Record<string, unknown>): string {
  const lines: string[] = [];
  if (typeof diagnostics.errorCode === 'string') lines.push(`错误码：${diagnostics.errorCode}`);
  if (typeof diagnostics.resetAt === 'number') {
    lines.push(`恢复时间：${new Date(diagnostics.resetAt).toLocaleString('zh-CN')}`);
  }
  if (typeof diagnostics.invocationId === 'string') lines.push(`Invocation：${diagnostics.invocationId}`);
  if (typeof diagnostics.rawArchivePath === 'string') lines.push(`原始归档：${diagnostics.rawArchivePath}`);
  if (typeof diagnostics.rawError === 'string') lines.push(`原始错误：\n${diagnostics.rawError}`);
  return lines.join('\n');
}

const TASK_EVIDENCE_KEYS = ['tests', 'build', 'screenshot', 'review', 'lesson'] as const;

function countTaskEvidence(task: TaskItem): number {
  const evidence = task.evidence;
  if (!evidence) return 0;
  return TASK_EVIDENCE_KEYS.filter((key) => Boolean(evidence[key]?.trim())).length;
}

function getTaskMetaLabels(task: TaskItem): string[] {
  const labels: string[] = [];
  const failedEvents = task.events?.filter((event) => event.type === 'failed').length ?? 0;
  const evidenceCount = countTaskEvidence(task);

  if (failedEvents > 0) labels.push(`失败 ${failedEvents}`);
  if (task.retryOf) labels.push('重试');
  if (task.parentTaskId) labels.push('子任务');
  if (task.branchOf) labels.push('分支');
  if (evidenceCount > 0) labels.push(`交付证据 ${evidenceCount}/5`);

  return labels.slice(0, 2);
}

function MessageTaskBadge({
  task,
  seq,
  assigneeLabel,
  onOpen,
}: {
  task: TaskItem;
  seq: number;
  assigneeLabel?: string;
  onOpen?: (task: TaskItem) => void;
}) {
  const metaLabels = getTaskMetaLabels(task);
  const chipLabel = assigneeLabel ? `任务 #${seq} @${assigneeLabel}` : `任务 #${seq}`;
  const content = (
    <>
      <span className="shrink-0">{chipLabel}</span>
      {metaLabels.map((label) => (
        <span
          key={label}
          className="shrink-0 border-l border-[var(--slock-border-color)]/40 pl-1.5 text-[10px] font-bold opacity-80"
        >
          {label}
        </span>
      ))}
    </>
  );

  if (onOpen) {
    return (
      <div className="mt-1.5">
        <button
          type="button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpen(task);
          }}
          className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--slock-radius-sm)] border-2 border-[var(--slock-border-color)] bg-conn-cyan-bg px-2 py-1 text-[11px] font-black leading-none text-conn-cyan-text shadow-[var(--slock-shadow-chip)] transition-colors hover:bg-conn-cyan-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-conn-cyan-ring"
          title={`打开任务 Thread：${task.title}`}
          aria-label={`打开任务 Thread #${seq}${assigneeLabel ? `，负责人 ${assigneeLabel}` : ''}`}
        >
          {content}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      <span
        className="inline-flex max-w-full items-center gap-1.5 rounded-[var(--slock-radius-sm)] border-2 border-[var(--slock-border-color)] bg-conn-cyan-bg px-2 py-1 text-[11px] font-black leading-none text-conn-cyan-text shadow-[var(--slock-shadow-chip)]"
        title={task.title}
      >
        {content}
      </span>
    </div>
  );
}

function ThreadReplyBadge({
  count,
  newCount = 0,
  latestReply,
  latestAuthorLabel,
  onOpen,
}: {
  count: number;
  newCount?: number;
  latestReply?: { content: string };
  latestAuthorLabel?: string;
  onOpen: () => void;
}) {
  if (count <= 0) return null;

  return (
    <div className="mt-2 w-full max-w-xl">
      <button
        type="button"
        aria-label={`打开 Thread，${count} 条回复${newCount > 0 ? `，${newCount} 条新回复` : ''}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
        className="flex min-h-11 w-full items-center gap-2 rounded-[var(--slock-radius-sm)] border-2 border-[var(--slock-border-color)] bg-[var(--clowder-action-surface)] px-2.5 py-1.5 text-left text-[11px] font-semibold text-[var(--cafe-text)] shadow-[var(--slock-shadow-chip)] transition-colors hover:bg-[var(--console-active-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cafe-accent)]"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 leading-none">
            <span>
              {count} {count === 1 ? 'reply' : 'replies'}
            </span>
            {newCount > 0 && (
              <>
                <span
                  data-thread-unread-dot="true"
                  aria-hidden="true"
                  className="h-2 w-2 flex-shrink-0 rounded-full bg-conn-emerald-text"
                />
                <span className="text-conn-emerald-text">· {newCount} new</span>
              </>
            )}
          </span>
          {latestReply && latestAuthorLabel && (
            <span
              data-thread-reply-summary="true"
              className="mt-1 block truncate font-normal leading-snug text-[var(--cafe-text-muted)]"
              title={`${latestAuthorLabel} · ${latestReply.content}`}
            >
              {latestAuthorLabel} · {latestReply.content}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="flex-shrink-0 text-[var(--cafe-text-muted)]">
          ›
        </span>
      </button>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const DELIVERED_AT_GAP_THRESHOLD = 5000;
function formatDualTime(timestamp: number, deliveredAt?: number): string {
  if (!deliveredAt || deliveredAt - timestamp <= DELIVERED_AT_GAP_THRESHOLD) {
    return formatTime(timestamp);
  }
  return `发送 ${formatTime(timestamp)} · 收到 ${formatTime(deliveredAt)}`;
}

function isSchedulerReplyPreview(replyPreview?: ChatMessageType['replyPreview']): boolean {
  return replyPreview?.senderCatId === 'system' && replyPreview.kind === 'scheduler_trigger';
}

function isConnectorSystemNotice(message: ChatMessageType): boolean {
  if (message.type !== 'connector' || !message.source?.meta) return false;
  return (message.source.meta as Record<string, unknown>).presentation === 'system_notice';
}

interface ChatMessageProps {
  message: ChatMessageType;
  getCatById: (id: string) => CatData | undefined;
  isGrouped?: boolean;
  threadReplyInfo?: {
    branchThreadId: string;
    replyCount: number;
    newCount?: number;
    latestReply?: { id: string; catId: string | null; content: string; timestamp: number };
  };
  onOpenThread?: (messageId: string) => void;
  onOpenTaskThread?: (task: TaskItem) => void;
  isEditing?: boolean;
  editDraft?: string;
  isSavingEdit?: boolean;
  onChangeEditDraft?: (value: string) => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  onRetrySend?: (message: ChatMessageType) => void;
  disableContentCollapse?: boolean;
  showRuntimeMetadata?: boolean;
  searchHighlight?: string;
}

export function ChatMessage({
  message,
  getCatById,
  isGrouped = false,
  threadReplyInfo,
  onOpenThread,
  onOpenTaskThread,
  isEditing = false,
  editDraft = '',
  isSavingEdit = false,
  onChangeEditDraft,
  onSaveEdit,
  onCancelEdit,
  onRetrySend,
  disableContentCollapse = false,
  showRuntimeMetadata = false,
  searchHighlight,
}: ChatMessageProps) {
  const coCreator = useCoCreatorConfig();
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const isLoadingThreads = useChatStore((s) => s.isLoadingThreads);
  const threads = useChatStore((s) => s.threads);
  const threadMessages = useChatStore((s) => s.messages);
  const globalBubbleDefaults = useChatStore((s) => s.globalBubbleDefaults);
  const catStatuses = useChatStore((s) => s.catStatuses);
  const tasks = useTaskStore((s) => s.tasks);
  const isUser = message.type === 'user' && !message.catId;
  const isSystem = message.type === 'system';
  const isSummary = message.type === 'summary';
  const isConnector = message.type === 'connector';

  const catData = message.catId ? getCatById(message.catId) : undefined;
  const catStyle = catData
    ? (() => {
        const breed = BREED_STYLES[catData.breedId ?? ''] ?? DEFAULT_BREED_STYLE;
        const label = formatCatName(catData);
        return {
          label,
          font: breed.font,
          color: catData.color.primary,
        };
      })()
    : null;
  const currentThread = useChatStore((s) => s.threads.find((t) => t.id === s.currentThreadId));
  const bubbleRestorePending = isLoadingThreads && !!currentThreadId && !currentThread;
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const visibleContent = getAgentVisibleContent(message);
  const hasTextContent = visibleContent.trim().length > 0;
  const taskEntry = tasks
    .filter((task) => task.kind !== 'pr_tracking')
    .map((task, index) => ({ task, seq: index + 1 }))
    .find(({ task }) => task.sourceMessageId === message.id);
  const taskAssignee = taskEntry?.task.ownerCatId ? getCatById(taskEntry.task.ownerCatId) : undefined;
  const taskAssigneeLabel = taskAssignee ? formatCatName(taskAssignee) : (taskEntry?.task.ownerCatId ?? undefined);
  const isWhisper = message.visibility === 'whisper';
  const isRevealed = isWhisper && !!message.revealedAt;
  const isSchedulerReply = isSchedulerReplyPreview(message.replyPreview);
  const showSchedulerAccent =
    isSchedulerReply &&
    !threadMessages.some((candidate) => {
      if (candidate.id === message.id) return false;
      if (candidate.replyTo !== message.replyTo) return false;
      if (candidate.catId !== message.catId) return false;
      if (!isSchedulerReplyPreview(candidate.replyPreview)) return false;
      if (candidate.timestamp !== message.timestamp) {
        return candidate.timestamp < message.timestamp;
      }
      return candidate.id < message.id;
    });

  const direction = catData ? parseDirection(message, () => ({ toCat: getMentionToCat(), re: getMentionRe() })) : null;
  const isAssistantContinuation = shouldGroupAssistantMessage(message, isGrouped);
  const assistantAppearClass =
    message.type === 'assistant' && !message.isStreaming ? 'motion-safe:animate-message-appear' : '';
  const catRuntimeStatus = message.catId ? catStatuses[message.catId] : undefined;
  const catActivityStatus =
    catRuntimeStatus === 'spawning' || catRuntimeStatus === 'pending' || catRuntimeStatus === 'streaming'
      ? 'active'
      : 'idle';
  const deliveryOnlyDegraded = message.metadata?.usage?.deliveryOnlyMode === 'degraded';
  const fullRuntimeMetadataBadge = message.metadata ? (
    <div className="w-fit rounded-[var(--slock-radius-pill)] border border-[var(--console-border-soft)] bg-[var(--console-card-soft-bg)] px-2 py-0.5">
      <MetadataBadge metadata={message.metadata} />
    </div>
  ) : null;
  const deliveryOnlyMetadataBadge = message.metadata ? (
    <div className="w-fit rounded-[var(--slock-radius-pill)] border border-conn-amber-text/40 bg-conn-amber-bg/40 px-2 py-0.5">
      <MetadataBadge metadata={message.metadata} warningOnly />
    </div>
  ) : null;

  // Slock-like rendering: streaming tokens are buffered in store but hidden from
  // the timeline until the final message arrives. The input area shows typing
  // state, so users do not need to scroll back to follow a growing bubble.
  if (!shouldRenderChatMessage(message)) {
    return null;
  }

  if (isSummary && message.summary) {
    return (
      <div data-message-id={message.id}>
        <SummaryCard
          topic={message.summary.topic}
          conclusions={message.summary.conclusions}
          openQuestions={message.summary.openQuestions}
          createdBy={message.summary.createdBy}
          timestamp={message.timestamp}
        />
      </div>
    );
  }

  if (isSystem) {
    // F148 Phase E + VG-2: Briefing card — collapsible with source label
    if (message.origin === 'briefing' && message.extra?.rich?.blocks?.length) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full opacity-80">
            <BriefingCard block={message.extra.rich.blocks[0]} messageId={message.id} />
          </div>
        </div>
      );
    }

    if (message.variant === 'evidence' && message.evidence) {
      return <EvidencePanel data={message.evidence} />;
    }

    if (message.variant === 'governance_blocked' && message.extra?.governanceBlocked) {
      const { projectPath, reasonKind, invocationId } = message.extra.governanceBlocked;
      return <GovernanceBlockedCard projectPath={projectPath} reasonKind={reasonKind} invocationId={invocationId} />;
    }

    // F045: variant='thinking' is deprecated — thinking is now embedded in assistant bubbles.

    const systemDisplayContent = visibleContent;
    const isLegacyError = !message.variant && systemDisplayContent.trim().startsWith('Error:');
    const isError = message.variant === 'error' || isLegacyError;
    const isTool = message.variant === 'tool';
    const isFollowup = message.variant === 'a2a_followup';

    // F118 AC-C3: Enhanced timeout diagnostics panel
    if (isError && message.extra?.timeoutDiagnostics) {
      return (
        <div data-message-id={message.id} className="flex justify-center mb-3">
          <div className="max-w-[85%] w-full">
            <TimeoutDiagnosticsPanel
              errorMessage={systemDisplayContent}
              diagnostics={message.extra.timeoutDiagnostics}
            />
          </div>
        </div>
      );
    }

    const providerDiagnostics = isError ? getProviderErrorDiagnostics(message) : undefined;

    const toneClass = isTool
      ? 'text-cafe-muted bg-cafe-surface-elevated/50 font-mono text-xs py-1'
      : isFollowup
        ? 'text-conn-purple-text bg-conn-purple-bg border border-conn-purple-ring'
        : isError
          ? 'text-conn-red-text bg-conn-red-bg rounded-full'
          : 'text-[var(--color-cafe-accent)] bg-[var(--color-cafe-accent)]/5';
    return (
      <div data-message-id={message.id} className={`flex justify-center ${isTool ? 'mb-1' : 'mb-3'}`}>
        <div
          className={`px-4 py-2 rounded-lg whitespace-pre-wrap text-left max-w-[85%] [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-body)] ${toneClass}`}
        >
          {isFollowup && <span className="mr-1">🔗</span>}
          {systemDisplayContent}
          {providerDiagnostics && formatProviderDiagnostics(providerDiagnostics) && (
            <details className="mt-2 border-t border-current/20 pt-1 text-xs">
              <summary className="cursor-pointer select-none font-semibold">诊断详情</summary>
              <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] opacity-85">
                {formatProviderDiagnostics(providerDiagnostics)}
              </pre>
            </details>
          )}
          {isFollowup && (
            <span className="block mt-1 text-xs text-conn-purple-text">输入 @猫名 跟进 来发起 follow-up</span>
          )}
        </div>
      </div>
    );
  }

  if (isConnector && message.source) {
    if (isConnectorSystemNotice(message)) {
      return <SystemNoticeBar message={message} />;
    }
    return <ConnectorBubble message={message} />;
  }

  if (isUser) {
    const coCreatorPrimary = coCreator.color?.primary ?? '#815b5b';
    return (
      <div
        data-message-id={message.id}
        className="group flex justify-start gap-2 mb-4 items-start transition-colors [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-body)]"
      >
        <button
          type="button"
          onClick={() => useChatStore.getState().openCoCreatorEditor()}
          className="h-10 w-10 overflow-hidden flex-shrink-0 flex items-center justify-center text-[11px] font-bold text-[var(--cafe-surface)] cursor-pointer hover:opacity-80 transition-opacity"
          style={{
            backgroundColor: coCreatorPrimary,
            border: '1px solid var(--slock-ink, var(--console-border-strong, var(--cafe-border)))',
            borderRadius: 0,
          }}
          title={coCreator.name}
        >
          {coCreator.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coCreator.avatar}
              alt={coCreator.name}
              width={40}
              height={40}
              className="object-cover w-full h-full"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : (
            'ME'
          )}
        </button>
        <div className="max-w-[85%] md:max-w-[1120px] min-w-0">
          <div className="flex justify-start items-center gap-2 mb-1 [line-height:var(--clowder-leading-tight)]">
            {isWhisper && (
              <span
                className={`px-1.5 py-0.5 rounded [font-size:var(--clowder-type-meta)] ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-conn-amber-bg text-conn-amber-text'}`}
              >
                {isRevealed ? '已揭秘' : `悄悄话 → ${message.whisperTo?.join(', ') ?? ''}`}
              </span>
            )}
            {message.replyTo && message.replyPreview && !isSchedulerReply && (
              <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
            )}
            <span className="[font-size:var(--clowder-type-sender)] font-semibold text-[var(--clowder-sender-user)]">
              {coCreator.name}
            </span>
            <span className="[font-size:var(--clowder-type-meta)] font-normal text-cafe-muted">
              {formatDualTime(message.timestamp, message.deliveredAt)}
            </span>
            {message.editedAt && (
              <span className="[font-size:var(--clowder-type-meta)] font-normal text-cafe-muted">（已编辑）</span>
            )}
          </div>
          <div
            className={
              isWhisper && !isRevealed
                ? 'rounded-2xl rounded-br-sm border border-dashed border-conn-amber-text/30 bg-conn-amber-bg px-4 py-3 text-conn-amber-text transition-transform hover:-translate-y-0.5'
                : ''
            }
          >
            {isEditing ? (
              <div className="space-y-2">
                <textarea
                  value={editDraft}
                  onChange={(event) => onChangeEditDraft?.(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      onCancelEdit?.();
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      onSaveEdit?.();
                    }
                  }}
                  autoFocus
                  disabled={isSavingEdit}
                  className="min-h-[88px] w-full resize-y rounded-lg border border-[var(--slock-border-color)] bg-[var(--cafe-surface-elevated)] px-3 py-2 text-sm text-cafe outline-none transition-colors focus:border-[var(--cafe-accent)]"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={onCancelEdit}
                    disabled={isSavingEdit}
                    className="rounded-md px-2 py-1 text-xs text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={onSaveEdit}
                    disabled={isSavingEdit || !editDraft.trim()}
                    className="rounded-md bg-[var(--cafe-accent)] px-2 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)] transition-opacity disabled:opacity-50"
                  >
                    {isSavingEdit ? '保存中...' : '保存'}
                  </button>
                </div>
              </div>
            ) : hasBlocks ? (
              <ContentBlocks blocks={message.contentBlocks!} />
            ) : disableContentCollapse ? (
              <MarkdownContent content={message.content} searchHighlight={searchHighlight} />
            ) : (
              <CollapsibleMarkdown content={message.content} searchHighlight={searchHighlight} />
            )}
          </div>
          {taskEntry && (
            <MessageTaskBadge
              task={taskEntry.task}
              seq={taskEntry.seq}
              assigneeLabel={taskAssigneeLabel}
              onOpen={onOpenTaskThread}
            />
          )}
          {message.sendStatus === 'failed' && (
            <div className="mt-2 flex w-fit items-center gap-2 border-2 border-conn-red-text bg-conn-red-bg px-2.5 py-1.5 text-xs font-semibold text-conn-red-text shadow-[var(--slock-shadow-chip)]">
              <span>发送失败：{message.sendError || '服务未收到'}</span>
              {onRetrySend && (
                <button
                  type="button"
                  onClick={() => onRetrySend(message)}
                  className="border border-current bg-[var(--cafe-surface)] px-2 py-0.5 font-black hover:bg-conn-red-ring"
                >
                  重试
                </button>
              )}
            </div>
          )}
          <MessageReactions messageId={message.id} reactions={message.extra?.reactions} />
          {threadReplyInfo && threadReplyInfo.replyCount > 0 && onOpenThread && (
            <ThreadReplyBadge
              count={threadReplyInfo.replyCount}
              newCount={threadReplyInfo.newCount}
              latestReply={threadReplyInfo.latestReply}
              latestAuthorLabel={
                threadReplyInfo.latestReply?.catId
                  ? (getCatById(threadReplyInfo.latestReply.catId)?.displayName ?? threadReplyInfo.latestReply.catId)
                  : '你'
              }
              onOpen={() => onOpenThread(message.id)}
            />
          )}
        </div>
      </div>
    );
  }

  // 猫 @ 了铲屎官（需要用户确认/参与）→ 卡片级显著标识，扫一眼就能看到自己的部分。
  const needsUserAttention = message.mentionsUser === true;

  return (
    <div
      data-message-id={message.id}
      className={`group flex gap-2 items-start transition-colors [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-body)] ${assistantAppearClass} ${isAssistantContinuation ? 'mb-1' : 'mb-4'} ${
        needsUserAttention
          ? 'border-l-[3px] border-[#F5A623] bg-[#F5A623]/[0.07] rounded-r-lg pl-2 pr-2 py-2 -ml-2'
          : ''
      }`}
    >
      {catData && !isAssistantContinuation && (
        <button
          type="button"
          onClick={() => useChatStore.getState().openMemberEditor(message.catId!)}
          className="cursor-pointer flex-shrink-0"
          title={`查看${formatCatName(catData)}详情`}
        >
          <CatAvatar
            catId={message.catId!}
            size={40}
            status={message.isStreaming ? 'streaming' : undefined}
            activityStatus={catActivityStatus}
          />
        </button>
      )}
      {catData && isAssistantContinuation && <div className="w-10 flex-shrink-0" aria-hidden="true" />}
      <div className="max-w-[85%] md:max-w-[1120px] min-w-0">
        {catStyle && !isAssistantContinuation && (
          <div className="mb-1 flex flex-col gap-1 min-w-0 [line-height:var(--clowder-leading-tight)]">
            <div className="flex items-center gap-2 min-w-0">
              {/* 用猫自己的主题色渲染名字（与头像/成员点同源），多猫协作时一眼可辨谁在发言。
                  catStyle.color 此前被计算但从未使用，名字全部同色。 */}
              <span
                className="[font-size:var(--clowder-type-sender)] font-semibold text-[var(--clowder-sender-agent)]"
                style={catStyle.color ? { color: catStyle.color } : undefined}
              >
                {catStyle.label}
              </span>
              {needsUserAttention && (
                <span className="inline-flex items-center gap-1 rounded-full border border-[#F5A623]/40 bg-[#F5A623]/15 px-2 py-0.5 font-semibold text-[#F5A623] [font-size:var(--clowder-type-meta)]">
                  <span aria-hidden>👋</span>
                  <span>@你 · 需要你</span>
                </span>
              )}
              <span className="[font-size:var(--clowder-type-meta)] font-normal text-cafe-muted">
                {formatTime(message.timestamp)}
              </span>
              {message.editedAt && (
                <span className="[font-size:var(--clowder-type-meta)] font-normal text-cafe-muted">（已编辑）</span>
              )}
              {isWhisper && (
                <span
                  className={`px-1.5 py-0.5 rounded [font-size:var(--clowder-type-meta)] ${isRevealed ? 'bg-cafe-surface-elevated text-cafe-secondary' : 'bg-conn-amber-bg text-conn-amber-text'}`}
                >
                  {isRevealed
                    ? '已揭秘'
                    : `悄悄话 → ${
                        message.whisperTo
                          ?.map((id) => {
                            const cat = getCatById(id);
                            return cat ? cat.displayName : id;
                          })
                          .join(', ') ?? ''
                      }`}
                </span>
              )}
              {!isWhisper && direction && <DirectionPill direction={direction} getCatById={getCatById} />}
              {message.replyTo && message.replyPreview && !isSchedulerReply && (
                <ReplyPill replyPreview={message.replyPreview} replyToId={message.replyTo} getCatById={getCatById} />
              )}
            </div>
            {showSchedulerAccent && (
              <div className={SCHEDULER_ACCENT_BADGE_CLASS}>
                <span aria-hidden>⏰</span>
                <span>定时提醒</span>
              </div>
            )}
            {showRuntimeMetadata ? fullRuntimeMetadataBadge : deliveryOnlyDegraded ? deliveryOnlyMetadataBadge : null}
            {message.extra?.crossPost &&
              (() => {
                const sourceId = message.extra.crossPost?.sourceThreadId;
                const sourceName = threads.find((t) => t.id === sourceId)?.title ?? '未命名对话';
                const shortId = sourceId.replace(/^thread_/, '').slice(0, 8);
                const senderLabel = catStyle?.label;
                return (
                  <a
                    href={getThreadHref(sourceId)}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      pushThreadRouteWithHistory(sourceId, typeof window !== 'undefined' ? window : undefined);
                    }}
                    className="inline-flex items-center gap-1.5 border px-3 py-1 rounded-full bg-[var(--console-card-soft-bg)] border-[var(--console-border-soft)] text-cafe-secondary hover:bg-[var(--console-hover-bg)] transition-colors cursor-pointer w-fit max-w-full"
                    title={sourceId}
                    aria-label={`跳转到来源 thread ${sourceId}`}
                  >
                    <span className="text-[10px] font-semibold" aria-hidden>
                      📮
                    </span>
                    <span className="min-w-0 truncate">
                      {senderLabel && <span className="font-medium">{senderLabel} · </span>}
                      {shortId} · {sourceName}
                    </span>
                  </a>
                );
              })()}
          </div>
        )}
        {deliveryOnlyDegraded && (isAssistantContinuation || !catStyle) && deliveryOnlyMetadataBadge}
        <div
          className={`overflow-visible w-full min-w-0 ${
            catStyle ? (catStyle.font ?? '') : ''
          } ${showSchedulerAccent ? SCHEDULER_ACCENT_BUBBLE_CLASS : ''}`}
        >
          {hasBlocks ? (
            <ContentBlocks blocks={message.contentBlocks!} />
          ) : disableContentCollapse && hasTextContent ? (
            <MarkdownContent content={visibleContent} className={catStyle?.font} searchHighlight={searchHighlight} />
          ) : hasTextContent ? (
            <CollapsibleMarkdown
              content={visibleContent}
              className={catStyle?.font}
              searchHighlight={searchHighlight}
            />
          ) : message.isStreaming ? (
            <span className="inline-flex items-center gap-1.5 [font-size:var(--clowder-type-meta)] text-cafe-secondary">
              <span className="animate-pulse" aria-hidden>
                ᓚᘏᗢ
              </span>
              <span className="animate-pulse">Thinking...</span>
            </span>
          ) : null}
          {message.thinking && (
            <ThinkingContent
              content={message.thinking}
              className={catStyle?.font}
              label="Thinking"
              defaultExpanded={
                bubbleRestorePending
                  ? false
                  : resolveBubbleExpanded(currentThread?.bubbleThinking, globalBubbleDefaults.thinking)
              }
              expandInExport={false}
              breedColor={catData?.color.primary}
            />
          )}
          {message.extra?.rich?.blocks && message.extra.rich.blocks.length > 0 && (
            <RichBlocks
              blocks={message.extra.rich.blocks}
              catId={message.catId}
              messageId={message.id}
              messageSource={message.source}
            />
          )}
          {message.isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-current animate-pulse ml-0.5 rounded-full opacity-50" />
          )}
        </div>
        {taskEntry && (
          <MessageTaskBadge
            task={taskEntry.task}
            seq={taskEntry.seq}
            assigneeLabel={taskAssigneeLabel}
            onOpen={onOpenTaskThread}
          />
        )}
        <MessageReactions messageId={message.id} reactions={message.extra?.reactions} />
        {threadReplyInfo && threadReplyInfo.replyCount > 0 && onOpenThread && (
          <ThreadReplyBadge
            count={threadReplyInfo.replyCount}
            newCount={threadReplyInfo.newCount}
            latestReply={threadReplyInfo.latestReply}
            latestAuthorLabel={
              threadReplyInfo.latestReply?.catId
                ? (getCatById(threadReplyInfo.latestReply.catId)?.displayName ?? threadReplyInfo.latestReply.catId)
                : '你'
            }
            onOpen={() => onOpenThread(message.id)}
          />
        )}
      </div>
    </div>
  );
}
