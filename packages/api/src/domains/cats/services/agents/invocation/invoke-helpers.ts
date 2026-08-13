/**
 * Invocation helper functions — 从 invoke-single-cat 拆出的纯函数
 *
 * F23: 拆分以减少 invoke-single-cat.ts 行数
 */

/* ── F26: Task tool detection for real-time progress ─────── */
// F055-fix: Added 'todowrite' (opencode CLI lowercase variant) for multi-provider support
export const TASK_TOOL_NAMES = new Set(['TodoWrite', 'write_todos', 'todowrite']);

export type NormalizedTaskStatus = 'pending' | 'in_progress' | 'completed';

export function normalizeTaskStatus(raw: unknown): NormalizedTaskStatus {
  if (typeof raw !== 'string') return 'pending';
  const lower = raw.trim().toLowerCase();
  if (lower === 'completed' || lower === 'done' || lower === 'finished') return 'completed';
  if (lower === 'in_progress' || lower === 'doing' || lower === 'active' || lower === 'running') return 'in_progress';
  return 'pending';
}

export function extractTaskProgress(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): { action: 'snapshot'; tasks: Array<{ id: string; subject: string; status: string; activeForm?: string }> } | null {
  if (!toolInput || !TASK_TOOL_NAMES.has(toolName)) return null;
  const todos = toolInput.todos as Array<{ content?: string; status?: string; activeForm?: string }> | undefined;
  if (!Array.isArray(todos)) return null;
  return {
    action: 'snapshot',
    tasks: todos.map((t, i) => ({
      id: `task-${i}`,
      subject: (t.content ?? '').slice(0, 120),
      status: normalizeTaskStatus(t.status ?? 'pending'),
      ...(t.activeForm ? { activeForm: t.activeForm } : {}),
    })),
  };
}

export type ResumeFailureKind = 'missing_session' | 'cli_exit' | 'auth' | 'invalid_thinking_signature';

export function classifyResumeFailure(message: string | undefined): ResumeFailureKind | null {
  if (!message) return null;

  if (/(No conversation found with session ID|no rollout found|missing_rollout)/i.test(message)) {
    return 'missing_session';
  }
  if (/CLI 异常退出 \(code:\s*(?:\d+|null)(?:,\s*signal:\s*[^)]+)?\)/i.test(message)) {
    return 'cli_exit';
  }
  if (/\b(authentication failed|unauthorized|forbidden|login required|invalid credentials|auth)\b/i.test(message)) {
    return 'auth';
  }
  if (
    /(Invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block|broken thinking signature|损坏的 thinking signature)/i.test(
      message,
    )
  ) {
    return 'invalid_thinking_signature';
  }

  return null;
}

export function isMissingClaudeSessionError(message: string | undefined): boolean {
  return classifyResumeFailure(message) === 'missing_session';
}

/**
 * Context-window overflow markers across providers.
 *
 * - `ran out of room` / `context window` / `context_window`: Claude / Codex CLI wording.
 * - `ContextWindowOverflow` (no separator): Kiro runtime error kind — matched via the
 *   optional separator, since the CamelCase form has neither space nor underscore.
 * - `CONTENT_LENGTH_EXCEEDS_THRESHOLD` / `Input content length exceeds threshold`:
 *   Kiro runtime service ValidationException reason + message.
 */
const CONTEXT_WINDOW_OVERFLOW_PATTERN =
  /ran out of room|context[\s_]?window|CONTENT_LENGTH_EXCEEDS_THRESHOLD|input content length exceeds threshold/i;

export function isTransientCliExitCode1(message: string | undefined): boolean {
  if (!message) return false;
  if (!/CLI 异常退出 \(code:\s*1(?:,\s*signal:\s*none)?\)/i.test(message)) return false;
  // Context-window overflow is NOT recoverable by retrying — a second resume
  // writes the same user turn into the rollout JSONL again (see bug-report
  // 2026-04-19-codex-transient-retry-context-overflow).
  if (CONTEXT_WINDOW_OVERFLOW_PATTERN.test(message)) return false;
  return true;
}

/** Transient ACP prompt failure: Google API connection dropped mid-stream.
 *  "Premature close" = HTTP/2 stream reset or TCP drop from upstream. */
export function isTransientAcpPromptFailure(message: string | undefined): boolean {
  if (!message) return false;
  return /Premature close|ECONNRESET|socket hang up/i.test(message);
}

/**
 * Provider 侧瞬时故障错误码。
 *
 * 与文本匹配的 transient 判定不同，这个码由 adapter 自己判定并标注 —— adapter 能看到
 * 结构化的协议错误（code + data），比在上层猜字符串可靠。上层据此做一次带退避的重试。
 */
export const TRANSIENT_PROVIDER_ERROR_CODE = 'provider_transient';

/** Retry backoff for provider 5xx. 立即重试常落在同一故障窗口，给服务端一点恢复时间。
 * 支持 UI 热更新：每次取值时实时读 process.env，不缓存。
 */
export function getTransientProviderRetryDelayMs(): number {
  const raw = Number(process.env.CAT_CAFE_TRANSIENT_PROVIDER_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}
/** @deprecated 保留兼容引用，实际使用 getTransientProviderRetryDelayMs() */
export const TRANSIENT_PROVIDER_RETRY_DELAY_MS = 30_000;

export function isTransientProviderError(errorCode: string | undefined): boolean {
  return errorCode === TRANSIENT_PROVIDER_ERROR_CODE;
}

export function isPromptTokenLimitExceededError(message: string | undefined): boolean {
  if (!message) return false;
  return /(prompt token count|input tokens?).*exceeds the limit of \d+/i.test(message);
}

export function isContextWindowOverflowError(message: string | undefined): boolean {
  if (!message) return false;
  return CONTEXT_WINDOW_OVERFLOW_PATTERN.test(message);
}

export function isCliTimeoutError(message: string | undefined): boolean {
  if (!message) return false;
  return /CLI (?:响应超时|idle-silent 超时)/i.test(message);
}

/* ── Pre-flight timeout guard ────────────────────────────── */

/**
 * Maximum time (ms) for any single pre-flight async operation (Redis reads,
 * session chain lookups, thread store reads) before the invocation generator
 * gives up and proceeds with a safe fallback.
 *
 * Without this guard, a hung Redis/store operation blocks the generator
 * indefinitely — the finally block never runs, InvocationTracker never
 * clears, and the thread is permanently "busy."
 */
export const PREFLIGHT_TIMEOUT_MS = Number(process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS) || 30_000;

/**
 * Race a promise against a preflight timeout and an optional AbortSignal.
 * If the timeout or signal fires first, the returned promise rejects.
 * The original promise is NOT cancelled (no way to do so generically)
 * but the caller can proceed instead of hanging forever.
 */
export function preflightRace<T>(promise: Promise<T>, label: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);

  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanup = (): void => {
    if (timer) clearTimeout(timer);
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`preflight_timeout: ${label}`)), PREFLIGHT_TIMEOUT_MS);
    // Keep the process alive until the preflight guard actually fires.
    // Unref'ing this timer lets Node exit early when the raced promise never settles.
  });

  const parts: Promise<T | never>[] = [promise, timeoutPromise];
  if (signal) {
    parts.push(
      new Promise<never>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );
  }

  return Promise.race(parts).finally(cleanup);
}
