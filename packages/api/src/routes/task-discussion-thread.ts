import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export function formatTaskThreadTitle(title: string): string {
  const trimmed = title.trim();
  const shortTitle = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
  return `${shortTitle || '任务'} (分支)`;
}

export function formatTaskSourceContent(task: { title: string; why?: string }): string {
  return [`📌 Task: ${task.title}`, task.why?.trim() ? `\n${task.why.trim()}` : ''].join('\n');
}

export function toTaskThreadMessage(message: StoredMessage) {
  return {
    id: message.id,
    threadId: message.threadId,
    userId: message.userId,
    catId: message.catId,
    content: message.content,
    mentions: message.mentions,
    timestamp: message.timestamp,
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
  };
}

export async function ensureTaskDiscussionThread(
  task: TaskItem,
  deps: {
    taskStore: ITaskStore;
    threadStore: IThreadStore;
    messageStore: IMessageStore;
    socketManager: SocketManager;
  },
  options: { userId?: string; broadcastUpdate?: boolean } = {},
): Promise<{ threadId: string; sourceMessage: ReturnType<typeof toTaskThreadMessage>; task: TaskItem }> {
  const { taskStore, threadStore, messageStore, socketManager } = deps;
  if (task.taskThreadId) {
    const existingThread = await threadStore.get(task.taskThreadId);
    if (existingThread) {
      const messages = await messageStore.getByThread(task.taskThreadId, 100);
      const sourceMessage = messages[0];
      if (sourceMessage) {
        return { threadId: task.taskThreadId, sourceMessage: toTaskThreadMessage(sourceMessage), task };
      }
    }
  }

  const parentThread = await threadStore.get(task.threadId);
  const userId = options.userId ?? task.userId ?? parentThread?.createdBy ?? 'default-user';
  const taskThread = await threadStore.create(userId, formatTaskThreadTitle(task.title), parentThread?.projectPath);

  if (parentThread?.participants?.length) {
    await threadStore.addParticipants(taskThread.id, parentThread.participants);
  }

  const originalSource = task.sourceMessageId ? await messageStore.getById(task.sourceMessageId) : null;
  const sourceMessage = await messageStore.append({
    userId: originalSource?.userId ?? userId,
    catId: originalSource?.catId ?? null,
    content: originalSource?.content ?? formatTaskSourceContent(task),
    mentions: originalSource?.mentions ? [...originalSource.mentions] : [],
    timestamp: originalSource?.timestamp ?? task.createdAt,
    threadId: taskThread.id,
    ...(originalSource?.contentBlocks ? { contentBlocks: originalSource.contentBlocks } : {}),
    ...(originalSource?.metadata ? { metadata: originalSource.metadata } : {}),
    ...(originalSource?.origin ? { origin: originalSource.origin } : {}),
    ...(originalSource?.source ? { source: originalSource.source } : {}),
  });

  const updated = await taskStore.update(task.id, {
    taskThreadId: taskThread.id,
    ...(task.sourceMessageId ? {} : { sourceMessageId: sourceMessage.id }),
  });
  if (updated && options.broadcastUpdate !== false) {
    socketManager.broadcastToRoom(`thread:${task.threadId}`, 'task_updated', updated);
  }

  return {
    threadId: taskThread.id,
    sourceMessage: toTaskThreadMessage(sourceMessage),
    task: updated ?? {
      ...task,
      taskThreadId: taskThread.id,
      ...(task.sourceMessageId ? {} : { sourceMessageId: sourceMessage.id }),
    },
  };
}
