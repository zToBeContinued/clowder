'use client';

/**
 * Shared soft-delete flow for threads.
 *
 * Deleting a thread is reversible (server keeps it with `deletedAt` set, the sidebar
 * trash bin lists it). The risk is therefore not data loss but disorientation: the
 * thread vanishes and the trash bin sits at the very bottom of the sidebar. So the
 * confirmation is replaced by an undo affordance shown where the user already is.
 *
 * Both entry points (channel settings and the sidebar row) route through here so the
 * two cannot drift apart.
 */

import { type Thread, useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';

const UNDO_TOAST_DURATION_MS = 8000;

export interface SoftDeleteThreadOptions {
  /** Human-readable title, used in the toast so bulk deletes stay distinguishable. */
  title?: string | null;
  /** Called after a successful delete — e.g. navigate away from the removed thread. */
  onDeleted?: () => void;
  /** Called after a successful undo, with the restored thread id. */
  onRestored?: (threadId: string) => void;
}

/**
 * Branches are NOT cascade-deleted: each holds a full copy of the messages and is usually
 * an independent work unit. Counting them lets the toast say so, instead of letting the
 * user think the delete failed when the project group reappears with orphaned branches.
 */
async function countBranches(threadId: string): Promise<number> {
  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/branches`);
    if (!response.ok) return 0;
    const body = (await response.json().catch(() => null)) as { branches?: unknown[] } | null;
    return Array.isArray(body?.branches) ? body.branches.length : 0;
  } catch {
    // Advisory only — never block a delete because the branch probe failed.
    return 0;
  }
}

/** Returns null on success, or a user-facing error message. */
export async function softDeleteThreadWithUndo(
  threadId: string,
  options: SoftDeleteThreadOptions = {},
): Promise<string | null> {
  if (!threadId || threadId === 'default') return '该对话不可删除';

  const branchCount = await countBranches(threadId);

  let response: Response;
  try {
    response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: 'DELETE',
      headers: { 'X-Clowder-Dangerous-Action-Confirmed': 'thread.soft_delete' },
    });
  } catch {
    return '网络请求未完成，请稍后重试';
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return body.error ?? '删除失败，请稍后重试';
  }

  useChatStore.setState((state) => ({
    threads: state.threads.filter((thread) => thread.id !== threadId),
  }));

  const label = options.title?.trim();
  const branchNote = branchCount > 0 ? `；${branchCount} 个分支已保留` : '';
  useToastStore.getState().addToast({
    type: 'success',
    title: label ? `已删除「${label}」` : '频道已删除',
    message: `已移入回收站，可在侧边栏底部找回${branchNote}`,
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: '撤销',
      onClick: () => restoreThread(threadId, options.onRestored),
    },
  });

  options.onDeleted?.();
  return null;
}

/**
 * Permanently remove one trashed thread. Returns null on success, else an error message.
 *
 * No undo affordance here on purpose: unlike the soft delete this is irreversible, so the
 * cost is asymmetric and the caller must confirm up front instead.
 */
export async function purgeThread(threadId: string): Promise<string | null> {
  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/purge`, {
      method: 'DELETE',
      headers: { 'X-Clowder-Dangerous-Action-Confirmed': 'thread.purge' },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      return body.error ?? '永久删除失败，请稍后重试';
    }
    return null;
  } catch {
    return '网络请求未完成，请稍后重试';
  }
}

/** Permanently remove every trashed thread. Returns the purged count, or an error message. */
export async function emptyTrash(): Promise<{ purged: number } | { error: string }> {
  try {
    const response = await apiFetch('/api/threads/trash', {
      method: 'DELETE',
      headers: { 'X-Clowder-Dangerous-Action-Confirmed': 'thread.purge' },
    });
    const body = (await response.json().catch(() => ({}))) as { purged?: number; error?: string };
    if (!response.ok) return { error: body.error ?? '清空回收站失败，请稍后重试' };
    return { purged: typeof body.purged === 'number' ? body.purged : 0 };
  } catch {
    return { error: '网络请求未完成，请稍后重试' };
  }
}

async function restoreThread(threadId: string, onRestored?: (threadId: string) => void): Promise<void> {
  const addToast = useToastStore.getState().addToast;
  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/restore`, { method: 'POST' });
    if (!response.ok) {
      addToast({ type: 'error', title: '撤销失败', message: '请到侧边栏回收站手动恢复', duration: 4000 });
      return;
    }
    // The delete removed it from the store optimistically; put it back from the server
    // payload so the sidebar does not stay one thread short until a manual refresh.
    const revived = (await response.json().catch(() => null)) as Thread | null;
    if (revived?.id) {
      useChatStore.setState((state) => ({
        threads: state.threads.some((thread) => thread.id === revived.id) ? state.threads : [...state.threads, revived],
      }));
    }
    onRestored?.(threadId);
  } catch {
    addToast({ type: 'error', title: '撤销失败', message: '网络请求未完成，请稍后重试', duration: 4000 });
  }
}
