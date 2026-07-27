/**
 * Thread Logger — 按 threadId 写消息流水
 *
 * 日志路径: data/logs/threads/{threadId}.log
 * 每个 thread 一个文件，追加写入所有消息（用户 + agent），方便查看对话全流程。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const LOG_BASE = resolve(process.cwd(), 'data', 'logs', 'threads');
let dirCreated = false;

export interface ThreadLogEntry {
  threadId: string;
  messageId: string;
  timestamp: number;
  type: 'user' | 'assistant' | 'system' | 'connector' | 'summary';
  catId?: string;
  contentPreview: string;
  contentLength: number;
  extra?: Record<string, unknown>;
}

function formatLogLine(entry: ThreadLogEntry): string {
  const time = new Date(entry.timestamp).toISOString();
  const sender = entry.catId ? `${entry.type}:${entry.catId}` : entry.type;
  const preview = entry.contentPreview.replace(/\n/g, '\\n');
  return `[${time}] [${sender}] (${entry.contentLength} chars) ${preview}\n`;
}

/**
 * 追加一条消息到 thread 日志文件。
 * 调用方是 MessageStore.onAppend hook 或消息路由。
 */
export async function appendThreadLog(entry: ThreadLogEntry): Promise<void> {
  try {
    // 安全：threadId 只保留安全字符，防止路径穿越
    const safeId = entry.threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safeId) return;
    if (!dirCreated) {
      await mkdir(LOG_BASE, { recursive: true });
      dirCreated = true;
    }
    const logPath = resolve(LOG_BASE, `${safeId}.log`);
    await appendFile(logPath, formatLogLine(entry));
  } catch {
    // 日志写入失败不应影响主流程
  }
}

/**
 * 从 StoredMessage 格式创建 ThreadLogEntry 的便捷函数。
 */
export function toThreadLogEntry(msg: {
  id: string;
  threadId: string;
  timestamp: number;
  type?: string;
  catId?: string;
  content: string;
}): ThreadLogEntry {
  return {
    threadId: msg.threadId,
    messageId: msg.id,
    timestamp: msg.timestamp,
    type: (msg.type as ThreadLogEntry['type']) || 'system',
    catId: msg.catId,
    contentPreview: msg.content.slice(0, 150),
    contentLength: msg.content.length,
  };
}
