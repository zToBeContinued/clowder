/**
 * Cursor CLI (cursor-agent) stream-json event parser.
 *
 * 事件形态（实测 `cursor-agent -p --output-format stream-json --stream-partial-output`）：
 *   {"type":"system","subtype":"init","session_id","model","apiKeySource","permissionMode"}
 *   {"type":"user","message":{...}}
 *   {"type":"thinking","subtype":"delta","text":"...","timestamp_ms":...}
 *   {"type":"thinking","subtype":"completed"}
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"timestamp_ms":...}  // delta
 *   {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}                      // 最终快照(无 timestamp_ms)
 *   {"type":"result","subtype":"success","is_error":false,"result":"...","usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}
 *
 * 说明：`--stream-partial-output` 下 assistant 文本以「增量 delta」形式流出(带 timestamp_ms)，
 * 结束时再发一条不带 timestamp_ms 的完整快照。为避免重复渲染，调用方应：带 timestamp_ms 的按
 * 增量 append；不带 timestamp_ms 的仅在「一个 delta 都没收到」时作为兜底整段输出。
 */

import type { TokenUsage } from '../../types.js';

export interface CursorStreamEvent {
  type?: string;
  subtype?: string;
  text?: string;
  session_id?: string;
  timestamp_ms?: number;
  model?: string;
  is_error?: boolean;
  result?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export function isCursorEvent(value: unknown): value is CursorStreamEvent {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

/** system/init 事件携带 session_id 与实际模型。 */
export function readInitSessionId(event: CursorStreamEvent): string | null {
  if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
    return event.session_id;
  }
  return null;
}

/** thinking delta 文本(仅 subtype=delta 且有 text)。 */
export function readThinkingDelta(event: CursorStreamEvent): string | null {
  if (event.type === 'thinking' && event.subtype === 'delta' && typeof event.text === 'string' && event.text) {
    return event.text;
  }
  return null;
}

/** 从 assistant 事件里拼出文本内容(content 里所有 type=text 的片段)。 */
export function readAssistantText(event: CursorStreamEvent): string | null {
  if (event.type !== 'assistant') return null;
  const content = event.message?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
  return text || null;
}

/** assistant 事件是否为「流式增量」(带 timestamp_ms)，用于区分最终快照。 */
export function isAssistantDelta(event: CursorStreamEvent): boolean {
  return event.type === 'assistant' && typeof event.timestamp_ms === 'number';
}

/** result 事件里的 usage → Clowder TokenUsage。 */
export function readResultUsage(event: CursorStreamEvent): TokenUsage | null {
  if (event.type !== 'result' || !event.usage) return null;
  const u = event.usage;
  const usage: TokenUsage = {};
  if (typeof u.inputTokens === 'number') usage.inputTokens = u.inputTokens;
  if (typeof u.outputTokens === 'number') usage.outputTokens = u.outputTokens;
  if (typeof u.cacheReadTokens === 'number') usage.cacheReadTokens = u.cacheReadTokens;
  if (typeof u.cacheWriteTokens === 'number') usage.cacheCreationTokens = u.cacheWriteTokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

/** result 事件是否标记为错误。 */
export function readResultError(event: CursorStreamEvent): string | null {
  if (event.type === 'result' && event.is_error === true) {
    return typeof event.result === 'string' && event.result ? event.result : 'Cursor CLI 报告执行失败';
  }
  return null;
}
