'use client';

import { useRouter } from 'next/navigation';
import { Fragment, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CoCreatorConfig } from '@/components/config-viewer-types';
import { TaskThreadActionsContext } from '@/contexts/TaskThreadActionsContext';
import { useAgentHookHealth } from '@/hooks/useAgentHookHealth';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useAuthorization } from '@/hooks/useAuthorization';
import { type CatData, useCatData } from '@/hooks/useCatData';
import { useChatHistory } from '@/hooks/useChatHistory';
import { useChatSocketCallbacks } from '@/hooks/useChatSocketCallbacks';
import { primeCoCreatorConfigCache, useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { godAction, submitAction } from '@/hooks/useGameApi';
import { reconnectGame } from '@/hooks/useGameReconnect';
import { useGovernanceStatus } from '@/hooks/useGovernanceStatus';
import { useIndexState } from '@/hooks/useIndexState';
import { usePersistedState } from '@/hooks/usePersistedState';
import { usePreviewAutoOpen } from '@/hooks/usePreviewAutoOpen';
import { useSendMessage } from '@/hooks/useSendMessage';
import { useSocket } from '@/hooks/useSocket';
import { useSplitPaneKeys } from '@/hooks/useSplitPaneKeys';
import { useThreadLiveness, useThreadMessages } from '@/hooks/useThreadScopedSelectors';
import { useVadInterrupt } from '@/hooks/useVadInterrupt';
import { useVisibleThreadReadAck } from '@/hooks/useVisibleThreadReadAck';
import { useVoiceAutoPlay } from '@/hooks/useVoiceAutoPlay';
import { useVoiceStream } from '@/hooks/useVoiceStream';
import { useWorkspaceNavigate } from '@/hooks/useWorkspaceNavigate';
import type { ThreadRoutingPolicyV1 } from '@/stores/chat-types';
import { type ChatMessage as ChatMessageData, type Thread, useChatStore } from '@/stores/chatStore';
import { useGameStore } from '@/stores/gameStore';
import { useGuideStore } from '@/stores/guideStore';
import { type TaskItem, useTaskStore } from '@/stores/taskStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import {
  consumeSavedMessageScrollTarget,
  isSavedMessagesViewOpen,
  SAVED_MESSAGES_VIEW_EVENT,
  setSavedMessagesViewOpen,
} from '@/utils/saved-messages';
import { computeScrollRecomputeSignal } from '@/utils/scrollRecomputeSignal';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { softDeleteThreadWithUndo } from '@/utils/thread-delete';
import { getUserId } from '@/utils/userId';
import { AgentHookHealthNotice, shouldRenderAgentHookHealthNotice } from './AgentHookHealthNotice';
import { AgentStatusIndicator } from './AgentStatusIndicator';
import { AuthorizationCard } from './AuthorizationCard';
import { BootcampListModal } from './BootcampListModal';
import { BootstrapOrchestrator } from './BootstrapOrchestrator';
import { ChatContainerHeader } from './ChatContainerHeader';
import { ChatInput } from './ChatInput';
import { ChatMessage, shouldRenderChatMessage } from './ChatMessage';
import { ConnectionStatusBar } from './ConnectionStatusBar';
import { EditChannelModal } from './EditChannelModal';
import { FilesPanel } from './FilesPanel';
import { FirstRunQuestWizard } from './FirstRunQuestWizard';
import { FreshnessHoldBar } from './FreshnessHoldBar';
import { BootcampGuideOverlay } from './first-run-quest/BootcampGuideOverlay';
import { QuestBanner } from './first-run-quest/QuestBanner';
import { syncLocalBootcampState } from './first-run-quest/syncLocalBootcampState';
import { useFirstProjectMistakeTipGate } from './first-run-quest/useFirstProjectMistakeTipGate';
import { useFirstProjectPreviewAutoOpen } from './first-run-quest/useFirstProjectPreviewAutoOpen';
import { GameOverlayConnector } from './game/GameOverlayConnector';
import { HubCatEditor } from './HubCatEditor';
import { HubCoCreatorEditor } from './HubCoCreatorEditor';
import { InlineThreadPanel } from './InlineThreadPanel';
import { BootcampIcon } from './icons/BootcampIcon';
import { PawIcon } from './icons/PawIcon';
import {
  applyInlineThreadReplyCountUpdate,
  type InlineThreadReplyCountUpdateOptions,
  type InlineThreadReplyState,
} from './inline-thread-reply-state';
import { KnowledgeCaptureModal } from './KnowledgeCaptureModal';
import { MessageActions } from './MessageActions';
import { MobileStatusSheet } from './MobileStatusSheet';
import { ProjectSetupCard } from './ProjectSetupCard';
import { QueuePanel } from './QueuePanel';
import { RightStatusPanel } from './RightStatusPanel';
import { SavedMessagesPanel } from './SavedMessagesPanel';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { SplitPaneView } from './SplitPaneView';
import { TasksPanel } from './TasksPanel';
import { ThreadSidebar } from './ThreadSidebar';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { VoteActiveBar } from './VoteActiveBar';
import { type VoteConfig, VoteConfigModal } from './VoteConfigModal';
import { WorkspacePanel } from './WorkspacePanel';
import { ResizeHandle } from './workspace/ResizeHandle';

interface ChatContainerProps {
  threadId: string;
}

const MESSAGE_GROUP_WINDOW_MS = 5 * 60 * 1000;
const INLINE_THREAD_EXIT_MS = 180;

type ThreadReplyInfo = InlineThreadReplyState[string] & { newCount?: number };
type InlineThreadState = { threadId: string; parentThreadId: string; sourceMessage: ChatMessageData; task?: TaskItem };
type ChannelTab = 'chat' | 'tasks' | 'files';
const EMPTY_MEMBER_IDS: string[] = [];

function consumeUrlMessageHighlight(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const messageId = params.get('highlight');
  if (!messageId) return null;

  params.delete('highlight');
  const nextSearch = params.toString();
  const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', nextUrl);
  return messageId;
}

function formatPinnedMessagePreview(message: ChatMessageData): string {
  const text = message.content?.trim() || '（无正文）';
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function findUnreadDividerIndex(messages: ChatMessageData[], lastReadMessageId?: string, unreadCount?: number): number {
  if (!lastReadMessageId || !unreadCount || unreadCount <= 0) return -1;
  return messages.findIndex((message) => shouldRenderChatMessage(message) && message.id > lastReadMessageId);
}

function UnreadDivider() {
  return (
    <div className="my-3 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-conn-muted">
      <div className="h-px flex-1 bg-[var(--console-border)]" />
      <span className="border-2 border-[var(--console-border-strong)] bg-[var(--console-panel)] px-2 py-1 text-[var(--console-text)] shadow-[var(--slock-shadow-chip)]">
        上次读到这里
      </span>
      <div className="h-px flex-1 bg-[var(--console-border)]" />
    </div>
  );
}

function ChatTabIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3.25 4.25h9.5v6.5h-5l-3 2v-2h-1.5z" />
    </svg>
  );
}

function TasksTabIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5.5 4.25h7" />
      <path d="M5.5 8h7" />
      <path d="M5.5 11.75h7" />
      <path d="M2.75 4.25h.5" />
      <path d="M2.75 8h.5" />
      <path d="M2.75 11.75h.5" />
    </svg>
  );
}

function FilesTabIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5.5 8.75 8.9 5.35a2.05 2.05 0 0 1 2.9 2.9l-4.25 4.25a3.2 3.2 0 0 1-4.52-4.52l4.1-4.1" />
    </svg>
  );
}

function ChannelTabs({ activeTab, onTabChange }: { activeTab: ChannelTab; onTabChange: (tab: ChannelTab) => void }) {
  const tabs: Array<{ id: ChannelTab; icon: ReactNode; label: string }> = [
    { id: 'chat', icon: <ChatTabIcon />, label: 'Chat' },
    { id: 'tasks', icon: <TasksTabIcon />, label: 'Tasks' },
    { id: 'files', icon: <FilesTabIcon />, label: 'Files' },
  ];

  return (
    <div className="slock-channel-tabs-row flex h-7 flex-shrink-0 items-center bg-[var(--console-shell-bg)] px-5">
      <div className="slock-tab-segmented flex h-7 w-fit overflow-hidden">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              data-active={isActive ? 'true' : 'false'}
              className={`slock-tab-button relative flex h-full items-center gap-1.5 px-3 text-[11px] tracking-[0.12em] transition-colors ${
                isActive
                  ? 'font-semibold text-[var(--cafe-text)]'
                  : 'text-[var(--cafe-text-muted)] hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)]'
              }`}
              aria-pressed={isActive}
            >
              <span aria-hidden="true" className="slock-tab-icon">
                {tab.icon}
              </span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Empty-thread hint, derived from the roster that actually exists.
 *
 * The previous copy hardcoded "@布偶", which only made sense when the three
 * built-in breeds were the whole roster — with a custom roster it names a member
 * that cannot be summoned.
 */
function emptyThreadMentionHint(cats: CatData[]): string {
  const first = cats[0];
  if (!first) return '还没有可用成员，先开始新手教程创建第一只猫猫';
  const handle = first.mentionPatterns?.[0] ?? `@${first.id}`;
  const label = first.nickname?.trim() || first.displayName || first.name || first.id;
  return `输入 ${handle} 召唤${label}开始聊天`;
}

export function ChatContainer({ threadId }: ChatContainerProps) {
  const router = useRouter();
  const bottomChromeRef = useRef<HTMLDivElement | null>(null);
  const bottomChromeObserverRef = useRef<ResizeObserver | null>(null);
  const bottomChromeObserverRafRef = useRef<number | null>(null);
  const {
    setCurrentThread,
    viewMode,
    setViewMode,
    isLoading: chatIsLoading,
    clearUnread,
    rightPanelMode,
  } = useChatStore();
  // F173 Phase C Task 3 — full read-side migration. All thread liveness +
  // messages now flow through thread-scoped selectors keyed off this
  // component's `threadId` prop, not the flat current-thread mirror. Closes
  // AC-C6 race window for the entire ChatContainer surface (Task 2 only
  // covered hasActiveInvocation; this finishes the job).
  const messages = useThreadMessages(threadId);
  const {
    hasActive: hasActiveInvocation,
    activeInvocations,
    catStatuses,
    catInvocations,
    intentMode,
    targetCats,
  } = useThreadLiveness(threadId);
  const navigateToThread = useCallback((tid: string) => {
    pushThreadRouteWithHistory(tid, typeof window !== 'undefined' ? window : undefined);
  }, []);
  const uiThinkingExpandedByDefault = useChatStore((s) => s.uiThinkingExpandedByDefault);
  const isOfflineSnapshot = useChatStore((s) => s.isOfflineSnapshot);

  // F101: Game state from Zustand store
  const gameView = useGameStore((s) => s.gameView);
  const isGameActive = useGameStore((s) => s.isGameActive);
  const isNight = useGameStore((s) => s.isNight);
  const selectedTarget = useGameStore((s) => s.selectedTarget);
  const godScopeFilter = useGameStore((s) => s.godScopeFilter);
  const myRole = useGameStore((s) => s.myRole);
  const myRoleIcon = useGameStore((s) => s.myRoleIcon);
  const myActionLabel = useGameStore((s) => s.myActionLabel);
  const myActionHint = useGameStore((s) => s.myActionHint);
  const isGodView = useGameStore((s) => s.isGodView);
  const isDetective = useGameStore((s) => s.isDetective);
  const detectiveBoundName = useGameStore((s) => s.detectiveBoundName);
  const godSeats = useGameStore((s) => s.godSeats);
  const godNightSteps = useGameStore((s) => s.godNightSteps);
  const hasTargetedAction = useGameStore((s) => s.hasTargetedAction);
  const altActionName = useGameStore((s) => s.altActionName);
  const overlayMinimized = useGameStore((s) => s.overlayMinimized);

  const searchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const isExport = searchParams?.get('export') === 'true';
  const isResearchMode = searchParams?.get('research') === 'multi';
  const { clearTasks, updateTask } = useTaskStore();
  const { cats, getCatById, isLoading, hasFetched } = useCatData();
  const workspaceWorktreeId = useChatStore((s) => s.workspaceWorktreeId);
  usePreviewAutoOpen(workspaceWorktreeId, threadId);
  useWorkspaceNavigate(workspaceWorktreeId, threadId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [statusPanelOpen, setStatusPanelOpen] = useState(false);
  const [inlineThread, setInlineThread] = useState<InlineThreadState | null>(null);
  const [inlineThreadClosing, setInlineThreadClosing] = useState(false);
  const inlineThreadCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [inlineThreadReplies, setInlineThreadReplies] = useState<InlineThreadReplyState>({});
  const [pinnedMessage, setPinnedMessage] = useState<ChatMessageData | null>(null);
  const [activeTab, setActiveTab] = useState<ChannelTab>('chat');
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);
  const [knowledgeCaptureOpen, setKnowledgeCaptureOpen] = useState(false);
  const [isSavingChannel, setIsSavingChannel] = useState(false);
  const [isDeletingChannel, setIsDeletingChannel] = useState(false);
  const [channelSettingsError, setChannelSettingsError] = useState<string | null>(null);
  const [mobileStatusOpen, setMobileStatusOpen] = useState(false);
  const [showBootcampList, setShowBootcampList] = useState(false);
  const [showFirstRunQuestPrompt, setShowFirstRunQuestPrompt] = useState(false);
  const [showQuestWizard, setShowQuestWizard] = useState(false);
  const [savedMessagesViewOpen, setSavedMessagesViewOpenState] = useState(false);
  // F106: fetch bootcamp count independently of sidebar lifecycle
  // refreshKey increments only on modal close → avoids duplicate fetch on open
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_bootcampRefreshKey, setBootcampRefreshKey] = useState(0);
  const patchMessage = useChatStore((s) => s.patchMessage);
  const removeThreadMessage = useChatStore((s) => s.removeThreadMessage);
  const addToast = useToastStore((s) => s.addToast);
  const handleBootcampModalClose = useCallback(() => {
    setShowBootcampList(false);
    setBootcampRefreshKey((k) => k + 1);
  }, []);
  const [bootcampCount, setBootcampCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/bootcamp/threads')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const data = await res.json();
        if (!cancelled) setBootcampCount(data.threads?.length ?? 0);
      })
      .catch(() => {
        if (!cancelled) setBootcampCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  // F063: resizable split pane — chatBasis as percentage (20-80), persisted
  const [chatBasis, setChatBasis, resetChatBasis] = usePersistedState('cat-cafe:chatBasis', 50);
  // clowder-ai#28: right status panel width in px, persisted
  const STATUS_PANEL_DEFAULT = 304;
  const [statusPanelWidth, setStatusPanelWidth, resetStatusPanelWidth] = usePersistedState(
    'cat-cafe:statusPanelWidth',
    STATUS_PANEL_DEFAULT,
  );
  // F063 Gap 6: sidebar width in px, persisted
  const SIDEBAR_DEFAULT = 240;
  const [sidebarWidth] = usePersistedState('cat-cafe:sidebarWidth', SIDEBAR_DEFAULT);
  const containerRef = useRef<HTMLDivElement>(null);
  const handleHorizontalResize = useCallback(
    (delta: number) => {
      if (!containerRef.current) return;
      const totalWidth = containerRef.current.offsetWidth;
      if (totalWidth === 0) return;
      const pct = (delta / totalWidth) * 100;
      setChatBasis((prev) => Math.min(80, Math.max(20, prev + pct)));
    },
    [setChatBasis],
  );
  // clowder-ai#28: drag-to-resize for right status panel (negative delta = panel wider)
  const handleStatusPanelResize = useCallback(
    (delta: number) => {
      setStatusPanelWidth((prev) => Math.min(480, Math.max(200, prev - delta)));
    },
    [setStatusPanelWidth],
  );

  // F063: auto-open panel when message file path click triggers workspace mode
  useEffect(() => {
    if (rightPanelMode === 'workspace' && !statusPanelOpen) {
      setStatusPanelOpen(true);
    }
  }, [rightPanelMode, statusPanelOpen]);

  // Desktop: open sidebar before first paint (useLayoutEffect avoids false→true flicker).
  // SSR parity: both server and client start with false, layoutEffect flips before paint.
  useLayoutEffect(() => {
    if (typeof window.matchMedia === 'function' && window.matchMedia('(min-width: 768px)').matches) {
      setSidebarOpen(true);
    }
  }, []);

  const { handleAgentMessage, handleStop: stopHandler, resetRefs, resetTimeout, clearDoneTimeout } = useAgentMessages();
  const { handleScroll, scrollContainerRef, messagesEndRef, isLoadingHistory, hasMore } = useChatHistory(threadId);
  const { handleSend, uploadStatus, uploadError } = useSendMessage(threadId);
  const handleRetryFailedSend = useCallback(
    (message: ChatMessageData) => {
      if (message.contentBlocks?.some((block) => block.type === 'image' || block.type === 'file')) {
        addToast({
          type: 'error',
          title: '请重新选择附件',
          message: '浏览器不能安全复用上次选择的文件。',
          duration: 3000,
        });
        return;
      }
      removeThreadMessage(message.threadId ?? threadId, message.id);
      void handleSend(message.content, undefined, message.threadId ?? threadId);
    },
    [addToast, handleSend, removeThreadMessage, threadId],
  );
  const setThreads = useChatStore((s) => s.setThreads);
  const threadStates = useChatStore((s) => s.threadStates);
  const handleInlineThreadReplyCountChange = useCallback(
    (
      sourceMessageId: string,
      branchThreadId: string,
      replyCount: number,
      options?: InlineThreadReplyCountUpdateOptions,
    ) => {
      setInlineThreadReplies((prev) =>
        applyInlineThreadReplyCountUpdate(prev, sourceMessageId, branchThreadId, replyCount, options),
      );
    },
    [],
  );
  const clearInlineThreadCloseTimer = useCallback(() => {
    if (inlineThreadCloseTimerRef.current) {
      clearTimeout(inlineThreadCloseTimerRef.current);
      inlineThreadCloseTimerRef.current = null;
    }
  }, []);
  const openInlineThread = useCallback(
    (next: InlineThreadState) => {
      clearInlineThreadCloseTimer();
      clearUnread(next.threadId);
      setInlineThreadClosing(false);
      setInlineThread(next);
    },
    [clearInlineThreadCloseTimer, clearUnread],
  );
  const closeInlineThread = useCallback(() => {
    if (!inlineThread) return;
    clearInlineThreadCloseTimer();
    setInlineThreadClosing(true);
    inlineThreadCloseTimerRef.current = setTimeout(() => {
      inlineThreadCloseTimerRef.current = null;
      setInlineThread(null);
      setInlineThreadClosing(false);
    }, INLINE_THREAD_EXIT_MS);
  }, [clearInlineThreadCloseTimer, inlineThread]);
  useEffect(() => {
    return () => clearInlineThreadCloseTimer();
  }, [clearInlineThreadCloseTimer]);
  const openInlineThreadFromMessage = useCallback(
    async (sourceMessage: ChatMessageData) => {
      setStatusPanelOpen(false);
      const existing = inlineThreadReplies[sourceMessage.id] ?? sourceMessage.extra?.slockThread;
      if (existing) {
        clearUnread(existing.branchThreadId);
        openInlineThread({
          threadId: existing.branchThreadId,
          parentThreadId: sourceMessage.threadId ?? threadId,
          sourceMessage,
        });
        return;
      }

      try {
        const sourceThreadId = sourceMessage.threadId ?? threadId;
        const res = await apiFetch(`/api/threads/${encodeURIComponent(sourceThreadId)}/branch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fromMessageId: sourceMessage.id, userId: getUserId() }),
        });
        if (!res.ok) {
          addToast({
            type: 'error',
            title: 'Thread 创建失败',
            message: '已阻止把 Thread 回复写入主频道，请刷新后重试。',
            duration: 4200,
          });
          return;
        }
        const data = (await res.json()) as { threadId?: string };
        const branchThreadId = data.threadId ?? sourceThreadId;
        if (branchThreadId === sourceThreadId) {
          addToast({
            type: 'error',
            title: 'Thread 创建失败',
            message: '服务没有返回独立 Thread，已阻止把回复写入主频道。',
            duration: 4200,
          });
          return;
        }
        openInlineThread({ threadId: branchThreadId, parentThreadId: sourceThreadId, sourceMessage });
        handleInlineThreadReplyCountChange(sourceMessage.id, branchThreadId, 0);
        const threadsRes = await apiFetch('/api/threads');
        if (threadsRes.ok) {
          const threadsData = (await threadsRes.json()) as { threads: Thread[] };
          setThreads(threadsData.threads);
        }
      } catch {
        addToast({
          type: 'error',
          title: 'Thread 创建失败',
          message: '网络请求未完成，已阻止把回复写入主频道。',
          duration: 4200,
        });
      }
    },
    [
      addToast,
      clearUnread,
      handleInlineThreadReplyCountChange,
      inlineThreadReplies,
      openInlineThread,
      setThreads,
      threadId,
    ],
  );
  const handleOpenInlineThread = useCallback(
    async (messageId: string) => {
      const sourceMessage = messages.find((message) => message.id === messageId);
      if (!sourceMessage) return;
      await openInlineThreadFromMessage(sourceMessage);
    },
    [messages, openInlineThreadFromMessage],
  );
  const handleOpenTaskThread = useCallback(
    async (task: TaskItem) => {
      try {
        const res = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}/thread`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: getUserId() }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          threadId?: string;
          sourceMessage?: {
            id: string;
            threadId?: string;
            catId?: string | null;
            content: string;
            timestamp: number;
            editedAt?: number;
            origin?: unknown;
          };
          task?: TaskItem;
        };
        if (!data.threadId || !data.sourceMessage) throw new Error('Missing task thread payload');
        const sourceMessage: ChatMessageData = {
          id: data.sourceMessage.id,
          threadId: data.sourceMessage.threadId ?? data.threadId,
          type: data.sourceMessage.catId ? 'assistant' : data.sourceMessage.origin ? 'connector' : 'user',
          catId: data.sourceMessage.catId ?? undefined,
          content: data.sourceMessage.content,
          timestamp: data.sourceMessage.timestamp,
          ...(data.sourceMessage.editedAt ? { editedAt: data.sourceMessage.editedAt } : {}),
        };
        if (data.task) updateTask(data.task);
        openInlineThread({
          threadId: data.threadId,
          parentThreadId: data.sourceMessage?.threadId ?? threadId,
          sourceMessage,
          task: data.task ?? task,
        });
      } catch {
        addToast({
          type: 'error',
          title: '打开任务 Thread 失败',
          message: '未能读取任务关联消息，请刷新后重试。',
          duration: 3600,
        });
      }
    },
    [addToast, openInlineThread, threadId, updateTask],
  );
  const taskThreadActions = useMemo(() => ({ openTaskThread: handleOpenTaskThread }), [handleOpenTaskThread]);
  useEffect(() => {
    clearInlineThreadCloseTimer();
    setInlineThreadClosing(false);
    setInlineThread(null);
  }, [clearInlineThreadCloseTimer, threadId]);
  const {
    pending: authPending,
    respond: authRespond,
    handleAuthRequest,
    handleAuthResponse,
  } = useAuthorization(threadId);

  // F096: Listen for interactive block send events
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail.text;
      if (text) handleSend(text);
    };
    window.addEventListener('cat-cafe:interactive-send', handler);
    return () => window.removeEventListener('cat-cafe:interactive-send', handler);
  }, [handleSend]);

  // F079: Vote modal
  const showVoteModal = useChatStore((s) => s.showVoteModal);
  const setShowVoteModal = useChatStore((s) => s.setShowVoteModal);
  const { addMessage } = useChatStore();
  const handleVoteSubmit = useCallback(
    async (config: VoteConfig) => {
      setShowVoteModal(false);
      try {
        const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/vote/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(config),
        });
        if (res.status === 409) {
          addMessage({
            id: `vote-${Date.now()}`,
            type: 'system',
            variant: 'error',
            content: '已有活跃投票，请先 /vote end',
            timestamp: Date.now(),
          });
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Server error: ${res.status}`);
        }
        const data = await res.json();
        // Build @mention notification message and send as user message to trigger cats
        const mentions = config.voters.map((v) => `@${v}`).join(' ');
        const optionList = config.options.map((o) => `• ${o}`).join('\n');
        const notifyMsg = `${mentions}\n投票请求：${data.question}\n\n选项：\n${optionList}\n\n请在回复中包含 [VOTE:你的选项]，例如 [VOTE:${config.options[0]}]`;
        handleSend(notifyMsg);
      } catch (err) {
        addMessage({
          id: `vote-${Date.now()}`,
          type: 'system',
          variant: 'error',
          content: `发起投票失败: ${err instanceof Error ? err.message : 'Unknown'}`,
          timestamp: Date.now(),
        });
      }
    },
    [threadId, handleSend, setShowVoteModal, addMessage],
  );

  const messageSummary = useMemo(() => {
    const c = { total: messages.length, assistant: 0, system: 0, evidence: 0, followup: 0 };
    for (const msg of messages) {
      const isAssistant = msg.type === 'assistant' || (msg.type === 'user' && !!msg.catId);
      if (isAssistant) c.assistant++;
      if (msg.type === 'system') {
        c.system++;
        if (msg.variant === 'evidence') c.evidence++;
        if (msg.variant === 'a2a_followup') c.followup++;
      }
    }
    return c;
  }, [messages]);

  // Sync URL-driven threadId to store (store is follower, URL is source of truth)
  // setCurrentThread saves old thread state to map, restores new thread state.
  const setCurrentProject = useChatStore((s) => s.setCurrentProject);
  const storeThreads = useChatStore((s) => s.threads);
  const handleSkipFirstRunQuest = useCallback(() => {
    // Session-only skip — next refresh will re-check backend state
    setShowFirstRunQuestPrompt(false);
  }, []);
  const handleStartFirstRunQuest = useCallback(() => {
    setShowFirstRunQuestPrompt(false);
    setShowQuestWizard(true);
  }, []);
  const currentBootcampState = storeThreads.find((thread) => thread.id === threadId)?.bootcampState;
  const currentThread = storeThreads.find((thread) => thread.id === threadId);
  const currentThreadTitle = threadId === 'default' ? '大厅' : (currentThread?.title ?? '未命名对话');
  const currentThreadMemberIds = currentThread?.participatingCats ?? currentThread?.preferredCats ?? EMPTY_MEMBER_IDS;
  const unreadDividerIndex = useMemo(
    () =>
      isExport ? -1 : findUnreadDividerIndex(messages, currentThread?.lastReadMessageId, currentThread?.unreadCount),
    [isExport, messages, currentThread?.lastReadMessageId, currentThread?.unreadCount],
  );
  const currentBootcampPhase = currentBootcampState?.phase;
  const showFirstProjectMistakeTip = useFirstProjectMistakeTipGate({
    threadId,
    phase: currentBootcampPhase,
    messageCount: messages.length,
    hasActiveInvocation,
  });
  useFirstProjectPreviewAutoOpen({
    threadId,
    phase: currentBootcampPhase,
    messageCount: messages.length,
    hasActiveInvocation,
    worktreeId: workspaceWorktreeId,
  });
  const mistakeTipAdvanceKeyRef = useRef<string | null>(null);
  const handleMistakeTipVisible = useCallback(() => {
    // Read threads fresh from store to keep callback ref stable (avoids resetting
    // DelayedMistakeTip's 1500ms onVisible timer on every storeThreads change).
    const currentThread = useChatStore.getState().threads.find((thread) => thread.id === threadId);
    const raw = currentThread?.bootcampState;
    if (!raw || raw.phase !== 'phase-7-dev') return;

    const key = `${threadId}:${String(raw.startedAt ?? 'unknown')}:phase-4`;
    if (mistakeTipAdvanceKeyRef.current === key) return;
    const nextBootcampState: NonNullable<Thread['bootcampState']> = {
      ...raw,
      phase: 'phase-7.5-add-teammate',
    };

    void apiFetch(`/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bootcampState: nextBootcampState,
      }),
    }).then((res) => {
      if (res.ok) {
        mistakeTipAdvanceKeyRef.current = key;
        syncLocalBootcampState(threadId, nextBootcampState);
      }
      return res;
    });
  }, [threadId]);
  // When gate fires (invocation ended with new Phase 4 output), advance immediately
  useEffect(() => {
    if (showFirstProjectMistakeTip) {
      handleMistakeTipVisible();
    }
  }, [showFirstProjectMistakeTip, handleMistakeTipVisible]);
  useEffect(() => {
    if (currentBootcampPhase !== 'phase-7-dev') {
      mistakeTipAdvanceKeyRef.current = null;
    }
  }, [currentBootcampPhase, threadId]);
  useEffect(() => {
    // Pure backend-driven: show prompt only when no cats AND no bootcamp thread
    const isCurrentBootcamp = Boolean(storeThreads.find((thread) => thread.id === threadId)?.bootcampState);
    const hasAnyBootcamp = storeThreads.some((t) => t.bootcampState);
    if (isCurrentBootcamp || hasAnyBootcamp || cats.length > 0 || isLoading) {
      setShowFirstRunQuestPrompt(false);
      return;
    }
    // Wait for thread store to populate before deciding — prevents flash on page refresh
    if (storeThreads.length === 0) return;
    // Only show first-run prompt after a successful cat fetch — prevents false
    // positives when /api/cats fails transiently (returns [] on network error).
    if (!hasFetched) return;
    setShowFirstRunQuestPrompt(true);
  }, [cats.length, isLoading, hasFetched, storeThreads, threadId]);

  // ── Data sync: re-fetch thread state ──
  // MCP callbacks update Redis directly; the companion WebSocket `thread_updated`
  // may not reach this frontend (e.g. worktree port isolation). Re-fetching the
  // thread ensures the store stays in sync.
  const syncThreadState = useCallback(() => {
    apiFetch(`/api/threads/${threadId}`)
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{
              bootcampState?: Thread['bootcampState'];
              firstRunQuestState?: { phase: string; firstCatName?: string };
            }>)
          : null,
      )
      .then((thread) => {
        if (!thread) return;
        const local = useChatStore.getState().threads.find((t) => t.id === threadId);
        if (thread.bootcampState || local?.bootcampState) {
          syncLocalBootcampState(threadId, thread.bootcampState);
        }
        const localQuest = (local as Record<string, unknown> | undefined)?.firstRunQuestState;
        if (thread.firstRunQuestState || localQuest) {
          useChatStore.setState((state) => ({
            threads: state.threads.map((t) =>
              t.id === threadId ? { ...t, firstRunQuestState: thread.firstRunQuestState } : t,
            ),
          }));
        }
      })
      .catch(() => {});
  }, [threadId]);

  // Sync on invocation end (active → inactive transition)
  const prevInvocationRef = useRef(hasActiveInvocation);
  useEffect(() => {
    const wasActive = prevInvocationRef.current;
    prevInvocationRef.current = hasActiveInvocation;
    if (!wasActive || hasActiveInvocation) return;
    syncThreadState();
  }, [hasActiveInvocation, syncThreadState]);

  // Sync on mount / thread switch — sidebar may not have loaded yet
  useEffect(() => {
    syncThreadState();
  }, [syncThreadState]);

  // ── Bootcamp add-teammate: trigger guide engine when user interacts with input ──
  // Subscribe reactively so the effect re-runs when guide exits (session cleared).
  const activeGuideFlowId = useGuideStore((s) => s.session?.flow.id ?? null);
  useEffect(() => {
    if (currentBootcampPhase !== 'phase-7.5-add-teammate') return;
    // Guide already running — don't re-register
    if (activeGuideFlowId === 'bootcamp-add-teammate') return;
    // Prevent re-triggering a guide that already completed for this thread
    if (useGuideStore.getState().completedGuides.has(`${threadId}::bootcamp-add-teammate`)) return;

    const startGuide = () => {
      const { session: s, completedGuides: cg } = useGuideStore.getState();
      if (s?.flow.id === 'bootcamp-add-teammate') return;
      if (cg.has(`${threadId}::bootcamp-add-teammate`)) return;
      useGuideStore.getState().reduceServerEvent({
        action: 'start',
        guideId: 'bootcamp-add-teammate',
        threadId,
      });
    };

    // Wait for user to type in chat input before starting guide
    const handler = (e: Event) => {
      if ((e.target as HTMLElement)?.closest('[data-guide-id="chat.input"]')) {
        startGuide();
        document.removeEventListener('input', handler, true);
      }
    };
    document.addEventListener('input', handler, true);
    return () => {
      document.removeEventListener('input', handler, true);
    };
  }, [currentBootcampPhase, threadId, activeGuideFlowId]);

  // ── Bootcamp farewell: auto-trigger guide after agent finishes at phase-10-retro ──
  // Guard with both hasActiveInvocation AND chatIsLoading:
  // - hasActiveInvocation tracks per-slot presence (can briefly go false during A2A handoff)
  // - chatIsLoading stays true for the entire serial chain (cleared only on isFinal=true)
  const farewellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (farewellTimerRef.current) {
      clearTimeout(farewellTimerRef.current);
      farewellTimerRef.current = null;
    }
    if (currentBootcampPhase !== 'phase-10-retro') return;
    if (hasActiveInvocation || chatIsLoading) return;
    if (activeGuideFlowId === 'bootcamp-farewell') return;
    if (useGuideStore.getState().completedGuides.has(`${threadId}::bootcamp-farewell`)) return;

    farewellTimerRef.current = setTimeout(() => {
      farewellTimerRef.current = null;
      const s = useChatStore.getState();
      if (s.hasActiveInvocation || s.isLoading) return;
      useGuideStore.getState().reduceServerEvent({
        action: 'start',
        guideId: 'bootcamp-farewell',
        threadId,
      });
    }, 800);
    return () => {
      if (farewellTimerRef.current) {
        clearTimeout(farewellTimerRef.current);
        farewellTimerRef.current = null;
      }
    };
  }, [currentBootcampPhase, threadId, activeGuideFlowId, hasActiveInvocation, chatIsLoading]);

  const prevThreadRef = useRef(threadId);
  useEffect(() => {
    if (prevThreadRef.current !== threadId) {
      // Thread switch: store saves/restores per-thread state automatically
      setCurrentThread(threadId);
      // F173 A.12 — resetRefs no longer touches suppression markers (invocation-driven cleanup).
      // It still clears activeRefs / finalizedStreamRef / sawStreamData per the original purpose.
      resetRefs();
      clearTasks();
      prevThreadRef.current = threadId;
    }
    // First mount — sync threadId to store without save/restore
    setCurrentThread(threadId);
    // F101: Recover game state for the new thread (or clear stale game from previous thread)
    reconnectGame(threadId).catch(() => {});
  }, [
    threadId,
    clearTasks, // Clean up non-thread-scoped refs
    resetRefs, // First mount — sync threadId to store without save/restore
    setCurrentThread,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  // B1.1: Restore projectPath when thread or storeThreads change.
  // storeThreads is populated by ThreadSidebar.loadThreads shortly after mount,
  // so this covers both page refresh (threads arrive async) and thread switch.
  useEffect(() => {
    const cached = storeThreads?.find((t) => t.id === threadId);
    if (cached) {
      setCurrentProject(cached.projectPath || 'default');
    }
  }, [threadId, storeThreads, setCurrentProject]);

  // F113-E: Fetch governance status for the current project (drives ProjectSetupCard)
  const currentProjectPath = useChatStore((s) => s.currentProjectPath);
  const { status: govStatus, refetch: govRefetch } = useGovernanceStatus(currentProjectPath);
  const isProjectThread = !!currentProjectPath && currentProjectPath !== 'default' && currentProjectPath !== 'lobby';
  const agentHookHealth = useAgentHookHealth({ enabled: isProjectThread });
  const [setupDone, setSetupDone] = useState(false);
  // Show card when: needs setup (idle) OR just completed setup (done) — only in empty threads
  const showSetupCard = !!(
    (govStatus?.needsBootstrap || govStatus?.needsConfirmation || setupDone) &&
    messages.length === 0
  );
  // Reset setupDone on thread switch. Governance status already auto-refetches
  // when projectPath changes inside useGovernanceStatus; same-project thread switches
  // should not trigger an extra network round-trip.
  const prevThreadSetup = useRef(threadId);
  useEffect(() => {
    if (prevThreadSetup.current !== threadId) {
      prevThreadSetup.current = threadId;
      setSetupDone(false);
    }
  }, [threadId]);
  const showAgentHookNotice =
    isProjectThread &&
    !showSetupCard &&
    shouldRenderAgentHookHealthNotice({
      health: agentHookHealth.health,
      error: agentHookHealth.error,
      syncing: agentHookHealth.syncing,
      synced: agentHookHealth.synced,
    });

  // F152 Phase B: memory bootstrap state
  const {
    state: indexState,
    progress: bootstrapProgress,
    summary: bootstrapSummary,
    durationMs: bootstrapDurationMs,
    isSnoozed,
    startBootstrap,
    snooze: snoozeBootstrap,
    handleSocketEvent: handleIndexSocketEvent,
  } = useIndexState(currentProjectPath);

  const socketCallbacks = useChatSocketCallbacks({
    threadId,
    userId: getUserId(),
    handleAgentMessage,
    resetTimeout,
    clearDoneTimeout,
    handleAuthRequest,
    handleAuthResponse,
    onNavigateToThread: navigateToThread,
    onIndexEvent: handleIndexSocketEvent,
  });

  const handleStartEditMessage = useCallback(
    (message: ChatMessageData) => {
      if (message.type !== 'user' || message.catId || message.contentBlocks?.length) {
        addToast({
          type: 'error',
          title: '暂不支持编辑此消息',
          message: '当前只支持编辑自己发送的普通文本消息',
          duration: 2200,
        });
        return;
      }
      setEditingMessageId(message.id);
      setEditingDraft(message.content);
    },
    [addToast],
  );

  const handleCancelEditMessage = useCallback(() => {
    if (isSavingEdit) return;
    setEditingMessageId(null);
    setEditingDraft('');
  }, [isSavingEdit]);

  const handleSaveEditMessage = useCallback(async () => {
    if (!editingMessageId || isSavingEdit) return;
    const nextContent = editingDraft.trim();
    if (!nextContent) {
      addToast({ type: 'error', title: '内容不能为空', message: '请输入要保存的消息内容', duration: 1800 });
      return;
    }
    const current = messages.find((message) => message.id === editingMessageId);
    if (!current) return;
    if (nextContent === current.content.trim()) {
      setEditingMessageId(null);
      setEditingDraft('');
      return;
    }

    setIsSavingEdit(true);
    try {
      const res = await apiFetch(`/api/messages/${editingMessageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: getUserId(), content: nextContent }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        addToast({
          type: 'error',
          title: '编辑失败',
          message: (body?.error as string) ?? '请稍后重试',
          duration: 3000,
        });
        return;
      }

      patchMessage(editingMessageId, {
        content: (body?.content as string) ?? nextContent,
        editedAt: (body?.editedAt as number) ?? Date.now(),
      });
      setEditingMessageId(null);
      setEditingDraft('');
    } catch {
      addToast({ type: 'error', title: '编辑失败', message: '网络请求未完成', duration: 3000 });
    } finally {
      setIsSavingEdit(false);
    }
  }, [addToast, editingDraft, editingMessageId, isSavingEdit, messages, patchMessage]);

  const handleSaveChannelSettings = useCallback(
    async ({
      title: nextTitle,
      participatingCats,
      routingPolicy,
    }: {
      title: string;
      participatingCats: string[];
      routingPolicy: ThreadRoutingPolicyV1 | null;
    }) => {
      if (isSavingChannel || isDeletingChannel) return;
      setIsSavingChannel(true);
      setChannelSettingsError(null);
      try {
        const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: nextTitle, participatingCats, routingPolicy }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setChannelSettingsError((body?.error as string) ?? '保存失败，请稍后重试');
          return;
        }
        useChatStore.setState((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  title: (body?.title as string) ?? nextTitle,
                  participatingCats: Array.isArray(body?.participatingCats)
                    ? (body.participatingCats as string[])
                    : participatingCats,
                  routingPolicy:
                    body?.routingPolicy && typeof body.routingPolicy === 'object'
                      ? (body.routingPolicy as ThreadRoutingPolicyV1)
                      : undefined,
                }
              : thread,
          ),
        }));
        setChannelSettingsOpen(false);
        addToast({ type: 'success', title: '频道已更新', message: '频道名称、成员和路由已保存', duration: 2200 });
      } catch {
        setChannelSettingsError('网络请求未完成，请稍后重试');
      } finally {
        setIsSavingChannel(false);
      }
    },
    [addToast, isDeletingChannel, isSavingChannel, threadId],
  );

  const handleKnowledgeCreated = useCallback(
    (result: { id: string; path: string }) => {
      addToast({
        type: 'success',
        title: '知识已沉淀',
        message: `${result.id} → ${result.path}`,
        duration: 4000,
      });
    },
    [addToast],
  );

  const handleDeleteChannel = useCallback(async () => {
    if (threadId === 'default' || isDeletingChannel || isSavingChannel) return;
    setIsDeletingChannel(true);
    setChannelSettingsError(null);
    try {
      const error = await softDeleteThreadWithUndo(threadId, {
        title: currentThread?.title ?? null,
        onDeleted: () => {
          setChannelSettingsOpen(false);
          navigateToThread('default');
        },
        onRestored: (restoredThreadId) => navigateToThread(restoredThreadId),
      });
      if (error) setChannelSettingsError(error);
    } finally {
      setIsDeletingChannel(false);
    }
  }, [currentThread?.title, isDeletingChannel, isSavingChannel, navigateToThread, threadId]);

  const renderSingleMessage = useCallback(
    (msg: ChatMessageData, index: number) => {
      if (!shouldRenderChatMessage(msg)) return null;

      const prevMsg = index > 0 ? messages[index - 1] : undefined;
      const isGrouped = !!(
        prevMsg &&
        prevMsg.catId &&
        msg.catId &&
        prevMsg.catId === msg.catId &&
        prevMsg.type !== 'system' &&
        msg.type !== 'system' &&
        msg.timestamp - prevMsg.timestamp < MESSAGE_GROUP_WINDOW_MS
      );
      const baseThreadReplyInfo = inlineThreadReplies[msg.id] ?? msg.extra?.slockThread;
      const threadReplyInfo: ThreadReplyInfo | undefined = baseThreadReplyInfo
        ? {
            ...baseThreadReplyInfo,
            newCount: threadStates[baseThreadReplyInfo.branchThreadId]?.unreadCount ?? 0,
          }
        : undefined;
      const showUnreadDivider = unreadDividerIndex === index;

      return (
        <Fragment key={msg.id}>
          {showUnreadDivider ? <UnreadDivider /> : null}
          <MessageActions
            message={msg}
            onOpenThread={handleOpenInlineThread}
            threadId={threadId}
            onPinMessage={setPinnedMessage}
            onEditMessage={handleStartEditMessage}
          >
            <ChatMessage
              message={msg}
              getCatById={getCatById}
              isGrouped={isGrouped}
              threadReplyInfo={threadReplyInfo}
              onOpenThread={handleOpenInlineThread}
              onOpenTaskThread={handleOpenTaskThread}
              isEditing={editingMessageId === msg.id}
              editDraft={editingMessageId === msg.id ? editingDraft : ''}
              isSavingEdit={isSavingEdit && editingMessageId === msg.id}
              onChangeEditDraft={setEditingDraft}
              onSaveEdit={handleSaveEditMessage}
              onCancelEdit={handleCancelEditMessage}
              onRetrySend={handleRetryFailedSend}
            />
          </MessageActions>
        </Fragment>
      );
    },
    [
      threadId,
      unreadDividerIndex,
      getCatById,
      messages,
      handleOpenInlineThread,
      handleOpenTaskThread,
      inlineThreadReplies,
      threadStates,
      handleStartEditMessage,
      editingMessageId,
      editingDraft,
      isSavingEdit,
      handleSaveEditMessage,
      handleCancelEditMessage,
      handleRetryFailedSend,
    ],
  );

  const { cancelInvocation, syncRooms, socketConnected } = useSocket(socketCallbacks, threadId);
  const connectionStatus = useConnectionStatus(socketConnected);

  // Single-slot execution can be recovered from queue truth even when the
  // active-thread flat intentMode has not been restored yet (for example after
  // queue hydration or a missed intent_mode event). In that case we still need
  // the top cancel affordance — otherwise the thread looks active in the
  // execution bar but offers no single-cat cancel control.

  useVoiceAutoPlay();
  useVoiceStream();
  useVadInterrupt();

  useSplitPaneKeys();
  const splitPaneThreadIds = useChatStore((s) => s.splitPaneThreadIds);
  const setSplitPaneThreadIds = useChatStore((s) => s.setSplitPaneThreadIds);
  const setSplitPaneTarget = useChatStore((s) => s.setSplitPaneTarget);

  useEffect(() => {
    if (viewMode === 'split' && splitPaneThreadIds.length === 0 && threadId !== 'default') {
      setSplitPaneThreadIds([threadId]);
      setSplitPaneTarget(threadId);
    }
  }, [viewMode, splitPaneThreadIds.length, threadId, setSplitPaneThreadIds, setSplitPaneTarget]);

  useEffect(() => {
    if (viewMode === 'split' && splitPaneThreadIds.length > 0) {
      // Join rooms for all threads in panes + the current active thread
      const allIds = new Set([...splitPaneThreadIds, threadId]);
      syncRooms([...allIds]);
    }
  }, [viewMode, splitPaneThreadIds, threadId, syncRooms]);

  useEffect(() => {
    clearUnread(threadId);
  }, [threadId, clearUnread]);

  useEffect(() => {
    const syncSavedMessagesView = () => setSavedMessagesViewOpenState(isSavedMessagesViewOpen());
    syncSavedMessagesView();
    window.addEventListener(SAVED_MESSAGES_VIEW_EVENT, syncSavedMessagesView);
    window.addEventListener('popstate', syncSavedMessagesView);
    return () => {
      window.removeEventListener(SAVED_MESSAGES_VIEW_EVENT, syncSavedMessagesView);
      window.removeEventListener('popstate', syncSavedMessagesView);
    };
  }, []);

  useEffect(() => {
    // 切换频道后 Saved 是独立视图，必须自动关闭，避免误以为还在原频道。
    setSavedMessagesViewOpen(false);
  }, [threadId]);

  useEffect(() => {
    if (messages.length === 0) return;
    const messageId = consumeUrlMessageHighlight() ?? consumeSavedMessageScrollTarget(threadId);
    if (!messageId) return;
    window.setTimeout(() => scrollToMessage(messageId), 80);
  }, [messages.length, threadId]);

  const disconnectBottomChromeObserver = useCallback(() => {
    bottomChromeObserverRef.current?.disconnect();
    bottomChromeObserverRef.current = null;
    if (bottomChromeObserverRafRef.current !== null) {
      cancelAnimationFrame(bottomChromeObserverRafRef.current);
      bottomChromeObserverRafRef.current = null;
    }
  }, []);

  const attachBottomChromeRef = useCallback(
    (node: HTMLDivElement | null) => {
      bottomChromeRef.current = node;
      disconnectBottomChromeObserver();

      if (typeof window === 'undefined' || typeof window.ResizeObserver !== 'function' || !node) return;

      let lastHeight = node.getBoundingClientRect().height;
      const observer = new window.ResizeObserver(([entry]) => {
        const nextHeight = entry?.contentRect.height ?? node.getBoundingClientRect().height;
        if (Math.abs(nextHeight - lastHeight) <= 1) return;
        lastHeight = nextHeight;

        if (bottomChromeObserverRafRef.current !== null) {
          cancelAnimationFrame(bottomChromeObserverRafRef.current);
        }
        bottomChromeObserverRafRef.current = requestAnimationFrame(() => {
          bottomChromeObserverRafRef.current = null;
          window.dispatchEvent(new Event('catcafe:chat-layout-changed'));
        });
      });

      observer.observe(node);
      bottomChromeObserverRef.current = observer;
    },
    [disconnectBottomChromeObserver],
  );

  useEffect(() => {
    return disconnectBottomChromeObserver;
  }, [disconnectBottomChromeObserver]);

  const _messageCount = messages.length;
  // F069/#374: 主频道与 Inline Thread 共享同一套 visible+focused 服务端 read ack。
  useVisibleThreadReadAck(threadId, _messageCount);

  const handleStop = useCallback(
    (overrideThreadId?: unknown) => {
      const targetThreadId = typeof overrideThreadId === 'string' ? overrideThreadId : threadId;
      stopHandler(cancelInvocation, targetThreadId);
    },
    [stopHandler, cancelInvocation, threadId],
  );

  const handleZoomToThread = useCallback(
    (tid: string) => {
      setViewMode('single');
      navigateToThread(tid);
    },
    [setViewMode, navigateToThread],
  );

  const handleQuestCreated = useCallback(
    async (questThreadId: string) => {
      setShowQuestWizard(false);
      try {
        const res = await apiFetch('/api/threads');
        if (res.ok) {
          const data = (await res.json()) as { threads: Thread[] };
          setThreads(data.threads);
        }
      } catch {
        // Ignore refresh errors — navigation is the priority
      }
      navigateToThread(questThreadId);
    },
    [navigateToThread, setThreads],
  );

  const handleSearchKnowledge = useCallback(() => {
    const fromParam = threadId ? `?from=${encodeURIComponent(threadId)}` : '';
    router.push(`/memory/search${fromParam}`);
  }, [threadId, router]);

  const handleGoToMemoryHub = useCallback(() => {
    const fromParam = threadId ? `?from=${encodeURIComponent(threadId)}` : '';
    router.push(`/memory${fromParam}`);
  }, [threadId, router]);

  if (viewMode === 'split') {
    return (
      <>
        <SplitPaneView
          onSend={handleSend}
          onStop={handleStop}
          uploadStatus={uploadStatus}
          uploadError={uploadError}
          onZoomToThread={handleZoomToThread}
        />
        <StandaloneMemberEditor />
        <StandaloneCoCreatorEditor />
      </>
    );
  }

  // Export mode: print-friendly layout — no sidebars, no scroll containers.
  // data-export-ready signals to Puppeteer that messages + cat data are fully loaded and rendered.
  if (isExport) {
    const exportReady = !isLoadingHistory && messages.length > 0 && !isLoading;
    return (
      <div className="min-h-screen bg-cafe-surface" {...(exportReady ? { 'data-export-ready': 'true' } : {})}>
        <div className="max-w-4xl mx-auto p-4">{messages.map(renderSingleMessage)}</div>
      </div>
    );
  }

  return (
    <TaskThreadActionsContext.Provider value={taskThreadActions}>
      <div ref={containerRef} className="flex h-full">
        {/* Mobile-only sidebar overlay — desktop sidebar is in AppShell */}
        {sidebarOpen && (
          <div className="md:hidden">
            <div
              className="fixed inset-0 bg-[var(--console-overlay-backdrop)] z-20"
              onClick={() => setSidebarOpen(false)}
              aria-hidden="true"
            />
            <div className="fixed inset-y-0 left-0 z-30 flex-shrink-0" style={{ width: sidebarWidth }}>
              <ThreadSidebar onClose={() => setSidebarOpen(false)} className="w-full" />
            </div>
          </div>
        )}

        <div
          className="flex flex-col min-w-0"
          style={
            statusPanelOpen && rightPanelMode === 'workspace'
              ? { flexBasis: `${chatBasis}%`, flexGrow: 0, flexShrink: 0 }
              : { flex: '1 1 0%' }
          }
        >
          <ChatContainerHeader
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            threadId={threadId}
            authPendingCount={authPending.length}
            viewMode={viewMode}
            onToggleViewMode={() => setViewMode(viewMode === 'single' ? 'split' : 'single')}
            onOpenMobileStatus={() => setMobileStatusOpen(true)}
            statusPanelOpen={statusPanelOpen}
            onToggleStatusPanel={() => setStatusPanelOpen((v) => !v)}
            onOpenChannelSettings={() => {
              setChannelSettingsError(null);
              setChannelSettingsOpen(true);
            }}
            onOpenKnowledgeCapture={() => setKnowledgeCaptureOpen(true)}
          />

          <ChannelTabs activeTab={activeTab} onTabChange={setActiveTab} />

          {pinnedMessage && (
            <div className="flex h-9 flex-shrink-0 items-center gap-2 border-b border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] px-4 text-xs text-[var(--cafe-text)]">
              <span aria-hidden="true">📌</span>
              <span className="font-semibold text-[var(--cafe-text-secondary)]">Pinned message</span>
              <span className="min-w-0 flex-1 truncate">{formatPinnedMessagePreview(pinnedMessage)}</span>
              <button
                type="button"
                onClick={() => setPinnedMessage(null)}
                className="rounded px-1.5 py-0.5 text-[var(--cafe-text-muted)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)]"
                aria-label="关闭置顶消息横幅"
              >
                ×
              </button>
            </div>
          )}

          {savedMessagesViewOpen ? (
            <div className="flex-1 overflow-hidden">
              <SavedMessagesPanel currentThreadId={threadId} />
            </div>
          ) : activeTab === 'chat' ? (
            <div className="flex-1 relative overflow-hidden">
              <main
                ref={scrollContainerRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto p-4"
                data-guide-id="bootcamp.preview-result"
                data-bootcamp-host="chat-messages"
                data-chat-container
              >
                {isLoadingHistory && <div className="text-center py-3 text-sm text-cafe-muted">加载历史消息...</div>}
                <ConnectionStatusBar
                  api={connectionStatus.api}
                  socket={connectionStatus.socket}
                  upstream={connectionStatus.upstream}
                  isReadonly={connectionStatus.isReadonly}
                  checkedAt={connectionStatus.checkedAt}
                  isOfflineSnapshot={isOfflineSnapshot}
                />
                {showAgentHookNotice && (
                  <div className="mb-3 flex justify-center text-left">
                    <div className="max-w-[85%] w-full">
                      <AgentHookHealthNotice
                        health={agentHookHealth.health}
                        error={agentHookHealth.error}
                        syncing={agentHookHealth.syncing}
                        synced={agentHookHealth.synced}
                        onSync={agentHookHealth.sync}
                      />
                    </div>
                  </div>
                )}
                {!hasMore && messages.length > 0 && (
                  <div className="text-center py-3 text-xs text-cafe-muted">没有更多消息了</div>
                )}
                {messages.length === 0 && !isLoadingHistory ? (
                  <div className="text-center mt-20">
                    <PawIcon className="w-12 h-12 text-cocreator-light mx-auto mb-4" />
                    <p className="text-lg text-cafe-secondary mb-1">欢迎来到 Clowder AI!</p>
                    <p className="text-sm text-cafe-muted">
                      {cats.length > 0 ? emptyThreadMentionHint(cats) : '还没有可用成员，先开始新手教程创建第一只猫猫'}
                    </p>
                    {showSetupCard && govStatus && (
                      <div className="mt-6 text-left">
                        <ProjectSetupCard
                          key={threadId}
                          projectPath={currentProjectPath}
                          isEmptyDir={govStatus.isEmptyDir}
                          isGitRepo={govStatus.isGitRepo}
                          gitAvailable={govStatus.gitAvailable}
                          agentHookHealth={agentHookHealth.health}
                          agentHookHealthError={agentHookHealth.error}
                          agentHookSyncing={agentHookHealth.syncing}
                          agentHookSynced={agentHookHealth.synced}
                          onSyncAgentHooks={agentHookHealth.sync}
                          onComplete={() => {
                            setSetupDone(true);
                            govRefetch();
                          }}
                        />
                      </div>
                    )}
                    {/* F152 Phase B: memory bootstrap orchestrator */}
                    {!showSetupCard &&
                      currentProjectPath &&
                      currentProjectPath !== 'default' &&
                      currentProjectPath !== 'lobby' && (
                        <div className="mt-4 text-left">
                          <BootstrapOrchestrator
                            projectPath={currentProjectPath}
                            indexState={indexState}
                            isSnoozed={isSnoozed}
                            progress={bootstrapProgress}
                            summary={bootstrapSummary}
                            durationMs={bootstrapDurationMs}
                            isNewProject={setupDone}
                            governanceDone={
                              setupDone || !!(govStatus && !govStatus.needsBootstrap && !govStatus.needsConfirmation)
                            }
                            onStartBootstrap={startBootstrap}
                            onSnooze={snoozeBootstrap}
                            onSearchKnowledge={handleSearchKnowledge}
                            onGoToMemoryHub={handleGoToMemoryHub}
                          />
                        </div>
                      )}
                    {(() => {
                      const isCurrentBootcamp = storeThreads.find((t) => t.id === threadId)?.bootcampState;
                      if (isCurrentBootcamp) return null; // already in bootcamp thread
                      if (bootcampCount > 0) {
                        return (
                          <button
                            type="button"
                            onClick={() => setShowBootcampList(true)}
                            className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text hover:bg-conn-amber-bg transition-colors text-sm font-medium"
                            data-testid="empty-state-bootcamp-list"
                          >
                            <BootcampIcon className="w-4 h-4" />
                            我的训练营（{bootcampCount}）
                          </button>
                        );
                      }
                      return (
                        <button
                          type="button"
                          onClick={() => setShowBootcampList(true)}
                          className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text hover:bg-conn-amber-bg transition-colors text-sm font-medium"
                          data-testid="empty-state-bootcamp"
                        >
                          <BootcampIcon className="w-4 h-4" />
                          第一次来？开始猫猫训练营
                        </button>
                      );
                    })()}
                  </div>
                ) : (
                  messages.map(renderSingleMessage)
                )}
                <div ref={messagesEndRef} />
              </main>
              <ScrollToBottomButton
                scrollContainerRef={scrollContainerRef}
                messagesEndRef={messagesEndRef}
                recomputeSignal={computeScrollRecomputeSignal(threadId, messages, uiThinkingExpandedByDefault ? 1 : 0)}
                observerKey={threadId}
              />
            </div>
          ) : activeTab === 'tasks' ? (
            <div className="flex-1 overflow-hidden">
              <TasksPanel threadId={threadId} onOpenTaskThread={handleOpenTaskThread} />
            </div>
          ) : (
            <div className="flex-1 overflow-hidden">
              <FilesPanel messages={messages} getCatById={getCatById} />
            </div>
          )}

          <div
            ref={attachBottomChromeRef}
            className={`sticky bottom-0 z-20 bg-[var(--console-shell-bg)] ${
              activeTab === 'chat' && !savedMessagesViewOpen ? '' : 'hidden'
            }`}
          >
            {authPending.length > 0 && (
              <div className="border-t border-conn-amber-ring bg-conn-amber-bg/40 py-2">
                {authPending.map((req) => (
                  <AuthorizationCard key={req.requestId} request={req} onRespond={authRespond} />
                ))}
              </div>
            )}

            <AgentStatusIndicator
              threadId={threadId}
              activeInvocations={activeInvocations}
              catStatuses={catStatuses}
              catInvocations={catInvocations}
              getCatById={getCatById}
            />
            <QueuePanel threadId={threadId} />
            <FreshnessHoldBar threadId={threadId} />
            <VoteActiveBar threadId={threadId} onEnd={() => {}} />

            {!showFirstRunQuestPrompt &&
              !showQuestWizard &&
              (() => {
                const currentThread = storeThreads.find((t) => t.id === threadId);
                const questState = (currentThread as Record<string, unknown> | undefined)?.firstRunQuestState as
                  | { phase: string; firstCatName?: string }
                  | undefined;
                if (!questState) return null;
                return (
                  <QuestBanner
                    phase={questState.phase}
                    firstCatName={questState.firstCatName}
                    onAddSecondCat={() => setShowQuestWizard(true)}
                    onStartBootcamp={() => setShowBootcampList(true)}
                    onComplete={() => router.push('/settings')}
                  />
                );
              })()}

            {isResearchMode && (
              <div className="mx-4 mb-2 rounded-lg border border-conn-emerald-ring bg-conn-emerald-bg px-3 py-2 text-xs text-conn-emerald-text">
                多猫研究模式 — 文章上下文已注入。请输入研究问题，猫猫会自动调用 multi_mention 邀请其他猫参与分析。
              </div>
            )}
            <div
              className={(() => {
                if (showFirstRunQuestPrompt || showQuestWizard) return '';
                const ct = storeThreads.find((t) => t.id === threadId);
                // Bootcamp phase-1 with no messages: highlight + punch through overlay
                const bs = ct?.bootcampState as { phase: string } | undefined;
                if (bs?.phase === 'phase-1-intro' && messages.length === 0) {
                  return 'relative z-[70] quest-input-highlight rounded-xl mx-1';
                }
                // Legacy quest support
                const qs = (ct as Record<string, unknown> | undefined)?.firstRunQuestState as
                  | { phase: string }
                  | undefined;
                return qs?.phase === 'quest-2-cat-intro' ? 'quest-input-highlight rounded-xl mx-1' : '';
              })()}
            >
              <ChatInput
                key={threadId}
                threadId={threadId}
                onSend={(content, images, attachments, whisper, deliveryMode) =>
                  handleSend(content, images, undefined, whisper, deliveryMode, attachments)
                }
                onStop={handleStop}
                disabled={connectionStatus.isReadonly}
                hasActiveInvocation={hasActiveInvocation}
                uploadStatus={uploadStatus}
                uploadError={uploadError}
              />
            </div>

            {/* F101: "Return to game" banner when overlay is minimized */}
            {isGameActive && overlayMinimized && gameView?.threadId === threadId && (
              <button
                onClick={() => useGameStore.getState().restoreOverlay()}
                className="mx-4 mb-2 flex items-center justify-center gap-2 rounded-lg bg-[var(--console-active-bg)] px-3 py-2 text-sm text-cafe hover:bg-[var(--console-hover-bg)] transition-colors"
              >
                🎮 返回游戏
              </button>
            )}
          </div>

          {/* F101: Game overlay — renders when a game is active */}
          <GameOverlayConnector
            gameView={gameView}
            isGameActive={isGameActive}
            overlayMinimized={overlayMinimized}
            currentThreadId={threadId}
            isNight={isNight}
            selectedTarget={selectedTarget}
            godScopeFilter={godScopeFilter}
            isGodView={isGodView}
            isDetective={isDetective}
            detectiveBoundName={detectiveBoundName ?? undefined}
            godSeats={godSeats}
            godNightSteps={godNightSteps}
            hasTargetedAction={hasTargetedAction}
            myRole={myRole ?? undefined}
            myRoleIcon={myRoleIcon ?? undefined}
            myActionLabel={myActionLabel ?? undefined}
            myActionHint={myActionHint ?? undefined}
            altActionName={altActionName ?? undefined}
            onClose={() => {
              useGameStore.getState().minimizeOverlay();
            }}
            onSelectTarget={(seatId) => useGameStore.getState().setSelectedTarget(seatId)}
            onGodScopeChange={(scope) => useGameStore.getState().setGodScopeFilter(scope)}
            onGodAction={(action) => godAction(threadId, action)}
            onVote={() => {
              const state = useGameStore.getState();
              if (state.selectedTarget && state.mySeatId) {
                submitAction(threadId, state.mySeatId, 'vote', state.selectedTarget);
                state.setSelectedTarget(null);
              }
            }}
            onSpeak={(content) => {
              const state = useGameStore.getState();
              if (state.mySeatId) {
                submitAction(threadId, state.mySeatId, 'speak', undefined, { content });
              }
            }}
            onConfirmAction={() => {
              const state = useGameStore.getState();
              if (state.selectedTarget && state.mySeatId && state.currentActionName) {
                submitAction(threadId, state.mySeatId, state.currentActionName, state.selectedTarget);
                state.setSelectedTarget(null);
              }
            }}
            onConfirmAltAction={() => {
              const state = useGameStore.getState();
              if (state.selectedTarget && state.mySeatId && state.altActionName) {
                submitAction(threadId, state.mySeatId, state.altActionName, state.selectedTarget);
                state.setSelectedTarget(null);
              }
            }}
          />
        </div>

        {statusPanelOpen && rightPanelMode === 'status' && (
          <>
            <div className="hidden lg:flex">
              <ResizeHandle
                direction="horizontal"
                onResize={handleStatusPanelResize}
                onDoubleClick={resetStatusPanelWidth}
              />
            </div>
            <RightStatusPanel
              intentMode={intentMode}
              targetCats={targetCats}
              catStatuses={catStatuses}
              catInvocations={catInvocations}
              activeInvocations={activeInvocations}
              hasActiveInvocation={hasActiveInvocation}
              threadId={threadId}
              messageSummary={messageSummary}
              width={statusPanelWidth}
            />
          </>
        )}
        {statusPanelOpen && rightPanelMode === 'workspace' && (
          <>
            <ResizeHandle direction="horizontal" onResize={handleHorizontalResize} onDoubleClick={resetChatBasis} />
            <WorkspacePanel />
          </>
        )}
        {inlineThread && (
          <InlineThreadPanel
            threadId={inlineThread.threadId}
            parentThreadId={inlineThread.parentThreadId}
            sourceMessage={inlineThread.sourceMessage}
            task={inlineThread.task}
            parentThreadTitle={currentThreadTitle}
            isClosing={inlineThreadClosing}
            onClose={closeInlineThread}
            onReplyCountChange={handleInlineThreadReplyCountChange}
          />
        )}
        <MobileStatusSheet
          open={mobileStatusOpen}
          onClose={() => setMobileStatusOpen(false)}
          intentMode={intentMode}
          targetCats={targetCats}
          catStatuses={catStatuses}
          catInvocations={catInvocations}
          activeInvocations={activeInvocations}
          hasActiveInvocation={hasActiveInvocation}
          threadId={threadId}
          messageSummary={messageSummary}
        />
        {showFirstRunQuestPrompt && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4">
            <div
              className="w-full max-w-md rounded-2xl bg-[var(--console-card-bg)] p-6 shadow-[var(--console-shadow)]"
              onClick={(event) => event.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-cafe">开始猫猫新手教程？</h3>
              <p className="mt-2 text-sm text-cafe-secondary">
                当前还没有可用成员。我们可以先带你创建第一只猫猫，再开始首个协作任务。
              </p>
              <div className="mt-5 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={handleSkipFirstRunQuest}
                  className="rounded-lg bg-[var(--console-card-soft-bg)] px-3 py-2 text-sm text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
                >
                  跳过
                </button>
                <button
                  type="button"
                  onClick={handleStartFirstRunQuest}
                  className="console-button-primary rounded-lg px-3 py-2 text-sm font-medium"
                >
                  开始教程
                </button>
              </div>
            </div>
          </div>
        )}
        <StandaloneMemberEditor />
        <StandaloneCoCreatorEditor />
        <FirstRunQuestWizard
          open={showQuestWizard}
          onClose={() => setShowQuestWizard(false)}
          onCreated={handleQuestCreated}
        />
        <BootcampListModal open={showBootcampList} onClose={handleBootcampModalClose} currentThreadId={threadId} />
        {showVoteModal && <VoteConfigModal onSubmit={handleVoteSubmit} onCancel={() => setShowVoteModal(false)} />}
        <EditChannelModal
          open={channelSettingsOpen}
          title={currentThreadTitle}
          availableCats={cats}
          selectedCatIds={currentThreadMemberIds}
          routingPolicy={currentThread?.routingPolicy}
          isDefaultThread={threadId === 'default'}
          isSaving={isSavingChannel}
          isDeleting={isDeletingChannel}
          error={channelSettingsError}
          onClose={() => {
            if (isSavingChannel || isDeletingChannel) return;
            setChannelSettingsOpen(false);
          }}
          onSave={handleSaveChannelSettings}
          onDelete={handleDeleteChannel}
        />
        <KnowledgeCaptureModal
          open={knowledgeCaptureOpen}
          sourceThreadId={threadId}
          defaultTitle={currentThreadTitle}
          onClose={() => setKnowledgeCaptureOpen(false)}
          onCreated={handleKnowledgeCreated}
        />
        {/* Bootcamp guide overlay: intro phase tips + lifecycle tips (phase-7.5 uses guide engine) */}
        {(() => {
          if (showFirstRunQuestPrompt || showQuestWizard) return null;
          const bt = storeThreads.find((t) => t.id === threadId);
          const raw = bt?.bootcampState;
          if (!raw) return null;
          const phase = raw.phase;
          // Guide engine handles phase-7.5 and phase-10 — no custom overlay needed
          if (phase === 'phase-7.5-add-teammate' || phase === 'phase-10-retro') return null;
          const isLifecyclePhase = /^phase-(5|6|7|8|9|10|11)-/.test(phase);
          if (!isLifecyclePhase && messages.length > 0) return null;
          const leadCat = cats.find((c) => c.id === raw.leadCat) ?? cats[0];
          const catName = leadCat?.displayName ?? leadCat?.nickname ?? leadCat?.name;
          if (!catName) return null;
          return <BootcampGuideOverlay phase={phase} catName={catName} hasMessages={messages.length > 0} />;
        })()}
      </div>
    </TaskThreadActionsContext.Provider>
  );
}

function StandaloneMemberEditor() {
  const targetCatId = useChatStore((s) => s.memberEditorTarget);
  const closeMemberEditor = useChatStore((s) => s.closeMemberEditor);
  const { cats, refresh } = useCatData();
  const cat = targetCatId ? (cats.find((c) => c.id === targetCatId) ?? null) : null;
  const handleSaved = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return (
    <HubCatEditor
      open={Boolean(targetCatId) && Boolean(cat)}
      cat={cat}
      draft={null}
      existingCats={cats}
      onClose={closeMemberEditor}
      onSaved={handleSaved}
      hideDelete
    />
  );
}

function StandaloneCoCreatorEditor() {
  const open = useChatStore((s) => s.coCreatorEditorOpen);
  const close = useChatStore((s) => s.closeCoCreatorEditor);
  const coCreator = useCoCreatorConfig();
  const handleSaved = useCallback(async () => {
    const res = await apiFetch('/api/config');
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { config?: { coCreator?: CoCreatorConfig } };
      if (body.config?.coCreator) primeCoCreatorConfigCache(body.config.coCreator);
    }
  }, []);

  return <HubCoCreatorEditor open={open} coCreator={coCreator} onClose={close} onSaved={handleSaved} />;
}
