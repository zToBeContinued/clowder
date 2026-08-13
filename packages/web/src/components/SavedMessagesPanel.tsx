'use client';

import { useEffect, useMemo, useState } from 'react';
import { type Thread, useChatStore } from '@/stores/chatStore';
import {
  clearSavedMessageScrollTarget,
  loadSavedMessages,
  SAVED_MESSAGES_EVENT,
  type SavedMessageSnapshot,
  setSavedMessageScrollTarget,
  setSavedMessagesViewOpen,
} from '@/utils/saved-messages';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

function getThreadDisplayTitle(thread: Pick<Thread, 'id' | 'title'> | undefined, fallbackThreadId: string): string {
  if (thread?.title) return thread.title;
  if (thread?.id === 'default' || fallbackThreadId === 'default') return '大厅';
  return '未命名对话';
}

function formatSavedTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatExcerpt(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '（无正文）';
  if (singleLine.length <= 180) return singleLine;
  return `${singleLine.slice(0, 180)}...`;
}

function getSenderLabel(message: SavedMessageSnapshot): string {
  if (message.type === 'user' && !message.catId) return '我';
  if (message.catId) return message.catId;
  if (message.type === 'assistant') return 'Agent';
  return message.type;
}

function scrollToSavedMessage(messageId: string) {
  const selector =
    typeof window.CSS?.escape === 'function'
      ? `[data-message-id="${window.CSS.escape(messageId)}"]`
      : `[data-message-id="${messageId}"]`;
  document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

interface SavedMessagesPanelProps {
  currentThreadId: string;
}

export function SavedMessagesPanel({ currentThreadId }: SavedMessagesPanelProps) {
  const threads = useChatStore((s) => s.threads);
  const [savedMessages, setSavedMessages] = useState<SavedMessageSnapshot[]>(() => loadSavedMessages());

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

  const threadTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const thread of threads) {
      map.set(thread.id, getThreadDisplayTitle(thread, thread.id));
    }
    map.set('default', '大厅');
    return map;
  }, [threads]);

  const openSavedMessage = (message: SavedMessageSnapshot) => {
    setSavedMessagesViewOpen(false);
    if (message.threadId === currentThreadId) {
      clearSavedMessageScrollTarget();
      window.setTimeout(() => scrollToSavedMessage(message.messageId), 80);
      return;
    }
    setSavedMessageScrollTarget(message.threadId, message.messageId);
    pushThreadRouteWithHistory(message.threadId, typeof window !== 'undefined' ? window : undefined);
  };

  return (
    <main className="h-full overflow-y-auto p-6" data-chat-container>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <header className="border-b border-[var(--slock-border-color)] pb-4">
          <div className="flex items-center gap-2">
            <span className="text-lg" aria-hidden="true">
              ★
            </span>
            <h2 className="text-lg font-semibold text-[var(--cafe-text)]">Saved Messages</h2>
            <span className="rounded-full bg-[var(--console-card-soft-bg)] px-2 py-0.5 text-xs text-[var(--cafe-text-secondary)]">
              {savedMessages.length}
            </span>
          </div>
          <p className="mt-1 text-sm text-[var(--cafe-text-muted)]">
            收藏的是单条消息。点击任意条目会回到原频道或 Thread，并定位到对应消息。
          </p>
        </header>

        {savedMessages.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] px-5 py-8 text-center">
            <p className="text-sm font-medium text-[var(--cafe-text)]">暂无收藏消息</p>
            <p className="mt-1 text-xs text-[var(--cafe-text-muted)]">在消息右上角点击 Save 后，这里会集中展示。</p>
          </div>
        ) : (
          <div className="space-y-2">
            {savedMessages.map((message) => {
              const threadTitle =
                threadTitleById.get(message.threadId) ?? getThreadDisplayTitle(undefined, message.threadId);
              return (
                <button
                  key={message.messageId}
                  type="button"
                  onClick={() => openSavedMessage(message)}
                  className="group w-full rounded-xl border border-[var(--slock-border-color)] bg-[var(--console-card-bg)] px-4 py-3 text-left transition-colors hover:bg-[var(--console-hover-bg)] hover:ring-1 hover:ring-[var(--slock-border-color)]"
                  title={message.content}
                >
                  <div className="mb-2 flex items-center gap-2 text-xs text-[var(--cafe-text-muted)]">
                    <span className="font-semibold text-[var(--cafe-text-secondary)]">#{threadTitle}</span>
                    <span aria-hidden="true">·</span>
                    <span>{getSenderLabel(message)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatSavedTime(message.timestamp)}</span>
                  </div>
                  <p className="line-clamp-3 text-sm leading-[1.55] text-[var(--cafe-text)]">
                    {formatExcerpt(message.content)}
                  </p>
                  <div className="mt-2 text-xs text-[var(--cafe-accent)] opacity-0 transition-opacity group-hover:opacity-100">
                    打开原消息 →
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
