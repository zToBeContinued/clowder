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

/** Returns null on success, or a user-facing error message. */
export async function softDeleteThreadWithUndo(
  threadId: string,
  options: SoftDeleteThreadOptions = {},
): Promise<string | null> {
  if (!threadId || threadId === 'default') return '该对话不可删除';

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
  useToastStore.getState().addToast({
    type: 'success',
    title: label ? `已删除「${label}」` : '频道已删除',
    message: '已移入回收站，可在侧边栏底部找回',
    duration: UNDO_TOAST_DURATION_MS,
    action: {
      label: '撤销',
      onClick: () => restoreThread(threadId, options.onRestored),
    },
  });

  options.onDeleted?.();
  return null;
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
        threads: state.threads.some((thread) => thread.id === revived.id)
          ? state.threads
          : [...state.threads, revived],
      }));
    }
    onRestored?.(threadId);
  } catch {
    addToast({ type: 'error', title: '撤销失败', message: '网络请求未完成，请稍后重试', duration: 4000 });
  }
}
