'use client';

import type { TaskEvidence, TaskItem, TaskStatus } from '@cat-cafe/shared';
import {
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { useCatData } from '@/hooks/useCatData';
import { isCommandInvocation } from '@/hooks/useChatCommands';
import { usePersistedState } from '@/hooks/usePersistedState';
import { useVisibleThreadReadAck } from '@/hooks/useVisibleThreadReadAck';
import type { CatStatusType } from '@/stores/chat-types';
import { type ChatMessage as ChatMessageData, useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { compressImage } from '@/utils/compressImage';
import { RESET_CONTEXT_CONFIRMATION, resetThreadContext } from '@/utils/reset-thread-context';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { getUserId } from '@/utils/userId';
import { ChatMessage, shouldRenderChatMessage } from './ChatMessage';
import { buildCatOptions, type CatOption, detectMenuTrigger } from './chat-input-options';
import { ImagePreview } from './ImagePreview';
import { MentionPicker } from './MentionPicker';
import { type SlashCommandItem, SlashCommandPicker } from './SlashCommandPicker';
import { CHAT_THREAD_ROUTE_EVENT, getThreadHref } from './ThreadSidebar/thread-navigation';
import { ResizeHandle } from './workspace/ResizeHandle';

const THREAD_PANEL_DEFAULT_WIDTH = 520;
const THREAD_PANEL_MIN_WIDTH = 420;
const THREAD_PANEL_FALLBACK_MAX_WIDTH = 720;
const THREAD_PANEL_MAX_VIEWPORT_RATIO = 0.66;
const MAX_THREAD_IMAGES = 5;
const MAX_THREAD_IMAGE_BYTES = 10 * 1024 * 1024;
const THREAD_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  in_review: '待验收',
  blocked: '阻塞',
  done: '已完成',
  failed: '失败',
};

const TASK_STATUS_TONE: Record<TaskStatus, string> = {
  todo: 'border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] text-[var(--cafe-text-muted)]',
  doing: 'border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text',
  in_review: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  blocked: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  done: 'border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text',
  failed: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
};

const TASK_EVIDENCE_KEYS: ReadonlyArray<keyof Omit<TaskEvidence, 'updatedAt'>> = [
  'tests',
  'build',
  'screenshot',
  'review',
  'lesson',
];

const THREAD_STATUS_LABELS: Record<CatStatusType, string> = {
  spawning: '启动中',
  pending: '排队中',
  streaming: '回复中',
  done: '已完成',
  error: '异常',
  alive_but_silent: '静默等待',
  suspected_stall: '疑似卡住',
};

const THREAD_STATUS_TONE: Record<CatStatusType, string> = {
  spawning: 'text-[var(--cafe-accent)]',
  pending: 'text-cafe-secondary',
  streaming: 'text-conn-emerald-text',
  done: 'text-conn-emerald-text',
  error: 'text-conn-red-text',
  alive_but_silent: 'text-conn-amber-text',
  suspected_stall: 'text-conn-amber-text',
};

type InlineThreadApiMessage = ChatMessageData & { isDraft?: boolean };
type InlineThreadActiveInvocation = { catId: string; mode?: string; startedAt?: number };
export type InlineThreadSearchHit = { id: string; index: number };
type InlineThreadSendKeyEvent = Pick<KeyboardEvent<HTMLTextAreaElement>, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey'>;
type ReplyCountUpdateOptions = {
  authoritative?: boolean;
  latestReply?: { id: string; catId: string | null; content: string; timestamp: number };
};
type ViewInChannelWindow = {
  location: { pathname: string };
  history: { pushState: (data: unknown, unused: string, url?: string | URL | null) => void };
  dispatchEvent: (event: Event) => boolean;
};

export function createInlineThreadImageFormData({
  content,
  threadId,
  userId,
  replyTo,
  images,
}: {
  content: string;
  threadId: string;
  userId: string;
  replyTo?: string;
  images: File[];
}): FormData {
  const formData = new FormData();
  formData.append('content', content);
  formData.append('threadId', threadId);
  formData.append('userId', userId);
  if (replyTo) formData.append('replyTo', replyTo);
  for (const image of images) formData.append('images', image);
  return formData;
}

export function getViewInChannelHref(parentThreadId: string, sourceMessageId: string): string {
  return `${getThreadHref(parentThreadId)}?highlight=${encodeURIComponent(sourceMessageId)}`;
}

export function navigateViewInChannel(
  parentThreadId: string,
  sourceMessageId: string,
  windowObj: ViewInChannelWindow | undefined,
  scrollToSource: (messageId: string) => void = scrollToMessage,
): string {
  const href = getViewInChannelHref(parentThreadId, sourceMessageId);
  if (!windowObj) return href;

  const parentHref = getThreadHref(parentThreadId);
  if (windowObj.location.pathname === parentHref) {
    scrollToSource(sourceMessageId);
    return href;
  }

  windowObj.history.pushState({}, '', href);
  windowObj.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
  return href;
}

export function shouldShowInlineThreadRuntimeStatus(status: CatStatusType): boolean {
  return status !== 'done' && status !== 'alive_but_silent';
}

export function shouldSendInlineThreadMessage(event: InlineThreadSendKeyEvent): boolean {
  if (event.key !== 'Enter') return false;
  if (event.shiftKey) return false;
  return true;
}

export function getInlineThreadPanelShellClassName(): string {
  return 'thread-panel-motion fixed inset-0 z-[60] flex h-[100dvh] min-h-0 bg-[var(--console-overlay-medium)] lg:relative lg:inset-auto lg:z-auto lg:h-full lg:flex-shrink-0 lg:bg-transparent';
}

function findInlineThreadSourceCopyIndex(messages: readonly ChatMessageData[], sourceMessage: ChatMessageData): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (
      message?.timestamp === sourceMessage.timestamp &&
      message.content === sourceMessage.content &&
      message.catId === sourceMessage.catId &&
      message.type === sourceMessage.type
    ) {
      return index;
    }
  }
  return -1;
}

export function getInlineThreadReplyMessages(
  messages: readonly ChatMessageData[],
  sourceMessage: ChatMessageData,
): ChatMessageData[] {
  const sourceIndex = findInlineThreadSourceCopyIndex(messages, sourceMessage);

  return sourceIndex >= 0
    ? messages.slice(sourceIndex + 1)
    : messages.filter((message) => message.timestamp > sourceMessage.timestamp);
}

export function getInlineThreadSourceMessageId(
  messages: readonly ChatMessageData[],
  sourceMessage: ChatMessageData,
): string | undefined {
  const sourceIndex = findInlineThreadSourceCopyIndex(messages, sourceMessage);
  return sourceIndex >= 0 ? messages[sourceIndex]?.id : undefined;
}

export function isCountableInlineThreadReply(message: ChatMessageData): boolean {
  if (!shouldRenderChatMessage(message)) return false;
  if (message.origin === 'progress' || message.type === 'system') return false;
  if (message.source?.connector === 'task-system') return false;
  return true;
}

function getThreadPanelMaxWidth() {
  if (typeof window === 'undefined') return THREAD_PANEL_FALLBACK_MAX_WIDTH;
  return Math.max(THREAD_PANEL_MIN_WIDTH, Math.floor(window.innerWidth * THREAD_PANEL_MAX_VIEWPORT_RATIO));
}

function clampThreadPanelWidth(width: number) {
  return Math.min(getThreadPanelMaxWidth(), Math.max(THREAD_PANEL_MIN_WIDTH, width));
}

export function normalizeInlineThreadMessage(message: InlineThreadApiMessage): ChatMessageData {
  if (!message.isDraft) return message;

  const normalized: InlineThreadApiMessage = {
    ...message,
    isStreaming: true,
  };
  delete normalized.isDraft;
  return normalized;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function getInlineThreadSearchHits(messages: ChatMessageData[], query: string): InlineThreadSearchHit[] {
  const needle = normalizeSearchText(query);
  if (!needle) return [];

  return messages.reduce<InlineThreadSearchHit[]>((hits, message, index) => {
    const haystack = normalizeSearchText([message.content, message.thinking].filter(Boolean).join('\n'));
    if (haystack.includes(needle)) hits.push({ id: message.id, index });
    return hits;
  }, []);
}

export function getNextInlineThreadSearchIndex(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + direction + total) % total;
}

export function isUnsafeInlineThreadTarget(
  threadId: string,
  sourceMessage: Pick<ChatMessageData, 'threadId'>,
): boolean {
  return !!sourceMessage.threadId && sourceMessage.threadId === threadId;
}

function countTaskEvidence(evidence?: TaskEvidence): number {
  if (!evidence) return 0;
  return TASK_EVIDENCE_KEYS.filter((key) => Boolean(evidence[key]?.trim())).length;
}

function getTaskNextStep(status: TaskStatus): string {
  switch (status) {
    case 'todo':
      return '认领任务并开始执行';
    case 'doing':
      return '继续执行并补齐交付证据';
    case 'in_review':
      return '等待验收并补齐交付摘要';
    case 'blocked':
      return '说明阻塞原因并请求协助';
    case 'done':
      return '沉淀 lesson 或关闭任务';
    case 'failed':
      return '记录失败原因并决定重试';
    default:
      return '确认下一步动作';
  }
}

function getTaskOwnerLabel(task: TaskItem): string {
  return task.ownerCatId ?? '未分配';
}

export function InlineThreadTaskStatusCard({ task }: { task?: TaskItem }) {
  if (!task) return null;

  const evidenceCount = countTaskEvidence(task.evidence);
  const statusTone = TASK_STATUS_TONE[task.status] ?? TASK_STATUS_TONE.todo;

  return (
    <section
      className="flex flex-shrink-0 flex-col gap-2 border-b border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] px-4 py-3"
      aria-label="任务 Thread 状态"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-[var(--cafe-text-muted)]">任务目标</div>
          <div
            className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug text-[var(--cafe-text)]"
            title={task.title}
          >
            {task.title}
          </div>
        </div>
        <span className={`flex-shrink-0 border px-2 py-0.5 text-[11px] font-semibold ${statusTone}`}>
          {TASK_STATUS_LABELS[task.status] ?? task.status}
        </span>
      </div>
      {task.why.trim() && (
        <p className="line-clamp-2 text-xs leading-relaxed text-[var(--cafe-text-muted)]">{task.why}</p>
      )}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--cafe-text-muted)]">负责人</div>
          <div className="mt-0.5 truncate font-medium text-[var(--cafe-text)]">{getTaskOwnerLabel(task)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--cafe-text-muted)]">交付证据</div>
          <div className="mt-0.5 font-medium text-[var(--cafe-text)]">交付证据 {evidenceCount}/5</div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--cafe-text-muted)]">下一步</div>
          <div className="mt-0.5 truncate font-medium text-[var(--cafe-text)]" title={getTaskNextStep(task.status)}>
            {getTaskNextStep(task.status)}
          </div>
        </div>
      </div>
    </section>
  );
}

function detectSlashCommand(value: string, cursor: number): string | null {
  if (!value.startsWith('/') || cursor <= 0) return null;
  const token = value.match(/^\/[^\s]*/)?.[0] ?? '';
  if (cursor > token.length) return null;
  return value.slice(1, cursor);
}

interface InlineThreadPanelProps {
  threadId: string;
  parentThreadId: string;
  sourceMessage: ChatMessageData;
  task?: TaskItem;
  parentThreadTitle: string;
  isClosing?: boolean;
  onClose: () => void;
  onReplyCountChange?: (
    sourceMessageId: string,
    branchThreadId: string,
    replyCount: number,
    options?: ReplyCountUpdateOptions,
  ) => void;
}

export function InlineThreadPanel({
  threadId,
  parentThreadId,
  sourceMessage,
  task,
  parentThreadTitle,
  isClosing = false,
  onClose,
  onReplyCountChange,
}: InlineThreadPanelProps) {
  const { cats } = useCatData();
  const threadRuntime = useChatStore((state) => state.threadStates[threadId]);
  const [panelWidth, setPanelWidth, resetPanelWidth] = usePersistedState(
    'cat-cafe:inlineThreadPanelWidth:v2',
    THREAD_PANEL_DEFAULT_WIDTH,
  );
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [isPreparingImages, setIsPreparingImages] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [showMentionPicker, setShowMentionPicker] = useState(false);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [slashItems, setSlashItems] = useState<SlashCommandItem[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearchIndex, setActiveSearchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [queueActiveInvocations, setQueueActiveInvocations] = useState<InlineThreadActiveInvocation[]>([]);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number>(0);
  const pollBaselineCountRef = useRef<number>(0);
  const latestMessagesRef = useRef<ChatMessageData[]>([]);
  const mountedRef = useRef(false);
  const getCatById = useCallback((catId: string) => cats.find((cat) => cat.id === catId), [cats]);
  const runtimeCats = useMemo(() => {
    const storeActiveEntries = Object.values(threadRuntime?.activeInvocations ?? {});
    const activeEntries = [...storeActiveEntries, ...queueActiveInvocations];
    const activeCatIds = activeEntries.map((entry) => entry.catId).filter(Boolean);
    const statusCatIds = Object.entries(threadRuntime?.catStatuses ?? {})
      .filter(([, status]) => shouldShowInlineThreadRuntimeStatus(status))
      .map(([catId]) => catId);
    return Array.from(new Set([...activeCatIds, ...statusCatIds])).map((catId) => {
      const cat = getCatById(catId);
      const status = threadRuntime?.catStatuses?.[catId] ?? (activeCatIds.includes(catId) ? 'streaming' : 'pending');
      const active = activeEntries.find((entry) => entry.catId === catId);
      return {
        catId,
        label: cat?.displayName ?? cat?.name ?? catId,
        model: cat?.defaultModel ?? '',
        provider: cat?.provider ?? cat?.clientId ?? '',
        color: cat?.color.primary ?? 'var(--console-cat-fallback)',
        status,
        startedAt: active?.startedAt,
      };
    });
  }, [getCatById, queueActiveInvocations, threadRuntime?.activeInvocations, threadRuntime?.catStatuses]);
  const stopScrollPropagation = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.stopPropagation();
  }, []);
  const parentThreadLabel = useMemo(() => {
    const title = parentThreadTitle.trim() || '当前对话';
    return title.startsWith('#') ? title : `#${title}`;
  }, [parentThreadTitle]);
  const handleViewInChannel = useCallback(() => {
    navigateViewInChannel(parentThreadId, sourceMessage.id, typeof window !== 'undefined' ? window : undefined);
  }, [parentThreadId, sourceMessage.id]);
  const handlePanelResize = useCallback(
    (delta: number) => {
      setPanelWidth((prev) => clampThreadPanelWidth(prev - delta));
    },
    [setPanelWidth],
  );

  useEffect(() => {
    setPanelWidth((prev) => clampThreadPanelWidth(prev));
  }, [setPanelWidth]);

  const catOptions = useMemo(() => buildCatOptions(cats), [cats]);
  const filteredCatOptions = useMemo(() => {
    if (!mentionFilter) return catOptions;
    const lower = mentionFilter.toLowerCase();
    return catOptions.filter(
      (option) =>
        option.label.toLowerCase().includes(lower) ||
        option.insert.toLowerCase().includes(lower) ||
        option.id.toLowerCase().includes(lower),
    );
  }, [catOptions, mentionFilter]);

  const closeMentionPicker = useCallback(() => {
    setShowMentionPicker(false);
    setMentionStart(-1);
    setMentionFilter('');
  }, []);

  const closeSlashPicker = useCallback(() => {
    setShowSlashCommands(false);
    setSlashQuery('');
    setSlashSelectedIdx(0);
  }, []);

  useEffect(() => {
    latestMessagesRef.current = messages;
  }, [messages]);

  const loadMessages = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (options?.showLoading !== false) setLoading(true);

      try {
        const res = await apiFetch(`/api/messages?threadId=${encodeURIComponent(threadId)}&limit=60`);
        if (!res.ok) return [];
        const data = (await res.json()) as { messages?: ChatMessageData[] };
        const normalized = (data.messages ?? []).map((message) => normalizeInlineThreadMessage(message));
        if (mountedRef.current) {
          latestMessagesRef.current = normalized;
          setMessages(normalized);
        }
        return normalized;
      } catch {
        if (mountedRef.current) {
          latestMessagesRef.current = [];
          setMessages([]);
        }
        return [];
      } finally {
        if (mountedRef.current && options?.showLoading !== false) setLoading(false);
      }
    },
    [threadId],
  );

  const loadQueueRuntime = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/queue`);
      if (!res.ok) {
        if (mountedRef.current) setQueueActiveInvocations([]);
        return [];
      }
      const data = (await res.json()) as { activeInvocations?: InlineThreadActiveInvocation[] };
      const activeInvocations = Array.isArray(data.activeInvocations) ? data.activeInvocations : [];
      if (mountedRef.current) setQueueActiveInvocations(activeInvocations);
      return activeInvocations;
    } catch {
      if (mountedRef.current) setQueueActiveInvocations([]);
      return [];
    }
  }, [threadId]);

  const stopReplyPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollStartedAtRef.current = 0;
    pollBaselineCountRef.current = 0;
  }, []);

  const startReplyPolling = useCallback(() => {
    stopReplyPolling();
    pollStartedAtRef.current = Date.now();
    pollBaselineCountRef.current = latestMessagesRef.current.length;

    pollTimerRef.current = setInterval(() => {
      void Promise.all([loadMessages({ showLoading: false }), loadQueueRuntime()]).then(([nextMessages, active]) => {
        const hasNewCompleteMessage =
          nextMessages.length > pollBaselineCountRef.current && !nextMessages.some((message) => message.isStreaming);
        const elapsed = Date.now() - pollStartedAtRef.current;
        const runtimeStillActive = active.length > 0;
        const timedOutWithoutRuntime = elapsed >= 60_000 && !runtimeStillActive;
        const hardTimedOut = elapsed >= 5 * 60_000;
        if ((hasNewCompleteMessage && !runtimeStillActive) || timedOutWithoutRuntime || hardTimedOut)
          stopReplyPolling();
      });
    }, 2000);
  }, [loadMessages, loadQueueRuntime, stopReplyPolling]);

  useEffect(() => {
    mountedRef.current = true;
    void loadMessages();
    void loadQueueRuntime();
    return () => {
      mountedRef.current = false;
    };
  }, [loadMessages, loadQueueRuntime]);

  useEffect(() => () => stopReplyPolling(), [stopReplyPolling]);

  useEffect(() => {
    if (runtimeCats.length === 0) return undefined;
    const timer = setInterval(() => {
      void Promise.all([loadMessages({ showLoading: false }), loadQueueRuntime()]);
    }, 2000);
    return () => clearInterval(timer);
  }, [loadMessages, loadQueueRuntime, runtimeCats.length]);

  const replyMessages = useMemo(() => getInlineThreadReplyMessages(messages, sourceMessage), [messages, sourceMessage]);
  const visibleReplyMessages = useMemo(
    () => replyMessages.filter((message) => shouldRenderChatMessage(message)),
    [replyMessages],
  );
  const countableReplyMessages = useMemo(
    () => replyMessages.filter((message) => isCountableInlineThreadReply(message)),
    [replyMessages],
  );
  useVisibleThreadReadAck(threadId, countableReplyMessages.length + 1);

  const searchableMessages = useMemo(
    () => [sourceMessage, ...visibleReplyMessages],
    [sourceMessage, visibleReplyMessages],
  );
  const searchHits = useMemo(
    () => getInlineThreadSearchHits(searchableMessages, searchQuery),
    [searchQuery, searchableMessages],
  );
  const activeSearchHit = searchHits[activeSearchIndex] ?? null;

  useEffect(() => {
    setActiveSearchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (!searchQuery.trim() || activeSearchIndex < searchHits.length) return;
    setActiveSearchIndex(Math.max(0, searchHits.length - 1));
  }, [activeSearchIndex, searchHits.length, searchQuery]);

  useEffect(() => {
    if (!searchOpen || !activeSearchHit) return;
    const raf = requestAnimationFrame(() => {
      const selector = `[data-inline-thread-message-id="${CSS.escape(activeSearchHit.id)}"]`;
      document.querySelector<HTMLElement>(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [activeSearchHit, searchOpen]);

  const openThreadSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  const closeThreadSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setActiveSearchIndex(0);
  }, []);

  const moveSearchHit = useCallback(
    (direction: 1 | -1) => {
      setActiveSearchIndex((current) => getNextInlineThreadSearchIndex(current, searchHits.length, direction));
    },
    [searchHits.length],
  );

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        moveSearchHit(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeThreadSearch();
      }
    },
    [closeThreadSearch, moveSearchHit],
  );

  const sourceThreadMessageId = useMemo(
    () => getInlineThreadSourceMessageId(messages, sourceMessage),
    [messages, sourceMessage],
  );

  useEffect(() => {
    if (loading) return;
    const latestReply = countableReplyMessages.at(-1);
    onReplyCountChange?.(sourceMessage.id, threadId, countableReplyMessages.length, {
      authoritative: true,
      ...(latestReply
        ? {
            latestReply: {
              id: latestReply.id,
              catId: latestReply.catId ?? null,
              content: latestReply.content.replace(/\s+/g, ' ').trim() || '回复',
              timestamp: latestReply.timestamp,
            },
          }
        : {}),
    });
  }, [countableReplyMessages, loading, onReplyCountChange, sourceMessage.id, threadId]);

  const handleSend = useCallback(async () => {
    const content = input.trim() || (images.length > 0 ? '上传图片' : '');
    if (!content || sending || isPreparingImages) return;

    setSending(true);
    setSendError(null);
    try {
      if (isUnsafeInlineThreadTarget(threadId, sourceMessage)) {
        throw new Error('Thread 未创建成功，已阻止把回复写入主频道');
      }
      if (isCommandInvocation(content, '/reset-context')) {
        if (content !== '/reset-context' || images.length > 0) {
          throw new Error('用法：/reset-context');
        }
        await resetThreadContext(threadId);
        setInput('');
        closeSlashPicker();
        useToastStore.getState().addToast({
          type: 'success',
          title: '上下文已重置',
          message: RESET_CONTEXT_CONFIRMATION,
          duration: 6000,
          threadId,
        });
        return;
      }
      const res = await apiFetch(
        '/api/messages',
        images.length > 0
          ? {
              method: 'POST',
              body: createInlineThreadImageFormData({
                content,
                threadId,
                userId: getUserId(),
                ...(sourceThreadMessageId ? { replyTo: sourceThreadMessageId } : {}),
                images,
              }),
            }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content,
                threadId,
                userId: getUserId(),
                ...(sourceThreadMessageId ? { replyTo: sourceThreadMessageId } : {}),
              }),
            },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail ?? body?.error ?? `HTTP ${res.status}`);
      }
      setInput('');
      setImages([]);
      closeMentionPicker();
      onReplyCountChange?.(sourceMessage.id, threadId, countableReplyMessages.length + 1, {
        authoritative: false,
        latestReply: {
          id: `optimistic-${Date.now()}`,
          catId: null,
          content,
          timestamp: Date.now(),
        },
      });
      void Promise.all([loadMessages({ showLoading: false }), loadQueueRuntime()]).then(() => startReplyPolling());
    } catch (err) {
      setSendError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setSending(false);
    }
  }, [
    closeMentionPicker,
    closeSlashPicker,
    input,
    images,
    isPreparingImages,
    loadMessages,
    loadQueueRuntime,
    onReplyCountChange,
    countableReplyMessages.length,
    sending,
    sourceThreadMessageId,
    sourceMessage,
    startReplyPolling,
    threadId,
  ]);

  const addImages = useCallback(
    async (candidates: File[]) => {
      const capacity = MAX_THREAD_IMAGES - images.length;
      if (capacity <= 0) {
        setSendError(`每条消息最多 ${MAX_THREAD_IMAGES} 张图片`);
        return;
      }

      setIsPreparingImages(true);
      try {
        const accepted: File[] = [];
        let rejected = 0;
        for (const file of candidates) {
          if (accepted.length >= capacity) break;
          if (!THREAD_IMAGE_TYPES.has(file.type) || file.size > MAX_THREAD_IMAGE_BYTES) {
            rejected += 1;
            continue;
          }
          accepted.push(await compressImage(file));
        }
        if (rejected > 0 || candidates.length > capacity) {
          setSendError(`仅支持 PNG、JPEG、GIF、WebP，单张不超过 10MB，最多 ${MAX_THREAD_IMAGES} 张`);
        } else {
          setSendError(null);
        }
        if (accepted.length > 0) setImages((current) => [...current, ...accepted].slice(0, MAX_THREAD_IMAGES));
      } finally {
        setIsPreparingImages(false);
      }
    },
    [images.length],
  );

  const handleImageSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void addImages(Array.from(event.target.files ?? []));
      event.target.value = '';
    },
    [addImages],
  );

  const handleImagePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const pastedImages = Array.from(event.clipboardData.items)
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      if (pastedImages.length === 0) return;
      event.preventDefault();
      void addImages(pastedImages);
    },
    [addImages],
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      setInput(value);
      const slashQuery = detectSlashCommand(value, event.target.selectionStart);
      if (slashQuery !== null) {
        closeMentionPicker();
        setShowSlashCommands(true);
        setSlashQuery(slashQuery);
        setSlashSelectedIdx(0);
        return;
      }
      closeSlashPicker();

      const trigger = detectMenuTrigger(value, event.target.selectionStart);
      if (trigger?.type === 'mention') {
        setShowMentionPicker(true);
        setMentionStart(trigger.start);
        setMentionFilter(trigger.filter);
        setMentionSelectedIdx(0);
      } else {
        closeMentionPicker();
      }
    },
    [closeMentionPicker, closeSlashPicker],
  );

  const insertMention = useCallback(
    (option: CatOption) => {
      const before = input.slice(0, mentionStart);
      const after = input.slice(mentionStart + mentionFilter.length + 1);
      const next = `${before}${option.insert}${after}`;
      setInput(next);
      closeMentionPicker();
      setTimeout(() => {
        const cursor = before.length + option.insert.length;
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(cursor, cursor);
      }, 0);
    },
    [closeMentionPicker, input, mentionFilter.length, mentionStart],
  );

  const insertSlashCommand = useCallback(
    (item: SlashCommandItem) => {
      const rest = input.replace(/^\/[^\s]*/, '');
      const next = `${item.command}${rest}`;
      setInput(next);
      closeSlashPicker();
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(item.command.length, item.command.length);
      }, 0);
    },
    [closeSlashPicker, input],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashCommands) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (slashItems.length > 0) setSlashSelectedIdx((idx) => (idx + 1) % slashItems.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (slashItems.length > 0) setSlashSelectedIdx((idx) => (idx - 1 + slashItems.length) % slashItems.length);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const item = slashItems[slashSelectedIdx];
          if (item) insertSlashCommand(item);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSlashPicker();
          return;
        }
      }

      if (showMentionPicker) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (filteredCatOptions.length > 0) setMentionSelectedIdx((idx) => (idx + 1) % filteredCatOptions.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          if (filteredCatOptions.length > 0) {
            setMentionSelectedIdx((idx) => (idx - 1 + filteredCatOptions.length) % filteredCatOptions.length);
          }
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          const option = filteredCatOptions[mentionSelectedIdx];
          if (option) insertMention(option);
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMentionPicker();
          return;
        }
      }

      if (shouldSendInlineThreadMessage(event)) {
        event.preventDefault();
        void handleSend();
      }
    },
    [
      closeMentionPicker,
      closeSlashPicker,
      filteredCatOptions,
      handleSend,
      insertMention,
      insertSlashCommand,
      mentionSelectedIdx,
      showMentionPicker,
      showSlashCommands,
      slashItems,
      slashSelectedIdx,
    ],
  );

  return (
    <div className={getInlineThreadPanelShellClassName()} data-open={isClosing ? 'false' : 'true'}>
      <div className="hidden lg:block">
        <ResizeHandle direction="horizontal" onResize={handlePanelResize} onDoubleClick={resetPanelWidth} />
      </div>
      <aside
        className="slock-inline-thread-panel flex h-full min-h-0 w-full flex-shrink-0 flex-col border-l border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] lg:w-[var(--inline-thread-panel-width)]"
        style={{ '--inline-thread-panel-width': `${panelWidth}px` } as CSSProperties}
      >
        <div className="slock-inline-thread-header flex h-[54px] flex-shrink-0 items-center justify-between border-b border-[var(--slock-border-color)] px-5">
          <div className="min-w-0 text-sm font-semibold text-[var(--cafe-text)]">
            <span>Thread</span>
            <span className="ml-1.5 text-[var(--cafe-text-muted)]">— {parentThreadLabel}</span>
          </div>
          <div className="ml-3 flex flex-shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="slock-header-action slock-header-action--icon"
              onClick={openThreadSearch}
              aria-label="搜索 Thread"
              title="搜索 Thread"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="7" cy="7" r="4" />
                <path d="m10.2 10.2 3 3" />
              </svg>
            </button>
            <button
              type="button"
              onClick={handleViewInChannel}
              className="slock-header-action slock-header-action--label"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M6 4H4.25A1.25 1.25 0 0 0 3 5.25v6.5C3 12.44 3.56 13 4.25 13h6.5c.69 0 1.25-.56 1.25-1.25V10" />
                <path d="M9 3h4v4" />
                <path d="m8 8 5-5" />
              </svg>
              View in channel
            </button>
            <button
              type="button"
              onClick={onClose}
              className="slock-header-action slock-header-action--icon"
              aria-label="关闭 Thread 面板"
              title="关闭 Thread 面板"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>
        {searchOpen && (
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] px-4 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 border-2 border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] px-2 py-1">
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="7" cy="7" r="4" />
                <path d="m10.2 10.2 3 3" />
              </svg>
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search in thread"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--cafe-text)] outline-none placeholder:text-[var(--cafe-text-muted)]"
                aria-label="搜索当前 Thread"
              />
              <span className="flex-shrink-0 font-mono text-[11px] text-[var(--cafe-text-muted)]">
                {searchQuery.trim()
                  ? `${searchHits.length === 0 ? 0 : activeSearchIndex + 1}/${searchHits.length}`
                  : '0/0'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => moveSearchHit(-1)}
              disabled={searchHits.length === 0}
              className="slock-header-action slock-header-action--icon disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="上一条搜索结果"
              title="上一条"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => moveSearchHit(1)}
              disabled={searchHits.length === 0}
              className="slock-header-action slock-header-action--icon disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="下一条搜索结果"
              title="下一条"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={closeThreadSearch}
              className="slock-header-action slock-header-action--icon"
              aria-label="关闭 Thread 搜索"
              title="关闭搜索"
            >
              ×
            </button>
          </div>
        )}
        <InlineThreadTaskStatusCard task={task} />
        {runtimeCats.length > 0 && (
          <div className="flex flex-shrink-0 flex-col gap-1 border-b border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] px-4 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cafe-text-muted)]">
              当前回复
            </div>
            {runtimeCats.map((item) => (
              <div
                key={item.catId}
                className="flex min-w-0 items-center gap-2 rounded-[var(--slock-radius-lg)] border border-[var(--console-border-soft)] bg-[var(--console-shell-bg)] px-2 py-1.5 text-xs"
              >
                <span
                  className="h-2 w-2 flex-shrink-0 rounded-full animate-pulse"
                  style={{ backgroundColor: item.color }}
                />
                <span className="min-w-0 flex-1 truncate font-semibold text-[var(--cafe-text)]">{item.label}</span>
                <span className={`flex-shrink-0 font-medium ${THREAD_STATUS_TONE[item.status]}`}>
                  {THREAD_STATUS_LABELS[item.status]}
                </span>
                {(item.model || item.provider) && (
                  <span className="max-w-[110px] flex-shrink truncate text-[10px] text-[var(--cafe-text-muted)]">
                    {[item.model, item.provider].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4" onWheel={stopScrollPropagation}>
          <div className="mb-4">
            <div
              className={`px-1 py-1 transition-colors ${
                activeSearchHit?.id === sourceMessage.id
                  ? 'border-2 border-[var(--slock-border-color)] bg-[var(--console-active-bg)]'
                  : ''
              }`}
              data-inline-thread-message-id={sourceMessage.id}
            >
              <ChatMessage
                message={sourceMessage}
                getCatById={getCatById}
                showRuntimeMetadata
                searchHighlight={searchHits.some((hit) => hit.id === sourceMessage.id) ? searchQuery : undefined}
              />
            </div>
          </div>
          <div className="slock-thread-replies-divider mb-4 text-center text-[11px] tracking-[0.08em] text-[var(--cafe-text-muted)]">
            <div>Beginning of replies</div>
            <div className="mt-1">
              {visibleReplyMessages.length} {visibleReplyMessages.length === 1 ? 'reply' : 'replies'}
            </div>
          </div>
          {loading ? (
            <div className="py-6 text-center text-sm text-[var(--cafe-text-muted)]">加载中...</div>
          ) : visibleReplyMessages.length === 0 ? (
            <div className="py-6 text-center text-sm text-[var(--cafe-text-muted)]">暂无回复</div>
          ) : (
            visibleReplyMessages.map((msg) => {
              const isHit = searchHits.some((hit) => hit.id === msg.id);
              const isActiveHit = activeSearchHit?.id === msg.id;
              return (
                <div
                  key={msg.id}
                  data-inline-thread-message-id={msg.id}
                  className={`transition-colors ${
                    isActiveHit
                      ? 'border-2 border-[var(--slock-border-color)] bg-[var(--console-active-bg)] px-1 py-1'
                      : ''
                  }`}
                >
                  <ChatMessage
                    message={msg}
                    getCatById={getCatById}
                    showRuntimeMetadata
                    searchHighlight={isHit ? searchQuery : undefined}
                  />
                </div>
              );
            })
          )}
        </div>

        <div className="slock-inline-thread-composer flex-shrink-0 border-t border-[var(--slock-border-color)] p-4">
          {sendError && <div className="mb-2 text-xs text-conn-red-text">{sendError}</div>}
          <ImagePreview
            files={images}
            onRemove={(index) => setImages((current) => current.filter((_, i) => i !== index))}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={handleImageSelect}
          />
          <div className="slock-composer-frame relative">
            {showMentionPicker && (
              <MentionPicker
                options={filteredCatOptions}
                selectedIdx={mentionSelectedIdx}
                onSelectIdx={setMentionSelectedIdx}
                onPick={insertMention}
              />
            )}
            {showSlashCommands && (
              <SlashCommandPicker
                query={slashQuery}
                selectedIdx={slashSelectedIdx}
                onSelectIdx={setSlashSelectedIdx}
                onPick={insertSlashCommand}
                onItemsChange={setSlashItems}
              />
            )}
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleInputKeyDown}
              onPaste={handleImagePaste}
              placeholder="Message thread"
              rows={2}
              className="h-[84px] w-full resize-none border-0 bg-transparent px-3 py-2 pr-12 [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-body)] text-[var(--cafe-text)] outline-none placeholder:text-[var(--cafe-text-muted)]"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={(!input.trim() && images.length === 0) || sending || isPreparingImages}
              className="slock-send-button absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={sending ? '发送中' : '发送 Thread 回复'}
              title={sending ? '发送中...' : '发送'}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M2.5 13.5 14 8 2.5 2.5l1.4 4.1L8 8l-4.1 1.4z" />
              </svg>
            </button>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[var(--cafe-text-muted)]">
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={sending || isPreparingImages || images.length >= MAX_THREAD_IMAGES}
                className="slock-inline-control flex h-7 w-7 items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="上传图片"
                title="上传图片"
              >
                ▧
              </button>
              <span className="slock-inline-control flex h-7 w-7 items-center justify-center" aria-hidden="true">
                ⌘
              </span>
            </div>
            <span className="text-[11px] text-[var(--cafe-text-muted)]">Enter 发送 · Shift+Enter 换行</span>
          </div>
        </div>
      </aside>
    </div>
  );
}
