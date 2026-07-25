'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import type { CatStatusType } from '@/stores/chat-types';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { loadThreads as loadCachedThreads } from '@/utils/offline-store';
import { emptyTrash, purgeThread, softDeleteThreadWithUndo } from '@/utils/thread-delete';
import { useConfirm } from '../useConfirm';
import { scrollToMessage } from '@/utils/scrollToMessage';
import {
  isSavedMessagesViewOpen,
  loadSavedMessages,
  SAVED_MESSAGES_EVENT,
  SAVED_MESSAGES_VIEW_EVENT,
  type SavedMessageSnapshot,
  setSavedMessagesViewOpen,
} from '@/utils/saved-messages';

import { CatAvatar } from '../CatAvatar';
import { DirectoryPickerModal, type NewThreadOptions } from './DirectoryPickerModal';
import { CHAT_THREAD_ROUTE_EVENT, getThreadHref, pushThreadRouteWithHistory } from './thread-navigation';
import {
  formatRelativeTime,
  getProjectPaths,
  mergeLiveActivityIntoThreads,
  sortAndGroupThreadsWithWorkspace,
  type ThreadGroup,
} from './thread-utils';
import { useProjectPins } from './use-project-pins';
import { useScrollAnchor } from './use-scroll-anchor';

interface ThreadSidebarProps {
  onClose?: () => void;
  className?: string;
}

interface MessageSearchResult {
  id: string;
  threadId: string;
  threadTitle?: string;
  content: string;
  timestamp: number;
  catId: string | null;
  type: 'user' | 'assistant' | 'connector' | 'system';
}

const SIDEBAR_SECTION_COLLAPSE_KEY = 'clowder:thread-sidebar:collapsed-sections:v1';

function notifyThreadCreateFailure(message: string) {
  useToastStore.getState().addToast({
    type: 'error',
    title: '创建线程失败',
    message,
    duration: 6000,
  });
}

function getThreadDisplayTitle(thread: Pick<Thread, 'id' | 'title'> | undefined, fallbackThreadId: string): string {
  if (thread?.title) return thread.title;
  if (thread?.id === 'default' || fallbackThreadId === 'default') return '大厅';
  return '未命名对话';
}

function formatMessageExcerpt(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 60) return singleLine;
  return `${singleLine.slice(0, 60)}...`;
}

function isSidebarBranchThread(thread: Pick<Thread, 'title'>): boolean {
  const title = thread.title ?? '';
  return title.includes('(分支)') || title.trim() === '分支对话';
}

function getDirectThreadCatId(thread: Pick<Thread, 'isDM' | 'preferredCats' | 'participatingCats'>): string | null {
  const directCats = thread.participatingCats?.length ? thread.participatingCats : thread.preferredCats;
  const catId = directCats?.[0];
  if (!catId || directCats.length !== 1) return null;
  return thread.isDM || thread.preferredCats?.length === 1 ? catId : null;
}

function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="slock-unread-badge flex h-4 min-w-4 items-center justify-center rounded-full bg-conn-red-text px-1 text-[10px] font-semibold leading-none text-[var(--cafe-surface)]">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function SectionCollapseButton({
  collapsed,
  onClick,
  label,
}: {
  collapsed: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="slock-sidebar-section-collapse flex h-5 w-5 items-center justify-center border border-transparent text-[var(--clowder-sidebar-row-muted)] transition-colors hover:border-[var(--slock-border-color)] hover:bg-[var(--console-hover-bg)] hover:text-[var(--clowder-sidebar-row-active-text)]"
      aria-label={label}
      aria-expanded={!collapsed}
      title={label}
    >
      <svg
        className={`h-3 w-3 transition-transform ${collapsed ? '' : 'rotate-90'}`}
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M6 3.5a.75.75 0 011.28-.53l4.5 4.5a.75.75 0 010 1.06l-4.5 4.5A.75.75 0 116.22 11.97L10.19 8 6.22 4.03A.75.75 0 016 3.5z" />
      </svg>
    </button>
  );
}

export function ThreadSidebar({ onClose, className }: ThreadSidebarProps) {
  const {
    threads,
    currentThreadId,
    setThreads,
    setCurrentProject,
    isLoadingThreads,
    setLoadingThreads,
    getThreadState,
    threadStates,
    catStatuses,
  } = useChatStore();
  const { cats } = useCatData();
  const [isCreating, setIsCreating] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [messageSearchResults, setMessageSearchResults] = useState<MessageSearchResult[]>([]);
  const [isSearchingMessages, setIsSearchingMessages] = useState(false);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [savedViewOpen, setSavedViewOpen] = useState(false);
  // Channel sort order — SSR-safe: default 'recent', hydrate from localStorage after mount
  const [sortOrder, setSortOrder] = useState<'recent' | 'az'>('recent');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const [savedMessages, setSavedMessages] = useState<SavedMessageSnapshot[]>([]);
  const [bindWarning, setBindWarning] = useState<string | null>(null);
  // F095 Phase D: Trash bin state
  const [showTrash, setShowTrash] = useState(false);
  const [trashedThreads, setTrashedThreads] = useState<Thread[]>([]);
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  const confirm = useConfirm();
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set());

  // F095 Phase E: scroll anchor for reorder stability
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);

    // F164: Cache-first — show IndexedDB snapshot immediately (skip unread init; API refresh will handle)
    try {
      const cached = await loadCachedThreads();
      if (cached && cached.length > 0) {
        setThreads(cached);
      }
    } catch {
      // IDB read failure — continue to API
    }

    // Then fetch fresh data from API (replace snapshot if successful)
    try {
      const res = await apiFetch('/api/threads');
      if (!res.ok) return;
      const data = await res.json();
      const threads = data.threads ?? [];
      setThreads(threads); // Also triggers IDB write-through via chatStore
      const { initThreadUnread } = useChatStore.getState();
      for (const thread of threads) {
        if (thread.unreadCount > 0 || thread.hasUserMention) {
          initThreadUnread(thread.id, thread.unreadCount ?? 0, !!thread.hasUserMention);
        }
      }
    } catch {
      // API failed — IDB snapshot already displayed (if available)
    } finally {
      setLoadingThreads(false);
    }
  }, [setThreads, setLoadingThreads]);

  useEffect(() => {
    void loadThreads();
    // Fetch global bubble display defaults from Config Hub on mount
    void useChatStore.getState().fetchGlobalBubbleDefaults();
  }, [loadThreads]);

  useEffect(() => {
    const syncSavedMessages = () => setSavedMessages(loadSavedMessages());
    syncSavedMessages();
    window.addEventListener(SAVED_MESSAGES_EVENT, syncSavedMessages);
    window.addEventListener('storage', syncSavedMessages);
    return () => {
      window.removeEventListener(SAVED_MESSAGES_EVENT, syncSavedMessages);
      window.removeEventListener('storage', syncSavedMessages);
    };
  }, []);

  useEffect(() => {
    const syncSavedView = () => setSavedViewOpen(isSavedMessagesViewOpen());
    syncSavedView();
    window.addEventListener(SAVED_MESSAGES_VIEW_EVENT, syncSavedView);
    window.addEventListener('popstate', syncSavedView);
    return () => {
      window.removeEventListener(SAVED_MESSAGES_VIEW_EVENT, syncSavedView);
      window.removeEventListener('popstate', syncSavedView);
    };
  }, []);

  useEffect(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem(SIDEBAR_SECTION_COLLAPSE_KEY) ?? '[]');
      if (Array.isArray(parsed)) {
        setCollapsedSections(new Set(parsed.filter((value): value is string => typeof value === 'string')));
      }
    } catch {
      // Corrupt localStorage should not break the sidebar.
    }
  }, []);

  const toggleSidebarSection = useCallback((section: 'channels' | 'direct-messages') => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      try {
        localStorage.setItem(SIDEBAR_SECTION_COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        // localStorage is best-effort only.
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      void loadThreads();
      void useChatStore.getState().fetchGlobalBubbleDefaults();
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [loadThreads]);

  const navigateToThread = useCallback((threadId: string) => {
    pushThreadRouteWithHistory(threadId, typeof window !== 'undefined' ? window : undefined);
  }, []);

  const createInProject = useCallback(
    async (opts: NewThreadOptions) => {
      console.log('[createInProject] called with opts=', JSON.stringify(opts));
      setIsCreating(true);
      setShowPicker(false);
      try {
        if (opts.projectPath && opts.initProject) {
          const setupRes = await apiFetch('/api/projects/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectPath: opts.projectPath,
              mode: 'skip',
              initProject: true,
            }),
          });
          if (!setupRes.ok) {
            const errBody = await setupRes.text().catch(() => '(no body)');
            console.error('[createInProject] POST /api/projects/setup failed:', setupRes.status, errBody);
            notifyThreadCreateFailure('项目五件套初始化失败，请检查项目名或目录权限后重试。');
            return;
          }
        }

        const res = await apiFetch(`/api/threads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(opts.projectPath ? { projectPath: opts.projectPath } : {}),
            ...(opts.preferredCats?.length ? { preferredCats: opts.preferredCats } : {}),
            ...(opts.title || opts.bootcamp ? { title: opts.bootcamp ? '🎓 猫猫训练营' : opts.title } : {}),
            ...(opts.pinned ? { pinned: opts.pinned } : {}),
            ...(opts.backlogItemId ? { backlogItemId: opts.backlogItemId } : {}),
            ...(opts.bootcamp ? { bootcampState: { v: 1, phase: 'phase-1-intro', startedAt: Date.now() } } : {}),
          }),
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => '(no body)');
          console.error('[createInProject] POST /api/threads failed:', res.status, errBody);
          notifyThreadCreateFailure('这次创建对话没有成功，请稍后重试。');
          return;
        }
        const thread: Thread = await res.json();

        // F33: Bind external sessions after thread creation (best-effort, parallel)
        if (opts.sessionBindings?.length) {
          const results = await Promise.allSettled(
            opts.sessionBindings.map(({ catId, cliSessionId }) =>
              apiFetch(`/api/threads/${thread.id}/sessions/${catId}/bind`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cliSessionId }),
              }),
            ),
          );
          const failed = results.filter((r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok));
          if (failed.length > 0) {
            setBindWarning(`Session 绑定部分失败（${failed.length}/${results.length}），可在 Session 面板重试`);
            setTimeout(() => setBindWarning(null), 6000);
          }
        }

        if (opts.projectPath) setCurrentProject(opts.projectPath);
        navigateToThread(thread.id);
        // Auto-close sidebar on mobile after creating a new conversation
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          onClose?.();
        }
        await loadThreads();
      } catch (err) {
        console.error('[createInProject] exception:', err);
        notifyThreadCreateFailure('网络请求没有完成，创建对话失败。请稍后重试。');
      } finally {
        setIsCreating(false);
      }
    },
    [setCurrentProject, navigateToThread, loadThreads, onClose],
  );

  // F095 Phase D: Load trashed threads
  const loadTrash = useCallback(async () => {
    setIsLoadingTrash(true);
    try {
      const res = await apiFetch('/api/threads?deleted=true');
      if (!res.ok) return;
      const data = await res.json();
      setTrashedThreads(data.threads ?? []);
    } catch {
      // Silently ignore
    } finally {
      setIsLoadingTrash(false);
    }
  }, []);

  const handleToggleTrash = useCallback(() => {
    setShowTrash((prev) => {
      const next = !prev;
      if (next) void loadTrash();
      return next;
    });
  }, [loadTrash]);

  const handlePurge = useCallback(
    async (threadId: string, title: string | null) => {
      const label = title?.trim() || '未命名对话';
      const ok = await confirm({
        title: '永久删除',
        message: `「${label}」及其所有消息将被永久删除，无法恢复。`,
        confirmLabel: '永久删除',
        variant: 'danger',
      });
      if (!ok) return;

      const error = await purgeThread(threadId);
      const addToast = useToastStore.getState().addToast;
      if (error) {
        addToast({ type: 'error', title: '永久删除失败', message: error, duration: 4000 });
        return;
      }
      addToast({ type: 'success', title: '已永久删除', message: label, duration: 2400 });
      await loadTrash();
    },
    [confirm, loadTrash],
  );

  const handleEmptyTrash = useCallback(async () => {
    const ok = await confirm({
      title: '清空回收站',
      message: `回收站中的 ${trashedThreads.length} 个对话及其所有消息将被永久删除，无法恢复。`,
      confirmLabel: '清空',
      variant: 'danger',
    });
    if (!ok) return;

    const result = await emptyTrash();
    const addToast = useToastStore.getState().addToast;
    if ('error' in result) {
      addToast({ type: 'error', title: '清空失败', message: result.error, duration: 4000 });
      return;
    }
    addToast({ type: 'success', title: '回收站已清空', message: `永久删除 ${result.purged} 个对话`, duration: 2400 });
    await loadTrash();
  }, [confirm, loadTrash, trashedThreads.length]);

  const handleRestore = useCallback(
    async (threadId: string) => {
      try {
        const res = await apiFetch(`/api/threads/${threadId}/restore`, { method: 'POST' });
        if (!res.ok) return;
        await loadThreads();
        await loadTrash();
      } catch {
        // Silently ignore
      }
    },
    [loadThreads, loadTrash],
  );

  const handleSelect = useCallback(
    (threadId: string) => {
      setSavedMessagesViewOpen(false);
      // Always clear unread badge — user clicking the thread = "I've seen it"
      useChatStore.getState().clearUnread(threadId);
      if (threadId === currentThreadId) return;
      // Let the new thread restore projectPath after the route switch.
      // Pre-navigation global store writes can stall SPA thread navigation.
      navigateToThread(threadId);
      // Auto-close sidebar on mobile after selecting a thread
      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        onClose?.();
      }
    },
    [currentThreadId, navigateToThread, onClose],
  );

  const handleDeleteThread = useCallback(
    async (threadId: string, title: string | null) => {
      const error = await softDeleteThreadWithUndo(threadId, {
        title,
        onDeleted: () => {
          // Only leave the current view when the thread being removed is the open one.
          if (threadId === currentThreadId) navigateToThread('default');
          if (showTrash) void loadTrash();
        },
        onRestored: (restoredThreadId) => {
          navigateToThread(restoredThreadId);
          if (showTrash) void loadTrash();
        },
      });
      if (error) {
        useToastStore.getState().addToast({ type: 'error', title: '删除失败', message: error, duration: 4000 });
      }
    },
    [currentThreadId, loadTrash, navigateToThread, showTrash],
  );

  const handleMessageSearchResultSelect = useCallback(
    (message: MessageSearchResult) => {
      setSavedMessagesViewOpen(false);
      setShowUnreadOnly(false);
      setSearchQuery('');
      setDebouncedSearchQuery('');
      setMessageSearchResults([]);
      useChatStore.getState().clearUnread(message.threadId);

      if (message.threadId === currentThreadId) {
        window.setTimeout(() => scrollToMessage(message.id), 80);
      } else if (typeof window !== 'undefined') {
        const href = `${getThreadHref(message.threadId)}?highlight=${encodeURIComponent(message.id)}`;
        window.history.pushState({}, '', href);
        window.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
      }

      if (typeof window !== 'undefined' && window.innerWidth < 768) {
        onClose?.();
      }
    },
    [currentThreadId, onClose],
  );

  const normalizedQuery = searchQuery.trim().toLowerCase();
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const liveThreads = useMemo(() => mergeLiveActivityIntoThreads(threads, threadStates), [threads, threadStates]);
  const sidebarThreads = useMemo(() => liveThreads.filter((thread) => !isSidebarBranchThread(thread)), [liveThreads]);
  const dmThreadByCatId = useMemo(() => {
    const map = new Map<string, Thread>();
    for (const thread of sidebarThreads) {
      if (thread.deletedAt) continue;
      const catId = getDirectThreadCatId(thread);
      if (catId) map.set(catId, thread);
    }
    return map;
  }, [sidebarThreads]);
  const openDirectMessage = useCallback(
    async (catId: string) => {
      const existing = dmThreadByCatId.get(catId);
      if (existing) {
        setSavedMessagesViewOpen(false);
        useChatStore.getState().clearUnread(existing.id);
        navigateToThread(existing.id);
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          onClose?.();
        }
        return;
      }

      setIsCreating(true);
      try {
        const res = await apiFetch('/api/threads/dm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ catId }),
        });
        if (!res.ok) {
          notifyThreadCreateFailure('这次打开私信没有成功，请稍后重试。');
          return;
        }
        const thread: Thread = await res.json();
        setSavedMessagesViewOpen(false);
        navigateToThread(thread.id);
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          onClose?.();
        }
        await loadThreads();
      } catch (err) {
        console.error('[openDirectMessage] exception:', err);
        notifyThreadCreateFailure('网络请求没有完成，打开私信失败。请稍后重试。');
      } finally {
        setIsCreating(false);
      }
    },
    [dmThreadByCatId, loadThreads, navigateToThread, onClose],
  );
  const threadTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const thread of sidebarThreads) {
      map.set(thread.id, getThreadDisplayTitle(thread, thread.id));
    }
    map.set('default', '大厅');
    return map;
  }, [sidebarThreads]);
  const unreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of sidebarThreads) {
      const ts = threadStates[thread.id];
      if (ts && ts.unreadCount > 0) {
        ids.add(thread.id);
      }
    }
    return ids;
  }, [sidebarThreads, threadStates]);
  const unreadTotal = useMemo(() => {
    let total = 0;
    for (const thread of sidebarThreads) {
      total += threadStates[thread.id]?.unreadCount ?? 0;
    }
    return total;
  }, [sidebarThreads, threadStates]);
  const savedTotal = savedMessages.length;
  const filteredThreads = useMemo(() => {
    return sidebarThreads.filter((thread) => {
      // In Inbox mode (showUnreadOnly), include DM threads that have unreads.
      // Otherwise DMs are excluded from the channel list (they appear in the DM section).
      if (getDirectThreadCatId(thread) && !showUnreadOnly) {
        return false;
      }
      if (showUnreadOnly && !unreadIds.has(thread.id)) {
        return false;
      }
      if (!normalizedQuery) {
        return true;
      }

      const title = (thread.title ?? '').toLowerCase();
      const fallback = (thread.id === 'default' ? '大厅' : '未命名对话').toLowerCase();
      const project = (thread.projectPath ?? '').toLowerCase();
      const threadId = thread.id.toLowerCase();
      return (
        title.includes(normalizedQuery) ||
        fallback.includes(normalizedQuery) ||
        project.includes(normalizedQuery) ||
        threadId.includes(normalizedQuery)
      );
    });
  }, [sidebarThreads, normalizedQuery, showUnreadOnly, unreadIds]);

  // F072: Mark all threads as read
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const handleMarkAllRead = useCallback(async () => {
    setIsMarkingAllRead(true);
    try {
      const res = await apiFetch('/api/threads/read/mark-all', { method: 'POST' });
      if (res.ok) {
        useChatStore.getState().clearAllUnread();
      }
    } catch (err) {
      console.debug('[F072] mark-all-read failed:', err);
    } finally {
      setIsMarkingAllRead(false);
    }
  }, []);

  // F095 Phase B: Active workspace grouping
  const { pinnedProjects } = useProjectPins();
  const threadGroups = useMemo(
    () => sortAndGroupThreadsWithWorkspace(filteredThreads, unreadIds, pinnedProjects),
    [filteredThreads, unreadIds, pinnedProjects],
  );
  const flatChannelThreads = useMemo(() => {
    const seen = new Set<string>();
    const result: Thread[] = [];
    const collect = (group: ThreadGroup) => {
      for (const thread of group.threads) {
        if (thread.id === 'default' || seen.has(thread.id)) continue;
        seen.add(thread.id);
        result.push(thread);
      }
      group.archivedGroups?.forEach(collect);
    };
    threadGroups.forEach(collect);
    return result;
  }, [threadGroups]);

  const sortedChannelThreads = useMemo(() => {
    if (sortOrder === 'az') {
      return [...flatChannelThreads].sort((a, b) => {
        const aTitle = (a.title ?? '未命名对话').toLowerCase();
        const bTitle = (b.title ?? '未命名对话').toLowerCase();
        return aTitle.localeCompare(bTitle, 'zh-Hans-CN');
      });
    }
    return [...flatChannelThreads].sort((a, b) => {
      const timeDelta = (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
      if (timeDelta !== 0) return timeDelta;
      return (a.title ?? '未命名对话').localeCompare(b.title ?? '未命名对话', 'zh-Hans-CN');
    });
  }, [flatChannelThreads, sortOrder]);

  // Hydrate sort order from localStorage after mount (avoids SSR hydration mismatch)
  useEffect(() => {
    try {
      const stored = localStorage.getItem('clowder-channel-sort-order');
      if (stored === 'az') setSortOrder('az');
    } catch {
      // localStorage not available
    }
  }, []);

  // Close sort menu when clicking outside
  useEffect(() => {
    if (!showSortMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setShowSortMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSortMenu]);

  const handleSetSortOrder = (order: 'recent' | 'az') => {
    setSortOrder(order);
    setShowSortMenu(false);
    try {
      localStorage.setItem('clowder-channel-sort-order', order);
    } catch {
      // localStorage not available
    }
  };

  useEffect(() => {
    const query = debouncedSearchQuery.trim();
    if (!query) {
      setMessageSearchResults([]);
      setIsSearchingMessages(false);
      return;
    }

    let cancelled = false;
    setIsSearchingMessages(true);
    apiFetch(`/api/messages/search?q=${encodeURIComponent(query)}&limit=20`)
      .then(async (res) => {
        if (!res.ok) return { messages: [] };
        return (await res.json()) as { messages?: MessageSearchResult[] };
      })
      .then((data) => {
        if (cancelled) return;
        setMessageSearchResults(data.messages ?? []);
      })
      .catch(() => {
        if (!cancelled) setMessageSearchResults([]);
      })
      .finally(() => {
        if (!cancelled) setIsSearchingMessages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedSearchQuery]);

  const catStatusMap = useMemo(() => {
    const streamingStatuses = new Set<CatStatusType>(['spawning', 'pending', 'streaming']);
    const onlineStatuses = new Set<CatStatusType>(['alive_but_silent', 'suspected_stall']);
    const offlineStatuses = new Set<CatStatusType>(['done', 'error']);
    const map = new Map<string, 'streaming' | 'online' | 'offline'>();
    const collect = (statuses?: Record<string, CatStatusType>) => {
      for (const [catId, status] of Object.entries(statuses ?? {})) {
        if (streamingStatuses.has(status)) {
          map.set(catId, 'streaming');
        } else if (onlineStatuses.has(status) && map.get(catId) !== 'streaming') {
          map.set(catId, 'online');
        } else if (offlineStatuses.has(status) && !map.has(catId)) {
          map.set(catId, 'offline');
        }
      }
    };

    collect(catStatuses);
    for (const state of Object.values(threadStates)) {
      collect(state.catStatuses);
    }
    return map;
  }, [catStatuses, threadStates]);
  const activeDmCatIds = useMemo(() => {
    const ids = new Set<string>();
    for (const thread of sidebarThreads) {
      if (thread.id !== currentThreadId) continue;
      const directCat = getDirectThreadCatId(thread);
      if (directCat) ids.add(directCat);
    }
    return ids;
  }, [currentThreadId, sidebarThreads]);
  const existingProjects = useMemo(() => getProjectPaths(sidebarThreads), [sidebarThreads]);
  const showDefaultThread =
    !showUnreadOnly && (normalizedQuery.length === 0 || '大厅'.includes(normalizedQuery));
  const channelsCollapsed = normalizedQuery.length === 0 && collapsedSections.has('channels');
  const directMessagesCollapsed = collapsedSections.has('direct-messages');

  // F095 Phase E: Scroll anchor — keeps visible content in place when threads reorder
  const { onScroll: handleScrollAnchor } = useScrollAnchor(scrollContainerRef, threadGroups);

  const renderChannelRow = (thread: Pick<Thread, 'id' | 'title' | 'lastActiveAt'>) => {
    const threadState = getThreadState(thread.id);
    const unreadCount = threadState?.unreadCount ?? 0;
    const isActive = currentThreadId === thread.id;
    return (
      <button
        key={thread.id}
        type="button"
        data-thread-id={thread.id}
        data-active={isActive ? 'true' : 'false'}
        onClick={() => handleSelect(thread.id)}
        className={`slock-channel-row group mx-2 flex h-9 w-[calc(100%-1rem)] items-center gap-2 rounded-md border-l-2 px-3 text-left [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-tight)] transition-colors ${
          isActive
            ? 'border-[var(--clowder-sidebar-active-border)] bg-[var(--clowder-sidebar-active-bg)] text-[var(--clowder-sidebar-row-active-text)]'
            : 'border-transparent text-[var(--clowder-sidebar-row-text)] hover:bg-[var(--clowder-sidebar-hover-bg)] hover:text-[var(--clowder-sidebar-row-active-text)]'
        }`}
        title={thread.title ?? (thread.id === 'default' ? '大厅' : '未命名对话')}
      >
        <span className={`min-w-0 flex-1 truncate ${isActive ? 'font-semibold' : ''}`}>
          {thread.title ?? (thread.id === 'default' ? '大厅' : '未命名对话')}
        </span>
        {unreadCount > 0 ? (
          <UnreadBadge count={unreadCount} />
        ) : (
          <span className="[font-size:var(--clowder-type-meta)] text-[var(--clowder-sidebar-row-muted)] opacity-0 transition-opacity group-hover:opacity-100">
            {formatRelativeTime(thread.lastActiveAt, true)}
          </span>
        )}
        {thread.id !== 'default' && (
          // The row itself is a <button>, so this affordance must not be one — a nested
          // button is invalid HTML. Mirrors SectionGroup's ActionButton pattern.
          <span
            role="button"
            tabIndex={0}
            aria-label="删除对话"
            title="删除对话"
            data-testid={`thread-delete-${thread.id}`}
            onClick={(event) => {
              event.stopPropagation();
              void handleDeleteThread(thread.id, thread.title ?? null);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              void handleDeleteThread(thread.id, thread.title ?? null);
            }}
            className="ml-0.5 flex-shrink-0 cursor-pointer text-[var(--clowder-sidebar-row-muted)] opacity-0 transition-all hover:text-conn-red-text group-hover:opacity-100 focus-visible:opacity-100"
          >
            <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M6.5 1.75a.75.75 0 00-.75.75V3h4.5v-.5a.75.75 0 00-.75-.75h-3zM3.5 4.5h9l-.62 8.13A1.75 1.75 0 019.14 14.5H6.86a1.75 1.75 0 01-1.74-1.87L4.5 4.5h-1zM2 3.5h12a.5.5 0 010 1H2a.5.5 0 010-1z" />
            </svg>
          </span>
        )}
      </button>
    );
  };

  const renderMessageSearchResult = (message: MessageSearchResult) => {
    const threadTitle =
      message.threadTitle ?? threadTitleById.get(message.threadId) ?? getThreadDisplayTitle(undefined, message.threadId);
    return (
      <button
        key={message.id}
        type="button"
        onClick={() => handleMessageSearchResultSelect(message)}
        className="slock-sidebar-search-result mx-2 flex w-[calc(100%-1rem)] flex-col rounded-md px-3 py-2 text-left transition-colors hover:bg-[var(--console-hover-bg)]"
        title={message.content}
      >
        <span className="mb-0.5 max-w-full truncate text-[10px] font-semibold text-[var(--clowder-sidebar-row-muted)]">{threadTitle}</span>
        <span className="line-clamp-2 text-xs leading-[1.5] text-[var(--clowder-sidebar-row-text)]">{formatMessageExcerpt(message.content)}</span>
      </button>
    );
  };

  return (
    <>
      <aside
        className={`slock-thread-sidebar ${className ?? 'w-60'} flex flex-col h-full bg-[var(--clowder-sidebar-bg)]`}
        style={{ boxShadow: 'inset -1px 0 0 var(--clowder-sidebar-border)' }}
      >
        <div className="slock-thread-sidebar-header p-3 flex items-center justify-between gap-2">
          <span className="slock-thread-sidebar-title [font-size:var(--clowder-type-panel-title)] font-medium [line-height:var(--clowder-leading-tight)] text-[var(--clowder-sidebar-title)]">对话</span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              disabled={isCreating}
              className="slock-sidebar-new-button console-button-primary text-xs px-2 py-1 disabled:opacity-40"
              data-guide-id="sidebar.new-thread"
            >
              {isCreating ? '...' : '+ 新对话'}
            </button>
          </div>
        </div>

        {bindWarning && (
          <div className="px-3 py-1.5 bg-conn-amber-bg/60 text-[10px] text-conn-amber-text">{bindWarning}</div>
        )}

        <div className="slock-sidebar-search-wrap px-3 py-2">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索对话、消息或 ID..."
            className="slock-sidebar-search-input console-form-input w-full text-xs"
          />
          {unreadIds.size > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              disabled={isMarkingAllRead}
              className="mt-1.5 text-[10px] text-[var(--clowder-sidebar-row-muted)] hover:text-cafe-accent disabled:opacity-40 transition-colors"
              data-testid="mark-all-read-btn"
            >
              {isMarkingAllRead ? '清理中...' : '全部已读'}
            </button>
          )}
        </div>

        {/* Slock-style quick nav */}
        <div className="slock-sidebar-quicknav space-y-0.5 px-2 py-1">
          <button
            type="button"
            data-active={showUnreadOnly ? 'true' : 'false'}
            className={`slock-sidebar-row w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-tight)] transition-colors ${
              showUnreadOnly
                ? 'bg-[var(--clowder-sidebar-active-bg)] text-[var(--clowder-sidebar-row-active-text)]'
                : 'text-[var(--clowder-sidebar-row-text)] hover:bg-[var(--clowder-sidebar-hover-bg)] hover:text-[var(--clowder-sidebar-row-active-text)]'
            }`}
            onClick={() => {
              setSavedMessagesViewOpen(false);
              setShowUnreadOnly((value) => !value);
            }}
            aria-pressed={showUnreadOnly}
          >
            <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path d="M3 4a2 2 0 012-2h10a2 2 0 012 2v10.5A2.5 2.5 0 0114.5 17h-9A2.5 2.5 0 013 14.5V4zm2 0v6h2.5a1 1 0 01.8.4l.9 1.2a1 1 0 00.8.4h2a1 1 0 00.8-.4l.9-1.2a1 1 0 01.8-.4H15V4H5z" />
            </svg>
            <span className="min-w-0 flex-1 text-left">Inbox</span>
            {unreadTotal > 0 && (
              <span className="rounded-full bg-[var(--cafe-accent)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-[var(--cafe-accent-foreground)]">
                {unreadTotal > 99 ? '99+' : unreadTotal}
              </span>
            )}
          </button>
          <button
            type="button"
            data-active={savedViewOpen ? 'true' : 'false'}
            className={`slock-sidebar-row w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-tight)] transition-colors ${
              savedViewOpen
                ? 'bg-[var(--clowder-sidebar-active-bg)] text-[var(--clowder-sidebar-row-active-text)]'
                : 'text-[var(--clowder-sidebar-row-text)] hover:bg-[var(--clowder-sidebar-hover-bg)] hover:text-[var(--clowder-sidebar-row-active-text)]'
            }`}
            onClick={() => {
              setShowUnreadOnly(false);
              setSavedMessagesViewOpen(!savedViewOpen);
            }}
            aria-pressed={savedViewOpen}
          >
            <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.956a1 1 0 00.95.69h4.16c.969 0 1.371 1.24.588 1.81l-3.366 2.445a1 1 0 00-.364 1.118l1.286 3.956c.3.921-.755 1.688-1.538 1.118l-3.366-2.445a1 1 0 00-1.176 0L6.045 18.02c-.783.57-1.838-.197-1.538-1.118l1.286-3.956a1 1 0 00-.364-1.118L2.063 9.383c-.783-.57-.38-1.81.588-1.81h4.16a1 1 0 00.95-.69l1.288-3.956z" />
            </svg>
            <span className="min-w-0 flex-1 text-left">Saved</span>
            {savedTotal > 0 && (
              <span className="text-[10px] font-normal leading-none text-[var(--clowder-sidebar-row-muted)]">
                {savedTotal > 99 ? '99+' : savedTotal}
              </span>
            )}
          </button>
        </div>

        <div ref={scrollContainerRef} onScroll={handleScrollAnchor} className="flex-1 overflow-y-auto">
          {isLoadingThreads && threads.length === 0 && (
            <div className="text-center py-4 text-xs text-[var(--clowder-sidebar-row-muted)]">加载中...</div>
          )}

          <div className="slock-sidebar-section mt-2 border-t border-[var(--clowder-sidebar-border)] pt-2">
            <div className="px-3 pb-1 pt-1">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1">
                  <SectionCollapseButton
                    collapsed={channelsCollapsed}
                    onClick={() => toggleSidebarSection('channels')}
                    label={channelsCollapsed ? '展开频道' : '折叠频道'}
                  />
                  <div className="relative min-w-0" ref={sortMenuRef}>
                    <button
                      type="button"
                      onClick={() => setShowSortMenu((v) => !v)}
                      className="slock-sidebar-section-title flex items-center gap-1 font-semibold uppercase tracking-[var(--clowder-section-tracking)] [font-size:var(--clowder-type-section)] [line-height:var(--clowder-leading-tight)] text-[var(--clowder-muted-soft)] transition-colors hover:text-[var(--clowder-sidebar-row-active-text)]"
                      title="排序方式"
                    >
                      CHANNELS
                      <span className="slock-sidebar-section-count">{sortedChannelThreads.length + (showDefaultThread ? 1 : 0)}</span>
                      <svg className="h-3 w-3 opacity-60" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M4 5h8a.5.5 0 010 1H4a.5.5 0 010-1zm1 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm1 2h4a.5.5 0 010 1H6a.5.5 0 010-1z" />
                      </svg>
                    </button>
                  {showSortMenu && (
                    <div className="absolute left-0 top-full z-50 mt-1 w-32 overflow-hidden rounded-md border border-[var(--clowder-sidebar-border)] bg-[var(--cafe-surface)] shadow-md">
                      {(['recent', 'az'] as const).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => handleSetSortOrder(opt)}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                            sortOrder === opt
                              ? 'bg-[var(--clowder-sidebar-active-bg)] font-semibold text-[var(--cafe-accent)]'
                              : 'text-[var(--clowder-sidebar-row-text)] hover:bg-[var(--clowder-sidebar-hover-bg)]'
                          }`}
                        >
                          {sortOrder === opt && (
                            <svg className="h-3 w-3 flex-shrink-0 text-[var(--cafe-accent)]" viewBox="0 0 16 16" fill="currentColor">
                              <path d="M13.354 4.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3-3a.5.5 0 01.708-.708L6 11.293l6.646-6.647a.5.5 0 01.708 0z" />
                            </svg>
                          )}
                          {sortOrder !== opt && <span className="h-3 w-3 flex-shrink-0" />}
                          <span className="uppercase tracking-wide">{opt === 'recent' ? 'RECENT' : 'A-Z'}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPicker(true)}
                  className="slock-sidebar-section-action flex h-5 w-5 items-center justify-center rounded-md text-[var(--clowder-sidebar-row-muted)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--clowder-sidebar-row-active-text)]"
                  aria-label="新增频道"
                  title="新增频道"
                >
                  +
                </button>
              </div>
            </div>

            {!channelsCollapsed && (
            <>
              {showDefaultThread && renderChannelRow({ id: 'default', title: '大厅', lastActiveAt: Date.now() })}

              {sortedChannelThreads.map(renderChannelRow)}
            </>
            )}
          </div>

          {normalizedQuery.length > 0 && (
            <div className="slock-sidebar-section mt-3 border-t border-[var(--clowder-sidebar-border)] pt-2">
            <div className="px-3 pb-1 pt-1">
              <span className="font-semibold uppercase tracking-[var(--clowder-section-tracking)] [font-size:var(--clowder-type-section)] [line-height:var(--clowder-leading-tight)] text-[var(--clowder-muted-soft)]">
                MESSAGES
              </span>
              </div>
              <div className="space-y-0.5">
                {isSearchingMessages ? (
                  <div className="px-5 py-2 text-xs text-[var(--clowder-sidebar-row-muted)]">搜索消息中...</div>
                ) : messageSearchResults.length > 0 ? (
                  messageSearchResults.map(renderMessageSearchResult)
                ) : (
                  <div className="px-5 py-2 text-xs text-[var(--clowder-sidebar-row-muted)]">没有匹配的消息</div>
                )}
              </div>
            </div>
          )}

          {/* Hide the normal DM section in Inbox mode — unread DMs are shown inline above */}
          <div className={`slock-sidebar-section mt-3 border-t border-[var(--clowder-sidebar-border)] pt-2 ${showUnreadOnly ? 'hidden' : ''}`}>
            <div className="px-3 pb-1 pt-1">
              <div className="flex items-center gap-1">
                <SectionCollapseButton
                  collapsed={directMessagesCollapsed}
                  onClick={() => toggleSidebarSection('direct-messages')}
                  label={directMessagesCollapsed ? '展开私信' : '折叠私信'}
                />
                <span className="font-semibold uppercase tracking-[var(--clowder-section-tracking)] [font-size:var(--clowder-type-section)] [line-height:var(--clowder-leading-tight)] text-[var(--clowder-muted-soft)]">
                  DIRECT MESSAGES
                </span>
                <span className="slock-sidebar-section-count">{cats.length}</span>
              </div>
            </div>
            {!directMessagesCollapsed && <div className="space-y-0.5 px-2">
              {cats.length === 0 ? (
                <div className="px-2 py-1.5 text-xs text-[var(--clowder-sidebar-row-muted)]">暂无 Agent</div>
              ) : (
                cats.map((cat) => {
                  const status = catStatusMap.get(cat.id) ?? 'online';
                  const isActiveDm = activeDmCatIds.has(cat.id);
                  const dmThread = dmThreadByCatId.get(cat.id);
                  const unreadCount = dmThread ? (getThreadState(dmThread.id)?.unreadCount ?? 0) : 0;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => void openDirectMessage(cat.id)}
                      disabled={isCreating}
                      data-active={isActiveDm ? 'true' : 'false'}
                      className={`slock-sidebar-row flex h-9 w-full items-center gap-2 rounded-md border-l-2 px-2 text-left [font-size:var(--clowder-type-body)] [line-height:var(--clowder-leading-tight)] transition-colors disabled:opacity-40 ${
                        isActiveDm
                          ? 'border-[var(--clowder-sidebar-active-border)] bg-[var(--clowder-sidebar-active-bg)] text-[var(--clowder-sidebar-row-active-text)]'
                          : 'border-transparent text-[var(--clowder-sidebar-row-text)] hover:bg-[var(--clowder-sidebar-hover-bg)] hover:text-[var(--clowder-sidebar-row-active-text)]'
                      }`}
                      title={`打开与 ${formatCatName(cat)} 的私信`}
                    >
                      <span className="relative flex-shrink-0">
                        <CatAvatar catId={cat.id} size={24} tone={status === 'streaming' || isActiveDm ? 'default' : 'quiet'} />
                        <span
                          aria-label={status === 'streaming' ? '工作中' : status === 'offline' ? '离线' : '在线空闲'}
                          className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-[var(--clowder-sidebar-bg)]"
                          style={{
                            backgroundColor:
                              status === 'streaming'
                                ? '#eab308'
                                : status === 'offline'
                                  ? 'var(--clowder-sidebar-row-muted)'
                                : 'var(--console-status-connected)',
                          }}
                        />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{formatCatName(cat)}</span>
                      <UnreadBadge count={unreadCount} />
                    </button>
                  );
                })
              )}
            </div>}
          </div>

          {(normalizedQuery.length > 0 || showUnreadOnly) &&
            threadGroups.length === 0 &&
            !showDefaultThread && (
              <div className="px-3 py-4 text-xs text-[var(--clowder-sidebar-row-muted)]">
                {showUnreadOnly ? '暂无未读对话' : '没有匹配的对话'}
              </div>
            )}
        </div>

        {/* F095 Phase D: Trash bin section — styled as Pencil Sidebar Utility Row */}
        <div className="slock-sidebar-trash px-3 pb-3">
          <button
            type="button"
            onClick={handleToggleTrash}
            className="slock-sidebar-row flex w-full items-center gap-2 h-9 px-2.5 rounded-md bg-transparent text-xs text-[var(--clowder-sidebar-row-text)] transition-colors hover:bg-[var(--clowder-sidebar-hover-bg)] hover:text-[var(--clowder-sidebar-row-active-text)]"
            data-testid="trash-bin-toggle"
          >
            <svg
              className="h-[15px] w-[15px] flex-shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
            </svg>
            <span className="flex-1 text-left">
              回收站{trashedThreads.length > 0 ? ` (${trashedThreads.length})` : ''}
            </span>
            <svg
              className={`h-3 w-3 flex-shrink-0 transition-transform ${showTrash ? 'rotate-180' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          {showTrash && (
            <div className="max-h-48 overflow-y-auto">
              {isLoadingTrash && <div className="px-3 py-2 text-[10px] text-[var(--clowder-sidebar-row-muted)]">加载中...</div>}
              {!isLoadingTrash && trashedThreads.length === 0 && (
                <div className="px-3 py-2 text-[10px] text-[var(--clowder-sidebar-row-muted)]">回收站是空的</div>
              )}
              {trashedThreads.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--clowder-sidebar-row-text)] hover:bg-[var(--clowder-sidebar-hover-bg)] group"
                >
                  <span className="truncate flex-1">{t.title ?? '未命名对话'}</span>
                  <button
                    type="button"
                    onClick={() => handleRestore(t.id)}
                    className="sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 text-[10px] text-cafe-accent hover:text-cafe-accent/80 transition-all shrink-0"
                    data-testid={`restore-btn-${t.id}`}
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePurge(t.id, t.title ?? null)}
                    className="sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 text-[10px] text-conn-red-text hover:text-conn-red-text/80 transition-all shrink-0"
                    data-testid={`purge-btn-${t.id}`}
                    title="永久删除，无法恢复"
                  >
                    永久删除
                  </button>
                </div>
              ))}
              {trashedThreads.length > 0 && (
                <button
                  type="button"
                  onClick={handleEmptyTrash}
                  className="mt-1 w-full px-3 py-1.5 text-left text-[10px] text-conn-red-text transition-colors hover:bg-[var(--clowder-sidebar-hover-bg)]"
                  data-testid="empty-trash-btn"
                >
                  清空回收站（{trashedThreads.length}）
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      {showPicker && (
        <DirectoryPickerModal
          existingProjects={existingProjects}
          onSelect={createInProject}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </>
  );
}
