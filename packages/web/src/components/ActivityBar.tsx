'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useCafeTheme } from '@/hooks/useCafeTheme';
import { usePinnedSections } from '@/hooks/usePinnedSections';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import {
  type ActivityInboxItem,
  buildActivityInboxItems,
  countActivityMentionThreads,
  countActivityUnread,
} from './activity-inbox';
import { HubIcon } from './hub-icons';
import { MemoryIcon } from './icons/MemoryIcon';
import { isDailySettingsSection, SETTINGS_SECTIONS } from './settings/settings-nav-config';
import { CHAT_THREAD_ROUTE_EVENT, getThreadHref, getThreadIdFromPathname } from './ThreadSidebar/thread-navigation';

type VisualTheme = 'claude' | 'slockv1' | 'slock' | 'kami';

const VISUAL_THEME_STORAGE_KEY = 'clowder:visual-theme';
const VISUAL_THEME_DEFAULT_MIGRATION_KEY = 'clowder:visual-theme-default:v4';
const VISUAL_THEME_ORDER: VisualTheme[] = ['claude', 'slockv1', 'slock', 'kami'];
const DEFAULT_VISUAL_THEME: VisualTheme = 'slock';

const NAV_ITEMS = [
  { id: 'home', path: '/', label: '对话', match: (p: string) => p === '/' || p.startsWith('/thread/') },
  { id: 'mission', path: '/mission-hub', label: '任务', match: (p: string) => p.startsWith('/mission') },
  { id: 'memory', path: '/memory', label: '记忆', match: (p: string) => p.startsWith('/memory') },
] as const;

function ChatIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>对话</title>
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MissionIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>Mission Hub</title>
      <path
        d="M16 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M15 3v4a1 1 0 0 0 1 1h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 13h6" strokeLinecap="round" />
      <path d="M9 17h3" strokeLinecap="round" />
    </svg>
  );
}

function ActivityIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>Activity</title>
      <path d="M5 5h14v11H8l-3 3V5Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 9h8M8 12h5" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>日间模式</title>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>夜间模式</title>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>设置</title>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function VisualThemeIcon({ theme }: { theme: VisualTheme }) {
  const label = theme === 'slockv1' ? 'V1' : theme === 'kami' ? 'K' : theme === 'slock' ? 'SL' : 'C';

  return (
    <span className="text-[11px] font-bold leading-none tracking-[-0.02em]" aria-hidden="true">
      {label}
    </span>
  );
}

function getVisualThemeLabel(theme: VisualTheme): string {
  if (theme === 'kami') return 'KAMI';
  if (theme === 'slockv1') return 'Slock v1';
  if (theme === 'slock') return 'Slock';
  return 'Claude';
}

function normalizeVisualTheme(theme: string | null): VisualTheme {
  if (theme === 'tesla') return 'slockv1';
  return VISUAL_THEME_ORDER.includes(theme as VisualTheme) ? (theme as VisualTheme) : DEFAULT_VISUAL_THEME;
}

const ICON_MAP: Record<string, ({ className }: { className?: string }) => JSX.Element> = {
  home: ChatIcon,
  memory: MemoryIcon,
  mission: MissionIcon,
  settings: SettingsIcon,
};

interface ActivityBarProps {
  className?: string;
}

function PinnedSections({ pinned, onNav }: { pinned: readonly string[]; onNav: (path: string) => void }) {
  const searchParams = useSearchParams();
  const activeSection = searchParams?.get('s') ?? '';
  const isStandalone = searchParams?.get('standalone') === '1';

  const pinnedSections = pinned
    .map((id) => SETTINGS_SECTIONS.find((s) => s.id === id))
    .filter((s): s is (typeof SETTINGS_SECTIONS)[number] => s != null && isDailySettingsSection(s));

  if (pinnedSections.length === 0) return null;

  return (
    <>
      <div className="my-1 h-px w-6 bg-[var(--console-border-soft)] opacity-50" />
      {pinnedSections.map((sec) => {
        const active = isStandalone && activeSection === sec.id;
        return (
          <button
            key={sec.id}
            type="button"
            onClick={() => onNav(`/settings?s=${sec.id}&standalone=1`)}
            className={`console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
              active
                ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
                : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
            }`}
            title={sec.label}
            aria-current={active ? 'page' : undefined}
            data-active={active ? 'true' : 'false'}
          >
            <HubIcon name={sec.icon} className="h-[18px] w-[18px]" />
          </button>
        );
      })}
    </>
  );
}

function SettingsButton({ pathname, onNav }: { pathname: string; onNav: (path: string) => void }) {
  const searchParams = useSearchParams();
  const isSettingsRoute = pathname.startsWith('/settings');
  const isStandalone = isSettingsRoute && searchParams?.get('standalone') === '1';
  const isSettings = isSettingsRoute && !isStandalone;

  return (
    <button
      type="button"
      onClick={() => onNav('/settings')}
      className={`console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
        isSettings
          ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
          : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
      }`}
      title="设置"
      aria-current={isSettings ? 'page' : undefined}
      data-active={isSettings ? 'true' : 'false'}
      data-guide-id="hub.trigger"
    >
      <SettingsIcon className="h-5 w-5" />
    </button>
  );
}

function activityKindLabel(kind: ActivityInboxItem['kind']): string {
  if (kind === 'mention') return '@你';
  if (kind === 'reply') return '回复';
  return '更新';
}

function activityKindTone(kind: ActivityInboxItem['kind']): string {
  // @你 用铲屎官主题金色，和消息卡片的「需要你」标识同源，一眼可辨
  if (kind === 'mention')
    return 'border border-[var(--cafe-needs-you-ring)] bg-[var(--cafe-needs-you-soft)] text-[var(--cafe-needs-you)]';
  if (kind === 'reply') return 'bg-conn-amber-bg text-conn-amber-text';
  return 'bg-[var(--console-hover-bg)] text-[var(--clowder-sidebar-row-muted)]';
}

export function ActivityBar({ className }: ActivityBarProps) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const { toggleTheme, resolvedTheme } = useCafeTheme();
  const { pinned } = usePinnedSections();
  const { threads, threadStates, currentThreadId, getThreadState, clearUnread } = useChatStore();
  const [mounted, setMounted] = useState(false);
  const [visualTheme, setVisualTheme] = useState<VisualTheme>(DEFAULT_VISUAL_THEME);
  const [activityOpen, setActivityOpen] = useState(false);

  useEffect(() => {
    // Honor any stored valid theme; default-version bumps must never reset a user's explicit choice.
    // The migration key is still written for backward compatibility with older builds.
    const storedTheme = window.localStorage.getItem(VISUAL_THEME_STORAGE_KEY);
    const nextTheme = normalizeVisualTheme(storedTheme);
    setVisualTheme(nextTheme);
    document.documentElement.dataset.visualTheme = nextTheme;
    window.localStorage.setItem(VISUAL_THEME_STORAGE_KEY, nextTheme);
    window.localStorage.setItem(VISUAL_THEME_DEFAULT_MIGRATION_KEY, '1');
    setMounted(true);
  }, []);

  const toggleVisualTheme = useCallback(() => {
    setVisualTheme((current) => {
      const currentIndex = VISUAL_THEME_ORDER.indexOf(current);
      const nextTheme = VISUAL_THEME_ORDER[(currentIndex + 1) % VISUAL_THEME_ORDER.length] ?? DEFAULT_VISUAL_THEME;
      document.documentElement.dataset.visualTheme = nextTheme;
      window.localStorage.setItem(VISUAL_THEME_STORAGE_KEY, nextTheme);
      return nextTheme;
    });
  }, []);

  const handleNav = useCallback(
    (path: string) => {
      const threadId = getThreadIdFromPathname(pathname);
      let referrer = threadId !== 'default' ? threadId : null;
      if (!referrer && typeof window !== 'undefined') {
        referrer = new URLSearchParams(window.location.search).get('from');
      }
      if (path === '/') {
        const fromParam =
          typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('from') : null;
        router.push(fromParam ? `/thread/${fromParam}` : '/');
      } else if (referrer) {
        const sep = path.includes('?') ? '&' : '?';
        router.push(`${path}${sep}from=${encodeURIComponent(referrer)}`);
      } else {
        router.push(path);
      }
    },
    [pathname, router],
  );

  const activitySnapshots = Array.from(new Set([...threads.map((thread) => thread.id), ...Object.keys(threadStates)]))
    .map((threadId) => {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) return null;
      return { thread, state: getThreadState(threadId) };
    })
    .filter((value): value is NonNullable<typeof value> => value != null);
  const activityItems = buildActivityInboxItems(activitySnapshots, { limit: 30 });
  const activityUnread = countActivityUnread(activitySnapshots);
  const activityMentionThreads = countActivityMentionThreads(activitySnapshots);

  useEffect(() => {
    if (!activityOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-activity-inbox-root]')) return;
      setActivityOpen(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [activityOpen]);

  const handleActivitySelect = useCallback(
    (item: ActivityInboxItem) => {
      clearUnread(item.threadId);
      setActivityOpen(false);

      if (item.threadId === currentThreadId && item.messageId) {
        window.setTimeout(() => scrollToMessage(item.messageId!), 80);
        return;
      }

      if (typeof window === 'undefined') {
        const href = item.messageId
          ? `${getThreadHref(item.threadId)}?highlight=${encodeURIComponent(item.messageId)}`
          : getThreadHref(item.threadId);
        router.push(href);
        return;
      }

      const href = item.messageId
        ? `${getThreadHref(item.threadId)}?highlight=${encodeURIComponent(item.messageId)}`
        : getThreadHref(item.threadId);
      window.history.pushState({}, '', href);
      window.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
    },
    [clearUnread, currentThreadId, router],
  );

  return (
    <nav
      className={`console-activity-rail relative flex w-[var(--slock-rail-width)] flex-shrink-0 flex-col items-center gap-1.5 border-r border-[var(--slock-border-color)] bg-[var(--console-rail-bg)] px-[6px] py-2.5 text-[var(--console-rail-fg)] ${className ?? ''}`}
      aria-label="主导航"
      data-activity-inbox-root
    >
      <button
        type="button"
        onClick={() => setActivityOpen((open) => !open)}
        className={`console-activity-button relative flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
          activityOpen
            ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
            : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
        }`}
        title="Activity"
        aria-label="Activity 聚合收件箱"
        aria-expanded={activityOpen}
        data-active={activityOpen ? 'true' : 'false'}
        data-guide-id="nav.activity"
      >
        <ActivityIcon className="h-5 w-5" />
        {activityUnread > 0 && (
          <span
            className={`slock-unread-badge absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-[var(--cafe-surface)] ${
              activityMentionThreads > 0 ? 'bg-[var(--cafe-needs-you)]' : 'bg-conn-red-text'
            }`}
            title={activityMentionThreads > 0 ? `${activityMentionThreads} 个频道有 @你` : `${activityUnread} 条未读`}
          >
            {activityMentionThreads > 0
              ? `@${activityMentionThreads > 9 ? '9+' : activityMentionThreads}`
              : activityUnread > 99
                ? '99+'
                : activityUnread}
          </span>
        )}
      </button>

      {activityOpen && (
        <div className="absolute left-[calc(var(--slock-rail-width)+8px)] top-2 z-[80] w-[320px] border-2 border-[var(--slock-border-color)] bg-[var(--clowder-sidebar-bg)] shadow-[4px_4px_0_var(--slock-border-color)]">
          <div className="flex items-center justify-between border-b-2 border-[var(--slock-border-color)] px-3 py-2">
            <div>
              <div className="text-[13px] font-semibold text-[var(--clowder-sidebar-title)]">Activity</div>
              <div className="text-[10px] text-[var(--clowder-sidebar-row-muted)]">跨频道 @你 / 回复 / Thread 更新</div>
            </div>
            {activityUnread > 0 && (
              <span className="rounded-full bg-conn-red-text px-2 py-0.5 text-[10px] font-semibold text-[var(--cafe-surface)]">
                {activityUnread > 99 ? '99+' : activityUnread}
              </span>
            )}
          </div>

          <div className="max-h-[420px] overflow-y-auto py-1">
            {activityItems.length === 0 ? (
              <div className="px-3 py-5 text-center text-xs text-[var(--clowder-sidebar-row-muted)]">
                暂无需要处理的 Activity
              </div>
            ) : (
              activityItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleActivitySelect(item)}
                  className="group flex w-full flex-col gap-1 border-b border-[var(--console-border-soft)] px-3 py-2 text-left last:border-b-0 hover:bg-[var(--console-hover-bg)]"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold ${activityKindTone(item.kind)}`}>
                      {activityKindLabel(item.kind)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--clowder-sidebar-row-text)]">
                      {item.threadTitle}
                    </span>
                    {item.unreadCount > 1 && (
                      <span className="text-[10px] text-[var(--clowder-sidebar-row-muted)]">
                        {item.unreadCount} new
                      </span>
                    )}
                  </div>
                  <span className="line-clamp-2 text-[12px] leading-[1.45] text-[var(--clowder-sidebar-row-muted)] group-hover:text-[var(--clowder-sidebar-row-text)]">
                    {item.content}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {NAV_ITEMS.map((item) => {
        const Icon = ICON_MAP[item.id];
        const active = item.match(pathname);
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => handleNav(item.path)}
            className={`console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] transition-all ${
              active
                ? 'bg-[var(--console-rail-active)] shadow-[0_5px_14px_rgba(43,37,32,0.07)]'
                : 'bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)]'
            }`}
            title={item.label}
            aria-current={active ? 'page' : undefined}
            data-active={active ? 'true' : 'false'}
            data-guide-id={`nav.${item.id}`}
          >
            <Icon className="h-5 w-5" />
          </button>
        );
      })}

      <Suspense>
        <PinnedSections pinned={pinned} onNav={handleNav} />
      </Suspense>

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <button
          type="button"
          onClick={toggleVisualTheme}
          className="console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)] transition-all"
          title={mounted ? `当前 ${getVisualThemeLabel(visualTheme)} 风格，点击切换下一套` : '切换视觉风格'}
          aria-label={mounted ? `当前 ${getVisualThemeLabel(visualTheme)} 风格，点击切换下一套` : '切换视觉风格'}
          data-active="false"
        >
          <VisualThemeIcon theme={mounted ? visualTheme : DEFAULT_VISUAL_THEME} />
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          className="console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] bg-[var(--console-rail-item)] hover:bg-[var(--console-hover-bg)] transition-all"
          title={mounted && resolvedTheme === 'dark' ? '切换到日间模式' : '切换到夜间模式'}
          data-active="false"
        >
          {mounted && resolvedTheme === 'dark' ? <MoonIcon className="h-5 w-5" /> : <SunIcon className="h-5 w-5" />}
        </button>
        <Suspense
          fallback={
            <button
              type="button"
              className="console-activity-button flex h-10 w-10 items-center justify-center rounded-[9px] bg-[var(--console-rail-item)] transition-all"
              title="设置"
              data-active="false"
              data-guide-id="hub.trigger"
            >
              <SettingsIcon className="h-5 w-5" />
            </button>
          }
        >
          <SettingsButton pathname={pathname} onNav={handleNav} />
        </Suspense>
      </div>
    </nav>
  );
}
