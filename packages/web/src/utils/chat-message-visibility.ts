import type { ChatMessage } from '@/stores/chat-types';
import { classifyRuntimeSystemEvent } from './runtime-notices';

const MODEL_SIGNATURE_LINE_RE = /^\s*\[[^\]]*(?:gpt|opus|claude|codex|gemini|kimi|模型)[^\]]*(?:🐾|📋)?\]\s*$/i;
const MODEL_METADATA_LINE_RE = /\bmodel\s*=\s*[a-z0-9._/-]+/i;
const IDENTITY_PREAMBLE_RE = /当前会话身份标注|身份标注为/i;
const SKILLS_BUDGET_WARNING_RE = /Exceeded\s+skills\s+context\s+budget|model-visible\s+skills\s+list/i;
const SHARED_STATE_PREFLIGHT_LINE_RE =
  /Shared-state\s+(?:preflight|files\s+committed)|uncommitted\s+shared-state\s+files|shared-rules\s*§14|Please\s+commit\+push\s+before\s+continuing/i;
const TOOL_TELEMETRY_LINE_RE =
  /(?:执行已完成，但没有返回文本|记录到\s*\d+\s*个工具事件|最后进度：.*(?:command_execution|file_change|mcp:|exit_code))/i;
const INTERNAL_RUNTIME_JSON_TYPES = new Set([
  'handoff_draft_window',
  'session_handoff_write_failed',
  'session_seal_requested',
  'info',
]);
// TODO(task #377): Delete both legacy collections together after the default-thread
// retention window no longer contains these ten exact IDs. Never broaden this
// to text matching: similar user-authored replies/errors must remain visible.
const LEGACY_HIDDEN_MESSAGE_IDS = new Set([
  '0001783988092014-000071-74726008',
  '0001783996224835-000088-8338059d',
  '0001784005219544-000095-4b0f0972',
  '0001784014233586-000241-a222b827',
  '0001784026820468-000069-3d6f0005',
  '0001784032228288-000002-ac973f99',
  '0001784073633308-000001-1dcac89d',
  '0001784082618960-000003-7a100130',
  '0001784091614412-000011-884b7c4a',
]);
const LEGACY_CONTENT_OVERRIDES = new Map([
  ['0001784032228274-000001-03c48775', 'Error: Codex 额度超限，7/20 23:26 恢复'],
]);

function isInternalRuntimeJsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;

  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return typeof parsed?.type === 'string' && INTERNAL_RUNTIME_JSON_TYPES.has(parsed.type);
  } catch {
    return false;
  }
}

export function sanitizeAgentVisibleContent(content: string): string {
  const lines = content.split(/\r?\n/);
  const cleaned: string[] = [];

  for (const line of lines) {
    if (MODEL_SIGNATURE_LINE_RE.test(line)) continue;
    if (MODEL_METADATA_LINE_RE.test(line)) continue;
    if (IDENTITY_PREAMBLE_RE.test(line)) continue;
    if (SKILLS_BUDGET_WARNING_RE.test(line)) continue;
    if (SHARED_STATE_PREFLIGHT_LINE_RE.test(line)) continue;
    if (TOOL_TELEMETRY_LINE_RE.test(line)) continue;
    if (isInternalRuntimeJsonLine(line)) continue;
    cleaned.push(line);
  }

  return cleaned
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function getAgentVisibleContent(message: ChatMessage): string {
  return sanitizeAgentVisibleContent(LEGACY_CONTENT_OVERRIDES.get(message.id) ?? message.content);
}

export function isUserVisibleChatMessage(message: ChatMessage): boolean {
  if (message.extra?.scheduler?.hiddenReceipt || LEGACY_HIDDEN_MESSAGE_IDS.has(message.id)) {
    return false;
  }

  if (message.origin === 'briefing') {
    return false;
  }

  if (
    message.type === 'connector' &&
    classifyRuntimeSystemEvent({
      id: message.id,
      content: message.content,
      source: message.source,
      threadId: message.threadId,
      timestamp: message.timestamp,
    })
  ) {
    return false;
  }

  if (message.type === 'assistant' && message.origin === 'stream' && message.isStreaming) {
    return false;
  }

  if (message.type === 'summary' || message.type === 'connector') {
    return true;
  }

  if (message.type === 'system') {
    if (message.variant === 'evidence' || message.variant === 'governance_blocked') return true;
    if (getAgentVisibleContent(message).trim().length > 0) return true;
    if (message.extra?.rich?.blocks?.length) return true;
    return false;
  }

  if (message.type === 'user' && !message.catId) {
    return true;
  }

  if (message.isStreaming) return true;
  if (message.contentBlocks?.length) return true;
  if (sanitizeAgentVisibleContent(message.content).trim().length > 0) return true;
  if (message.extra?.rich?.blocks?.length) return true;
  if (message.extra?.crossPost) return true;
  if (message.thinking) return true;

  return false;
}

export function isUnreadCountableChatMessage(message: ChatMessage): boolean {
  if (!isUserVisibleChatMessage(message)) return false;
  if (!message.mentionsUser && message.extra?.systemKind === 'a2a_routing') return false;
  if (message.extra?.systemKind === 'progress_heartbeat') return false;
  if (!message.mentionsUser && message.variant === 'a2a_followup') return false;
  const hasPrimarySurface =
    sanitizeAgentVisibleContent(message.content).trim().length > 0 ||
    !!message.contentBlocks?.length ||
    !!message.extra?.rich?.blocks?.length ||
    !!message.extra?.crossPost;
  if (message.type === 'assistant' && !message.mentionsUser && !hasPrimarySurface) return false;
  return true;
}
