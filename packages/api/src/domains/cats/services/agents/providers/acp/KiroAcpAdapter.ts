import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import { archiveRawEvent } from '../../../../../../utils/cli-spawn.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../../types.js';
import { isContextWindowOverflowError, TRANSIENT_PROVIDER_ERROR_CODE } from '../../invocation/invoke-helpers.js';
import { AcpProtocolError, AcpTimeoutError } from './AcpClient.js';
import type { AcpLease, AcpProcessPool } from './AcpProcessPool.js';
import { AcpThinkingCoalescer, transformAcpEvent } from './acp-event-transformer.js';
import { resolveUserProjectMcpServers } from './acp-mcp-resolver.js';
import { materializeSessionMcpServers } from './acp-session-env.js';
import type { AcpMcpServer, AcpSessionUpdate } from './types.js';

const log = createModuleLogger('kiro-acp');

interface KiroAcpClient {
  newSession(cwd: string, mcpServers?: AcpMcpServer[]): Promise<{ sessionId: string }>;
  loadSession(sessionId: string, cwd: string, mcpServers?: AcpMcpServer[]): Promise<unknown>;
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  cancelSession(sessionId: string): void;
  promptStream(sessionId: string, text: string, options?: { signal?: AbortSignal }): AsyncGenerator<AcpSessionUpdate>;
}

export interface KiroAcpAdapterConfig {
  catId: CatId;
  pool: AcpProcessPool;
  projectRoot: string;
  providerProfile?: string;
  model?: string;
  mcpSupport?: boolean;
  mcpServers?: AcpMcpServer[];
}

export class KiroAcpAdapter implements AgentService {
  readonly catId: CatId;
  private readonly pool: AcpProcessPool;
  private readonly projectRoot: string;
  private readonly providerProfile: string;
  private readonly model?: string;
  private readonly mcpSupport: boolean;
  private readonly mcpServers: AcpMcpServer[];

  constructor(config: KiroAcpAdapterConfig) {
    this.catId = config.catId;
    this.pool = config.pool;
    this.projectRoot = config.projectRoot;
    this.providerProfile = config.providerProfile ?? 'kiro';
    this.model = config.model?.trim() || undefined;
    this.mcpSupport = config.mcpSupport ?? true;
    this.mcpServers = config.mcpServers ?? [];
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = {
      provider: 'kiro',
      model: this.model ?? 'kiro-default',
      modelVerified: !!this.model,
    };
    if (options?.signal?.aborted) {
      yield this.errorMessage('prompt_failure', 'Kiro 请求在启动前已取消。', metadata);
      yield this.doneMessage(metadata);
      return;
    }

    const cwd = options?.workingDirectory ?? this.projectRoot;
    let lease: AcpLease;
    try {
      lease = await this.pool.acquire({ projectPath: cwd, providerProfile: this.providerProfile });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ catId: this.catId, cwd, error: message }, 'Kiro ACP process acquisition failed');
      yield this.errorMessage('init_failure', `Kiro CLI 启动失败：${message}`, metadata);
      yield this.doneMessage(metadata);
      return;
    }

    const client = lease.client as unknown as KiroAcpClient;
    let sessionId: string | undefined;
    let cancelled = false;
    const cancelSessionOnce = () => {
      if (!sessionId || cancelled) return;
      cancelled = true;
      client.cancelSession(sessionId);
    };
    const onAbort = () => cancelSessionOnce();
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const sessionMcpServers = this.resolveSessionMcpServers(cwd, options?.callbackEnv);
      if (options?.sessionId) {
        sessionId = options.sessionId;
        await client.loadSession(sessionId, cwd, sessionMcpServers);
      } else {
        const session = await client.newSession(cwd, sessionMcpServers);
        sessionId = session.sessionId;
      }
      metadata.sessionId = sessionId;

      if (options?.signal?.aborted) {
        cancelSessionOnce();
        yield this.errorMessage('prompt_failure', 'Kiro 请求在会话初始化期间已取消。', metadata);
        yield this.doneMessage(metadata);
        return;
      }

      if (this.model) {
        await client.setSessionModel(sessionId, this.model);
      }

      if (options?.signal?.aborted) {
        cancelSessionOnce();
        yield this.errorMessage('prompt_failure', 'Kiro 请求在会话初始化期间已取消。', metadata);
        yield this.doneMessage(metadata);
        return;
      }

      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId,
        metadata,
        timestamp: Date.now(),
      };

      if (options?.signal?.aborted) {
        cancelSessionOnce();
        yield this.doneMessage(metadata);
        return;
      }

      // Initialization windows are owned by the adapter. Once prompting starts,
      // AcpClient owns the AbortSignal and its request-scoped exactly-once cancel.
      options?.signal?.removeEventListener('abort', onAbort);
      const effectivePrompt = options?.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
      const thinkingCoalescer = new AcpThinkingCoalescer(this.catId);
      for await (const event of client.promptStream(sessionId, effectivePrompt, { signal: options?.signal })) {
        // 原始事件归档（诊断 ACP 事件形态问题；fire-and-forget，不改时序）
        archiveRawEvent(options?.invocationId, event);
        const synthetic = this.transformSyntheticEvent(event, metadata);
        if (synthetic) {
          yield synthetic;
          continue;
        }
        for (const message of thinkingCoalescer.push(transformAcpEvent(event, this.catId, metadata), metadata)) {
          yield message;
        }
      }
      for (const message of thinkingCoalescer.drain(metadata)) {
        yield message;
      }
      yield this.doneMessage(metadata);
    } catch (error) {
      const classified = classifyKiroError(error, options?.sessionId);
      log.error(
        { catId: this.catId, cwd, sessionId, errorCode: classified.errorCode, error: classified.message },
        'Kiro ACP invocation failed',
      );
      yield this.errorMessage(classified.errorCode, classified.message, metadata);
      yield this.doneMessage(metadata);
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
      lease.release();
    }
  }

  private resolveSessionMcpServers(cwd: string, callbackEnv?: Record<string, string>): AcpMcpServer[] {
    if (!this.mcpSupport) return [];

    const supportedBase = this.mcpServers.filter(isSupportedKiroMcpServer);
    let servers = supportedBase;
    if (cwd !== this.projectRoot) {
      const names = new Set(supportedBase.map((server) => server.name));
      const userServers = resolveUserProjectMcpServers(cwd, names).filter(isSupportedKiroMcpServer);
      if (userServers.length > 0) servers = [...supportedBase, ...userServers];
    }
    return materializeSessionMcpServers(servers, callbackEnv);
  }

  private transformSyntheticEvent(event: AcpSessionUpdate, metadata: MessageMetadata): AgentMessage | null {
    const type = event.update?.sessionUpdate;
    if (type !== 'stream_idle_warning' && type !== 'stream_tool_wait_warning') return null;
    const idleSeconds = Math.round(Number(event.update.idleSinceMs ?? 0) / 1000);
    return {
      type: 'liveness_signal',
      catId: this.catId,
      content: JSON.stringify({
        type: type === 'stream_idle_warning' ? 'warning' : 'info',
        message:
          type === 'stream_idle_warning'
            ? `${this.catId} 回复流暂时停滞（${idleSeconds}s）`
            : `${this.catId} 正在等待工具返回（${idleSeconds}s）`,
      }),
      metadata,
      timestamp: Date.now(),
    };
  }

  private errorMessage(errorCode: string, error: string, metadata: MessageMetadata): AgentMessage {
    return { type: 'error', catId: this.catId, error, errorCode, metadata, timestamp: Date.now() };
  }

  private doneMessage(metadata: MessageMetadata): AgentMessage {
    return { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
  }
}

function isSupportedKiroMcpServer(server: AcpMcpServer): boolean {
  return !('type' in server && server.type === 'sse');
}

/**
 * Kiro 服务端瞬时故障标记。
 *
 * Kiro runtimeservice 在响应流中途抛 500 时，Kiro CLI 只把 JSON-RPC message 写成
 * 笼统的 `Internal error`，真实原因落在 `data` 或 CLI 自己的 kiro-chat.log 里：
 *   `InternalServerError { message: "Encountered an unexpected error when processing
 *    the request, please try again." }` / `kind: Other { reason_code: "RecvErrorUnknown" }`
 * 这类错误重试可恢复，必须与同样走 -32603 的不可重试情形区分开。
 */
const KIRO_TRANSIENT_INTERNAL_RE =
  /Internal error|InternalServerError|Encountered an unexpected error|RecvErrorUnknown|ServiceUnavailable|InternalFailure/i;

/** -32603 下同样到达、但重试不会好转的情形：会话已消失 / 输入超长被服务端拒收。 */
const KIRO_NON_RETRYABLE_INTERNAL_RE = /Session not found/i;

/**
 * Kiro CLI 本地凭证失效。
 *
 * 现场症状（2026-07-29 kiro-chat.log）：CLI 的 social token 刷新被认证服务端以 500 拒绝
 *   （`auth::social: Failed to refresh social token: 500 Internal Server Error`），
 * 之后本地就没有可用 token 了，每次请求在连接层直接失败：
 *   `ConnectorError { kind: Other(None), source: NoToken }`
 *   → JSON-RPC 只写成 `Internal error`，data 里是 `An unknown error occurred: dispatch failure`。
 *
 * 这条必须先于 transient 判定命中：`Internal error` 会匹配 KIRO_TRANSIENT_INTERNAL_RE，
 * 于是"没登录"被包装成"服务端瞬时故障（稍后自动重试）"并反复重试，真实原因被完全掩盖。
 * IDE 与 CLI 的凭证是两套独立存储，同一账号下 IDE 能用不代表 CLI 也能用。
 */
const KIRO_AUTH_FAILURE_RE =
  /NoToken|Not logged in|Failed to refresh (?:social )?token|invalid_grant|ExpiredTokenException|UnauthorizedException|AccessDeniedException/i;

function stringifyAcpErrorData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function isTransientKiroInternalError(error: unknown): boolean {
  if (!(error instanceof AcpProtocolError) || error.code !== -32603) return false;
  const haystack = `${error.message} ${stringifyAcpErrorData(error.data)}`;
  if (KIRO_NON_RETRYABLE_INTERNAL_RE.test(haystack)) return false;
  if (KIRO_AUTH_FAILURE_RE.test(haystack)) return false;
  if (isContextWindowOverflowError(haystack)) return false;
  return KIRO_TRANSIENT_INTERNAL_RE.test(haystack);
}

function classifyKiroError(error: unknown, requestedSessionId?: string): { errorCode: string; message: string } {
  if (
    requestedSessionId &&
    error instanceof AcpProtocolError &&
    error.code === -32603 &&
    typeof error.data === 'string' &&
    /Session not found:\s*\S+/.test(error.data)
  ) {
    return {
      errorCode: 'prompt_failure',
      message: `No conversation found with session ID: ${requestedSessionId}`,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AcpTimeoutError) {
    return { errorCode: 'turn_budget_exceeded', message: `Kiro ACP 请求超时：${message}` };
  }
  // Kiro 服务端在请求进入模型前就以 400 拒收超长输入，重试不会好转，只能压上下文。
  // 单独分类是为了让用户看到可操作提示，而不是笼统的“请求失败”。
  // JSON-RPC message 常常只是笼统的 `Internal error`，真实 reason 落在 `data` 上，
  // 所以判定要看 message + data —— 否则超长输入会被误当成可重试故障。
  const errorDetail = error instanceof AcpProtocolError ? stringifyAcpErrorData(error.data) : '';
  // 凭证失效必须先于 transient 判定：否则 `Internal error` 会把它误判成可重试的服务端 5xx。
  if (KIRO_AUTH_FAILURE_RE.test(`${message} ${errorDetail}`)) {
    return {
      errorCode: 'auth_failure',
      message:
        `Kiro CLI 未登录或凭证已失效，重试无效：${message}${errorDetail ? `（${errorDetail.slice(0, 300)}）` : ''}。` +
        '请在终端执行 `kiro-cli login`（走与 Clowder 相同的代理），用 `kiro-cli whoami` 确认后重启 Clowder。' +
        '注意 Kiro IDE 与 kiro-cli 的凭证互相独立，IDE 能用不代表 CLI 已登录。',
    };
  }
  if (isContextWindowOverflowError(`${message} ${errorDetail}`)) {
    return {
      errorCode: 'context_window_overflow',
      message: `Kiro 上下文超出服务端上限，本轮被拒收：${message}。请降低该成员的 contextBudget、关闭 sessionChain，或新开 thread 重新分派。`,
    };
  }
  if (/Stream idle|STREAM_IDLE_STALL/i.test(message)) {
    return { errorCode: 'stream_idle_stall', message: `Kiro ACP 回复流中断：${message}` };
  }
  if (/\bmcp\b/i.test(message)) {
    return { errorCode: 'mcp_pollution', message: `Kiro MCP 初始化或调用失败：${message}` };
  }
  // Kiro 服务端瞬时 5xx。上层（invoke-single-cat）按 errorCode 做一次带退避的重试，
  // 本次尝试若已产出内容则不重试，错误照常上抛。
  if (isTransientKiroInternalError(error)) {
    const detail = errorDetail.slice(0, 300);
    return {
      errorCode: TRANSIENT_PROVIDER_ERROR_CODE,
      message: `Kiro 服务端瞬时故障（稍后自动重试）：${message}${detail ? `（${detail}）` : ''}`,
    };
  }
  return { errorCode: 'prompt_failure', message: `Kiro ACP 请求失败：${message}` };
}
