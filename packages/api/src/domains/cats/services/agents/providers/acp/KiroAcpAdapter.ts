import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../../types.js';
import { isContextWindowOverflowError } from '../../invocation/invoke-helpers.js';
import { AcpProtocolError, AcpTimeoutError } from './AcpClient.js';
import type { AcpLease, AcpProcessPool } from './AcpProcessPool.js';
import { transformAcpEvent } from './acp-event-transformer.js';
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
      for await (const event of client.promptStream(sessionId, effectivePrompt, { signal: options?.signal })) {
        const synthetic = this.transformSyntheticEvent(event, metadata);
        if (synthetic) {
          yield synthetic;
          continue;
        }
        const message = transformAcpEvent(event, this.catId, metadata);
        if (message) yield message;
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
            ? `Kiro 回复流暂时停滞（${idleSeconds}s）`
            : `Kiro 正在等待工具返回（${idleSeconds}s）`,
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
  if (isContextWindowOverflowError(message)) {
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
  return { errorCode: 'prompt_failure', message: `Kiro ACP 请求失败：${message}` };
}
