'use client';

import type { MessageReaction } from '@/stores/chat-types';
import { apiFetch } from './api-client';

const DEFAULT_EMOJIS = ['👍', '❤️', '😄', '🎉', '😮', '👀'];

export function getDefaultReactionEmojis(): string[] {
  return DEFAULT_EMOJIS;
}

export function hasUserReaction(
  reactions: readonly MessageReaction[] | undefined,
  emoji: string,
  userId: string,
): boolean {
  return Boolean(reactions?.some((reaction) => reaction.emoji === emoji && reaction.users.includes(userId)));
}

export async function toggleMessageReaction(input: {
  messageId: string;
  emoji: string;
  userId: string;
  active: boolean;
}): Promise<MessageReaction[]> {
  const endpoint = input.active
    ? `/api/messages/${encodeURIComponent(input.messageId)}/reactions/${encodeURIComponent(input.emoji)}`
    : `/api/messages/${encodeURIComponent(input.messageId)}/reactions`;
  const res = await apiFetch(endpoint, {
    method: input.active ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input.active ? { userId: input.userId } : { userId: input.userId, emoji: input.emoji }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body?.error as string | undefined) ?? `Reaction update failed: ${res.status}`);
  }
  return Array.isArray(body?.reactions) ? (body.reactions as MessageReaction[]) : [];
}
