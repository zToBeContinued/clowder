/** Cursor Agent Service — cursor-agent subprocess via print mode + stream-json. */

import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import { archiveRawEvent, isCliError, isCliTimeout, isLivenessWarning, spawnCli } from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { mergeTokenUsage } from '../../types.js';
import {
  type CursorStreamEvent,
  isAssistantDelta,
  isCursorEvent,
  readAssistantText,
  readInitSessionId,
  readResultError,
  readResultUsage,
  readThinkingDelta,
} from './cursor-event-parser.js';

const log = createModuleLogger('cursor-agent');

interface CursorAgentServiceOptions {
  catId?: CatId;
  spawnFn?: SpawnFn;
  model?: string;
  cliCommand?: string;
}

/** 组装 cursor-agent 的 prompt：无 --append-system-prompt，身份提示前置拼入。 */
function buildCursorPrompt(prompt: string, systemPrompt?: string): string {
  const trimmed = systemPrompt?.trim();
  return trimmed ? `${trimmed}\n\n${prompt}` : prompt;
}

export class CursorAgentService implements AgentService {
  readonly catId: CatId;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly model: string;
  private readonly cliCommand: string;

  constructor(options?: CursorAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('cursor');
    this.spawnFn = options?.spawnFn;
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.cliCommand = options?.cliCommand ?? 'cursor-agent';
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = { provider: 'cursor', model: this.model || 'Auto' };
    const effectivePrompt = buildCursorPrompt(prompt, options?.systemPrompt);
    const workingDirectory = options?.workingDirectory ?? process.cwd();

    // --print 无头；stream-json + partial 流式。全权限参数在自定义参数后追加，防止被覆盖。
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--workspace',
      workingDirectory,
    ];
    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
      metadata.sessionId = options.sessionId;
    }
    // cursor 的 effort 编码在模型名后缀里（如 claude-opus-4-8-high），直接作为 --model 传入。
    if (this.model) {
      args.push('--model', this.model);
    }
    // 成员编辑器自定义 CLI 参数(#567)。
    for (const arg of options?.cliConfigArgs ?? []) {
      args.push(...arg.trim().split(/\s+/));
    }
    args.push('--force', '--trust', '--sandbox', 'disabled', '--approve-mcps');
    // prompt 必须是末尾位置参数(spawnCli 用数组、非 shell，无引号注入风险)。
    args.push(effectivePrompt);

    try {
      const hasInjectedExecutor = Boolean(this.spawnFn || options?.spawnCliOverride);
      const command = hasInjectedExecutor ? this.cliCommand : resolveCliCommand(this.cliCommand);
      if (!command) {
        yield {
          type: 'error',
          catId: this.catId,
          error: formatCliNotFoundError(this.cliCommand),
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }

      const cliOpts = {
        command,
        args,
        ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
        ...(options?.callbackEnv || options?.accountEnv
          ? { env: { ...(options?.callbackEnv ?? {}), ...(options?.accountEnv ?? {}) } }
          : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
        ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
      };
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOpts)
        : spawnCli(cliOpts, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);

      let emittedSessionInit = Boolean(options?.sessionId);
      let sawAssistantDelta = false;
      // Cursor 的 thinking 以逐词 delta 流出。此前每个 delta 直接透传成独立
      // thinking 事件，下游（route-serial appendThinkingChunk）把每个词当成
      // 独立段落并用 "---" 分隔渲染 → 展开后一词一行。仿 Claude parser 的
      // 做法：缓冲整块，块边界（completed/assistant/result 等非 delta 事件）再发。
      let thinkingBuffer = '';

      for await (const event of events) {
        // 原始事件归档（诊断 cursor 首段重发 / exit 1）；fire-and-forget，不改时序。
        archiveRawEvent(options?.invocationId, event);
        if (isCliTimeout(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            metadata,
            timestamp: Date.now(),
            error: `Cursor CLI 响应超时 (${Math.round(event.timeoutMs / 1000)}s${event.firstEventAt == null ? ', 未收到首帧' : ''})`,
          };
          continue;
        }
        if (isLivenessWarning(event)) {
          const w = event as { level?: string; silenceDurationMs?: number };
          log.warn(
            { catId: this.catId, invocationId: options?.invocationId, level: w.level, silenceMs: w.silenceDurationMs },
            '[CursorAgent] liveness warning — CLI may be stuck',
          );
          yield {
            type: 'system_info',
            catId: this.catId,
            timestamp: Date.now(),
            content: JSON.stringify({ type: 'liveness_warning', ...(event as object) }),
          };
          continue;
        }
        if (isCliError(event)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Cursor CLI', event),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (!isCursorEvent(event)) continue;

        const initSessionId = readInitSessionId(event);
        if (initSessionId) {
          metadata.sessionId = initSessionId;
          if (typeof event.model === 'string' && event.model) metadata.model = event.model;
          if (!emittedSessionInit) {
            emittedSessionInit = true;
            yield {
              type: 'session_init',
              catId: this.catId,
              sessionId: initSessionId,
              metadata,
              timestamp: Date.now(),
            };
          }
          continue;
        }

        const thinking = readThinkingDelta(event);
        if (thinking) {
          thinkingBuffer += thinking;
          continue;
        }
        // 非 delta 事件 = 思考块边界（含 {"type":"thinking","subtype":"completed"}），
        // 把缓冲的整块一次性发出。多个思考块（想→说→再想）各自成块。
        if (thinkingBuffer) {
          yield {
            type: 'system_info',
            catId: this.catId,
            content: JSON.stringify({ type: 'thinking', catId: this.catId, text: thinkingBuffer }),
            metadata,
            timestamp: Date.now(),
          };
          thinkingBuffer = '';
        }

        if (event.type === 'assistant') {
          const text = readAssistantText(event);
          if (!text) continue;
          if (isAssistantDelta(event)) {
            sawAssistantDelta = true;
            yield { type: 'text', catId: this.catId, content: text, metadata, timestamp: Date.now() };
          } else if (!sawAssistantDelta) {
            // 没有流式增量时(如未启用 partial)，最终快照兜底整段输出。
            yield { type: 'text', catId: this.catId, content: text, metadata, timestamp: Date.now() };
          }
          continue;
        }

        if (event.type === 'result') {
          const usage = readResultUsage(event as CursorStreamEvent);
          if (usage) metadata.usage = mergeTokenUsage(metadata.usage, usage);
          const errText = readResultError(event as CursorStreamEvent);
          if (errText) {
            yield { type: 'error', catId: this.catId, error: errText, metadata, timestamp: Date.now() };
          }
        }
      }

      // 流意外收尾（无 completed/后续事件）时不丢已缓冲的思考内容
      if (thinkingBuffer) {
        yield {
          type: 'system_info',
          catId: this.catId,
          content: JSON.stringify({ type: 'thinking', catId: this.catId, text: thinkingBuffer }),
          metadata,
          timestamp: Date.now(),
        };
        thinkingBuffer = '';
      }

      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } catch (err) {
      yield {
        type: 'error',
        catId: this.catId,
        error: err instanceof Error ? err.message : String(err),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    }
  }
}
