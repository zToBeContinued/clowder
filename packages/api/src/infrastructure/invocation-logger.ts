/**
 * Invocation Logger — 按 catId + timestamp 写独立日志文件
 *
 * 日志路径: data/logs/invocations/{catId}/{YYYY-MM-DD_HHmmss}_{invocationId}.log
 * 每次 agent 调用生成一个独立文件，方便排查单次调用的完整流程。
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const LOG_BASE = resolve(process.cwd(), 'data', 'logs', 'invocations');

export interface InvocationLogEntry {
  type: 'start' | 'prompt' | 'tool_use' | 'tool_result' | 'text' | 'thinking' | 'error' | 'done' | 'event';
  catId: string;
  invocationId: string;
  threadId: string;
  timestamp: number;
  data?: unknown;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function formatLogLine(entry: InvocationLogEntry): string {
  const time = new Date(entry.timestamp).toISOString();
  const data = entry.data !== undefined ? ` ${JSON.stringify(entry.data)}` : '';
  return `[${time}] [${entry.type}]${data}\n`;
}

export class InvocationLogger {
  private logPath: string;
  private dirCreated = false;

  constructor(catId: string, invocationId: string, threadId: string) {
    const ts = formatTimestamp(Date.now());
    const dir = resolve(LOG_BASE, catId);
    const filename = `${ts}_${invocationId.slice(0, 12)}.log`;
    this.logPath = resolve(dir, filename);

    // 写入头部信息
    this.write({
      type: 'start',
      catId,
      invocationId,
      threadId,
      timestamp: Date.now(),
      data: { catId, invocationId, threadId },
    });
  }

  async write(entry: InvocationLogEntry): Promise<void> {
    try {
      if (!this.dirCreated) {
        await mkdir(resolve(this.logPath, '..'), { recursive: true });
        this.dirCreated = true;
      }
      await appendFile(this.logPath, formatLogLine(entry));
    } catch {
      // 日志写入失败不应影响主流程
    }
  }

  logPrompt(prompt: string, catId: string, invocationId: string, threadId: string): void {
    this.write({
      type: 'prompt',
      catId,
      invocationId,
      threadId,
      timestamp: Date.now(),
      data: { promptLength: prompt.length, promptPreview: prompt.slice(0, 200) },
    });
  }

  logEvent(type: InvocationLogEntry['type'], catId: string, invocationId: string, threadId: string, data?: unknown): void {
    this.write({ type, catId, invocationId, threadId, timestamp: Date.now(), data });
  }

  logDone(catId: string, invocationId: string, threadId: string, data?: unknown): void {
    this.write({ type: 'done', catId, invocationId, threadId, timestamp: Date.now(), data });
  }
}

/**
 * 创建一个 invocation logger 实例。
 * 调用方在 invocation 开始时创建，结束时调 logDone。
 */
export function createInvocationLogger(catId: string, invocationId: string, threadId: string): InvocationLogger {
  return new InvocationLogger(catId, invocationId, threadId);
}
