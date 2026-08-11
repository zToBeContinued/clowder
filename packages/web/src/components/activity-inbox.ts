import type { ChatMessage, Thread, ThreadState } from '@/stores/chat-types';

export type ActivityInboxKind = 'mention' | 'reply' | 'thread';

export interface ActivityInboxThreadSnapshot {
  thread: Pick<Thread, 'id' | 'title' | 'lastActiveAt' | 'deletedAt'>;
  state: Pick<ThreadState, 'messages' | 'unreadCount' | 'hasUserMention' | 'lastActivity'>;
}

export interface ActivityInboxItem {
  id: string;
  kind: ActivityInboxKind;
  threadId: string;
  threadTitle: string;
  messageId?: string;
  content: string;
  timestamp: number;
  unreadCount: number;
}

function threadTitle(thread: Pick<Thread, 'id' | 'title'>): string {
  if (thread.title) return thread.title;
  if (thread.id === 'default') return '大厅';
  return '未命名对话';
}

export function formatActivityExcerpt(content: string): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  if (!singleLine) return '（无正文）';
  if (singleLine.length <= 76) return singleLine;
  return `${singleLine.slice(0, 76)}...`;
}

function messageTime(message: Pick<ChatMessage, 'timestamp' | 'deliveredAt'>): number {
  return message.deliveredAt ?? message.timestamp ?? 0;
}

function itemId(kind: ActivityInboxKind, threadId: string, messageId?: string): string {
  return `${kind}:${threadId}:${messageId ?? 'thread'}`;
}

export function buildActivityInboxItems(
  snapshots: readonly ActivityInboxThreadSnapshot[],
  options: { limit?: number } = {},
): ActivityInboxItem[] {
  const limit = Math.max(1, options.limit ?? 30);
  const items: ActivityInboxItem[] = [];

  for (const { thread, state } of snapshots) {
    if (thread.deletedAt) continue;
    const unreadCount = Math.max(0, state.unreadCount ?? 0);
    const hasUnreadSignal = unreadCount > 0 || !!state.hasUserMention;
    if (!hasUnreadSignal) continue;

    const title = threadTitle(thread);
    let hasSpecificItem = false;

    for (const message of state.messages ?? []) {
      if (!message || (message.threadId && message.threadId !== thread.id)) continue;
      if (message.type === 'system' || message.type === 'summary') continue;

      const kind: ActivityInboxKind | null = message.mentionsUser ? 'mention' : message.replyTo ? 'reply' : null;
      if (!kind) continue;

      hasSpecificItem = true;
      items.push({
        id: itemId(kind, thread.id, message.id),
        kind,
        threadId: thread.id,
        threadTitle: title,
        messageId: message.id,
        content: formatActivityExcerpt(message.content),
        timestamp: messageTime(message),
        unreadCount,
      });
    }

    if (!hasSpecificItem || unreadCount > 1) {
      const fallbackKind: ActivityInboxKind = state.hasUserMention ? 'mention' : 'thread';
      items.push({
        id: itemId(fallbackKind, thread.id),
        kind: fallbackKind,
        threadId: thread.id,
        threadTitle: title,
        content: state.hasUserMention ? '有新的 @你 消息' : `${unreadCount} 条未读更新`,
        timestamp: Math.max(state.lastActivity ?? 0, thread.lastActiveAt ?? 0),
        unreadCount,
      });
    }
  }

  return items
    .sort((a, b) => {
      // @你 的条目永远置顶（需要用户行动），其余按时间倒序
      const aMention = a.kind === 'mention' ? 0 : 1;
      const bMention = b.kind === 'mention' ? 0 : 1;
      if (aMention !== bMention) return aMention - bMention;
      return b.timestamp - a.timestamp || a.threadTitle.localeCompare(b.threadTitle);
    })
    .slice(0, limit);
}

export function countActivityUnread(snapshots: readonly ActivityInboxThreadSnapshot[]): number {
  return snapshots.reduce((total, { thread, state }) => {
    if (thread.deletedAt) return total;
    return total + Math.max(0, state.unreadCount ?? 0);
  }, 0);
}

/** 有未读 @你 的频道数——徽章分层用（金色 @N vs 普通红色数字）。 */
export function countActivityMentionThreads(snapshots: readonly ActivityInboxThreadSnapshot[]): number {
  return snapshots.reduce((total, { thread, state }) => {
    if (thread.deletedAt) return total;
    return total + (state.hasUserMention ? 1 : 0);
  }, 0);
}
