'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { type TaskItem, useTaskStore } from '@/stores/taskStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { getDefaultReactionEmojis, hasUserReaction, toggleMessageReaction } from '@/utils/message-reactions';
import { isMessageSaved, SAVED_MESSAGES_EVENT, toggleSavedMessage } from '@/utils/saved-messages';
import { getUserId } from '@/utils/userId';
import { ConfirmDialog } from './ConfirmDialog';
import { MessageContextMenu } from './MessageContextMenu';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

function showErrorToast(title: string, body?: Record<string, unknown>) {
  useToastStore.getState().addToast({
    type: 'error',
    title,
    message: (body?.error as string) ?? '操作未成功，请重试',
    duration: 4000,
  });
}

function formatTaskTitleFromMessage(message: ChatMessage): string {
  const firstLine = message.content
    .split('\n')
    .map((line) => line.replace(/[#*_`>[\]()]/g, '').trim())
    .find(Boolean);
  const base = firstLine || '跟进这条消息';
  return base.length > 80 ? `${base.slice(0, 79)}…` : base;
}

type DialogState =
  | { type: 'none' }
  | { type: 'soft-delete' }
  | { type: 'hard-delete'; threadTitle: string | null }
  | { type: 'edit'; editedContent: string }
  | { type: 'branch-direct' };

interface MessageActionsProps {
  message: ChatMessage;
  threadId: string;
  children: React.ReactNode;
  onOpenThread?: (messageId: string) => void;
  onPinMessage?: (message: ChatMessage) => void;
  onEditMessage?: (message: ChatMessage) => void;
}

export function MessageActions({
  message,
  threadId,
  children,
  onOpenThread,
  onPinMessage,
  onEditMessage,
}: MessageActionsProps) {
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' });
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [saved, setSaved] = useState(() => isMessageSaved(message.id));
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const removeThreadMessage = useChatStore((s) => s.removeThreadMessage);
  const patchMessage = useChatStore((s) => s.patchMessage);
  const existingTask = useTaskStore((s) => s.tasks.find((task) => task.sourceMessageId === message.id));
  const addTask = useTaskStore((s) => s.addTask);

  const isUser = message.type === 'user' && !message.catId;
  const isAssistant = message.type === 'assistant' || (message.type === 'user' && !!message.catId);
  const canInlineEdit = isUser && !message.contentBlocks?.length && !!onEditMessage;
  const canAct = (isUser || isAssistant) && !message.isStreaming;
  // Keep the toolbar inside the hover frame so message + actions read as one unit.
  const toolbarPositionClass = isUser ? 'top-8' : 'top-1';

  useEffect(() => {
    const syncSaved = () => setSaved(isMessageSaved(message.id));
    syncSaved();
    window.addEventListener(SAVED_MESSAGES_EVENT, syncSaved);
    window.addEventListener('storage', syncSaved);
    return () => {
      window.removeEventListener(SAVED_MESSAGES_EVENT, syncSaved);
      window.removeEventListener('storage', syncSaved);
    };
  }, [message.id]);

  const handleSoftDelete = useCallback(() => setDialog({ type: 'soft-delete' }), []);

  const handleHardDelete = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, { method: 'GET' });
      const thread = res.ok ? await res.json() : null;
      setDialog({ type: 'hard-delete', threadTitle: thread?.title ?? null });
    } catch {
      setDialog({ type: 'hard-delete', threadTitle: null });
    }
  }, [threadId]);

  const handleEdit = useCallback(() => {
    setDialog({ type: 'edit', editedContent: message.content });
  }, [message.content]);
  const handleInlineEdit = useCallback(() => {
    onEditMessage?.(message);
  }, [message, onEditMessage]);

  const handleBranchDirect = useCallback(() => setDialog({ type: 'branch-direct' }), []);
  const handleConvertToTask = useCallback(async () => {
    if (existingTask) {
      useToastStore.getState().addToast({
        type: 'info',
        title: '这条消息已有任务',
        message: `已关联：${existingTask.title}`,
        duration: 2600,
      });
      return;
    }

    try {
      const res = await apiFetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          title: formatTaskTitleFromMessage(message),
          why: '由消息转为任务',
          createdBy: 'user',
          userId: getUserId(),
          sourceMessageId: message.id,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showErrorToast('转任务失败', body);
        return;
      }

      addTask(body as TaskItem);
      useToastStore.getState().addToast({
        type: 'success',
        title: '已转为任务',
        message: '可在 TASKS 面板查看。',
        duration: 2400,
      });
    } catch {
      showErrorToast('转任务失败');
    }
  }, [addTask, existingTask, message, threadId]);

  const handleReply = useCallback(() => {
    window.dispatchEvent(new CustomEvent('chat:set-reply', { detail: { messageId: message.id } }));
    useToastStore.getState().addToast({
      type: 'info',
      title: '已设置引用回复',
      message: '引用回复接入会在后续任务完善',
      duration: 1600,
    });
  }, [message.id]);

  const handleSave = useCallback(() => {
    const nextSaved = toggleSavedMessage(threadId, message);
    setSaved(nextSaved);
    useToastStore.getState().addToast({
      type: nextSaved ? 'success' : 'info',
      title: nextSaved ? '已收藏消息' : '已取消收藏',
      message: nextSaved ? '可在左侧 Saved 查看这条消息' : '这条消息已从 Saved 移除',
      duration: 1800,
    });
  }, [message, threadId]);
  const handleReaction = useCallback(
    async (emoji: string) => {
      const userId = getUserId();
      const active = hasUserReaction(message.extra?.reactions, emoji, userId);
      try {
        const reactions = await toggleMessageReaction({ messageId: message.id, emoji, userId, active });
        patchMessage(message.id, { extra: { reactions } });
      } catch (err) {
        useToastStore.getState().addToast({
          type: 'error',
          title: 'Reaction 失败',
          message: err instanceof Error ? err.message : '请稍后重试',
          duration: 3000,
        });
      } finally {
        setReactionPickerOpen(false);
      }
    },
    [message.extra?.reactions, message.id, patchMessage],
  );

  const handlePin = useCallback(() => {
    onPinMessage?.(message);
    useToastStore.getState().addToast({
      type: 'success',
      title: '已固定消息',
      message: 'Pin 持久化会在后续后端任务接入',
      duration: 1600,
    });
  }, [message, onPinMessage]);

  const handleSharePlaceholder = useCallback(() => {
    useToastStore.getState().addToast({
      type: 'info',
      title: '功能开发中',
      message: 'Share messages 将在后续版本接入',
      duration: 1800,
    });
  }, []);

  const handleOpenMoreMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setCtxMenu({ x: rect.left, y: rect.bottom + 6 });
  }, []);

  const confirmSoftDelete = useCallback(async () => {
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Clowder-Dangerous-Action-Confirmed': 'message.soft_delete',
        },
        body: JSON.stringify({ userId: getUserId(), mode: 'soft' }),
      });
      if (res.ok) {
        removeThreadMessage(threadId, message.id);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('删除失败', body);
      }
    } catch {
      showErrorToast('删除失败');
    }
  }, [message.id, threadId, removeThreadMessage]);

  const confirmHardDelete = useCallback(async () => {
    if (dialog.type !== 'hard-delete') return;
    const confirmTitle = dialog.threadTitle ?? '确认删除';
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: getUserId(), mode: 'hard', confirmTitle }),
      });
      if (res.ok) {
        removeThreadMessage(threadId, message.id);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('删除失败', body);
      }
    } catch {
      showErrorToast('删除失败');
    }
  }, [dialog, message.id, threadId, removeThreadMessage]);

  const confirmEdit = useCallback(async () => {
    if (dialog.type !== 'edit') return;
    const nextContent = dialog.editedContent.trim();
    if (!nextContent) return;
    if (nextContent === message.content.trim()) {
      setDialog({ type: 'none' });
      return;
    }
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/messages/${message.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: getUserId(),
          content: nextContent,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        patchMessage(message.id, {
          content: (body?.content as string) ?? nextContent,
          editedAt: (body?.editedAt as number) ?? Date.now(),
        });
      } else {
        showErrorToast('编辑失败', body);
      }
    } catch {
      showErrorToast('编辑失败');
    }
  }, [dialog, message.id, message.content, patchMessage]);

  const branchingRef = useRef(false);
  const confirmBranchDirect = useCallback(async () => {
    if (branchingRef.current) return;
    branchingRef.current = true;
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/threads/${threadId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromMessageId: message.id, userId: getUserId() }),
      });
      if (res.ok) {
        const { threadId: newThreadId } = await res.json();
        pushThreadRouteWithHistory(newThreadId, typeof window !== 'undefined' ? window : undefined);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('分支创建失败', body);
      }
    } catch {
      showErrorToast('分支创建失败');
    } finally {
      branchingRef.current = false;
    }
  }, [message.id, threadId]);

  const close = useCallback(() => setDialog({ type: 'none' }), []);

  return (
    <div
      className="slock-message-frame group relative rounded-[var(--slock-radius-lg)] px-3 py-2 transition-shadow hover:ring-1 hover:ring-[var(--clowder-message-hover-ring)]"
      onContextMenu={(event) => {
        if (!canAct) return;
        event.preventDefault();
        setCtxMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}

      {canAct && (
        <div
          className={`slock-message-toolbar opacity-0 group-hover:opacity-100 focus-within:opacity-100 absolute ${toolbarPositionClass} right-1 z-10 flex gap-0.5 rounded-[var(--slock-radius-md)] border border-[var(--slock-border-color)] bg-[var(--clowder-action-surface)] px-1 py-0.5 shadow-sm transition-opacity`}
        >
          <button type="button" onClick={handleReply} className="slock-message-action-button" title="引用回复">
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M6.5 5.25 3.75 8l2.75 2.75" />
              <path d="M4 8h5.25A3.75 3.75 0 0 1 13 11.75" />
            </svg>
            <span className="sr-only">引用回复</span>
          </button>
          {onOpenThread && (
            <button
              type="button"
              onClick={() => onOpenThread(message.id)}
              className="slock-message-action-button"
              title="在 Thread 面板中查看"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M3.25 4.25h9.5v6.5h-5l-3 2v-2h-1.5z" />
              </svg>
              <span className="sr-only">Thread</span>
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              onClick={() => setReactionPickerOpen((open) => !open)}
              className="slock-message-action-button"
              title="添加表情反应"
              aria-expanded={reactionPickerOpen}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="8" cy="8" r="5.25" />
                <path d="M5.75 9.5c.65.75 1.35 1.1 2.25 1.1s1.6-.35 2.25-1.1" />
                <path d="M6.1 6.5h.1M9.8 6.5h.1" />
              </svg>
              <span className="sr-only">添加表情反应</span>
            </button>
            {reactionPickerOpen && (
              <div className="absolute right-0 top-full z-20 mt-1 flex gap-1 rounded-lg border border-[var(--slock-border-color)] bg-[var(--cafe-surface)] p-1 shadow-lg">
                {getDefaultReactionEmojis().map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => handleReaction(emoji)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-sm transition-colors hover:bg-[var(--cafe-surface-elevated)]"
                    title={`添加 ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleSave}
            className="slock-message-action-button"
            title={saved ? '取消收藏消息' : '收藏消息'}
            aria-pressed={saved}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill={saved ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.8"
            >
              <path d="M4.25 2.75h7.5v10.5L8 10.75l-3.75 2.5z" />
            </svg>
            <span className="sr-only">{saved ? '取消收藏消息' : '收藏消息'}</span>
          </button>
          <button type="button" onClick={handleOpenMoreMenu} className="slock-message-action-button" title="更多操作">
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path d="M3.5 8h.1M7.95 8h.1M12.4 8h.1" />
            </svg>
            <span className="sr-only">更多操作</span>
          </button>
          <button
            type="button"
            onClick={handleSoftDelete}
            className="hidden"
            title="删除"
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            type="button"
            onClick={handleBranchDirect}
            className="hidden"
            title="从这里分支"
            aria-hidden="true"
            tabIndex={-1}
          />
          {isUser && (
            <button
              type="button"
              onClick={canInlineEdit ? handleInlineEdit : handleEdit}
              className="hidden"
              title="编辑消息"
              aria-hidden="true"
              tabIndex={-1}
            />
          )}
          <button
            type="button"
            onClick={handleHardDelete}
            className="hidden"
            title="永久删除"
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>
      )}
      {ctxMenu && (
        <MessageContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          messageId={message.id}
          content={message.content}
          onClose={() => setCtxMenu(null)}
          onSave={handleSave}
          onConvertToTask={handleConvertToTask}
          onShare={handleSharePlaceholder}
          onPin={onPinMessage ? handlePin : undefined}
          onEdit={isUser ? (canInlineEdit ? handleInlineEdit : handleEdit) : undefined}
          onSoftDelete={handleSoftDelete}
          onHardDelete={handleHardDelete}
        />
      )}

      {/* Soft delete confirmation */}
      <ConfirmDialog
        open={dialog.type === 'soft-delete'}
        title="删除消息"
        message="确认删除此消息？删除后可恢复。"
        confirmLabel="删除"
        variant="danger"
        onConfirm={confirmSoftDelete}
        onCancel={close}
      />

      {/* Hard delete confirmation — requires title input */}
      <ConfirmDialog
        open={dialog.type === 'hard-delete'}
        title="永久删除"
        message="此操作不可恢复。请输入对话标题以确认。"
        requireInput={dialog.type === 'hard-delete' ? (dialog.threadTitle ?? '确认删除') : undefined}
        inputPlaceholder={dialog.type === 'hard-delete' && dialog.threadTitle ? '输入对话标题' : '输入 "确认删除"'}
        confirmLabel="永久删除"
        variant="danger"
        onConfirm={confirmHardDelete}
        onCancel={close}
      />

      {/* Edit: inline textarea */}
      {dialog.type === 'edit' && (
        <div
          className="fixed inset-0 bg-[var(--console-overlay-backdrop)] flex items-center justify-center z-50"
          onClick={close}
        >
          <div
            className="bg-cafe-surface rounded-xl shadow-xl p-6 max-w-lg w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold mb-2">编辑消息</h3>
            <textarea
              value={dialog.editedContent}
              onChange={(e) => setDialog({ ...dialog, editedContent: e.target.value })}
              className="w-full border border-[var(--console-border-soft)] rounded-lg px-3 py-2 text-sm mb-4 h-32 resize-y focus:outline-none focus:ring-2 focus:ring-[var(--color-cafe-accent)]/30"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={close}
                className="px-4 py-2 text-sm text-cafe-secondary hover:bg-cafe-surface-elevated rounded-lg"
              >
                取消
              </button>
              <button
                onClick={confirmEdit}
                disabled={!dialog.editedContent.trim()}
                className="px-4 py-2 text-sm text-[var(--cafe-surface)] bg-[var(--color-cafe-accent)] hover:bg-[var(--color-cafe-accent)]/80 rounded-lg disabled:opacity-40"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Direct branch confirmation (no edit) */}
      <ConfirmDialog
        open={dialog.type === 'branch-direct'}
        title="从这里分支"
        message="将从此消息创建一个新的对话分支，复制到这条消息为止的所有历史。原对话保留不变。"
        confirmLabel="创建分支"
        onConfirm={confirmBranchDirect}
        onCancel={close}
      />
    </div>
  );
}
