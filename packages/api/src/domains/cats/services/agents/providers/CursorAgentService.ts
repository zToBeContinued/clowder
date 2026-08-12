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
      // 重放守卫：cursor CLI 断线重连（type:retry/subtype:resuming）后会从
      // checkpoint 重放已发送的 assistant 文本，且重放的 chunk 边界与原发不同
      //（原始归档实证：同一句话原发是一整条事件、重放被拆成多个小片）。若不
      // 拦截，消息中段会出现整块内容 ×2。窗口规则：resuming 后的增量若完整
      // 存在于已发正文中则视为重放吞掉；遇到新内容、或吞掉量超过已发全文长度
      //（重放不可能超过它）即退出窗口。
      let emittedAssistantText = '';
      let replayGuard = false;
      let replaySwallowed = 0;
      let replayBudget = 0;
      // 调用级汇总去重：cursor-agent 2026.08+ 在每个 model call 结束时会把该
      // call 的**累计全文**作为一条带 model_call_id 的 assistant 事件重发一遍
      //（同样带 timestamp_ms，会被当成增量追加 → 整段重复；原始归档实证：
      // 无 ID 增量「两处落库完成，提交。」之后 4.7s 再来一条同文带 ID 事件，
      // 而 CLI 自己的 result 里只有一次）。规则：该 call 已有无 ID 增量流出
      // 时跳过汇总（含同 callId 的分片）；纯汇总模式（整个 call 没有任何
      // 增量）才作为文本输出，不丢内容。
      let sawDeltaInCurrentCall = false;
      let skippedSummaryCallId: string | undefined;

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

        // 断线重连事件：进入重放甄别窗口（放在 thinking flush 之前，重连不算
        // 思考块边界——思考没有结束，只是传输断了）。
        if (event.type === 'retry' || event.type === 'connection') {
          if (event.subtype === 'resuming' && emittedAssistantText) {
            replayGuard = true;
            replaySwallowed = 0;
            replayBudget = emittedAssistantText.length;
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
            const callId = typeof event.model_call_id === 'string' && event.model_call_id ? event.model_call_id : null;
            if (callId) {
              if (sawDeltaInCurrentCall || skippedSummaryCallId === callId) {
                // 调用级累计汇总（或其分片）：内容已以无 ID 增量流出，跳过防整段重复
                skippedSummaryCallId = callId;
                sawDeltaInCurrentCall = false;
                continue;
              }
              // 纯汇总模式：本 call 没有任何增量，汇总即唯一内容 → 正常输出
            } else {
              sawDeltaInCurrentCall = true;
              skippedSummaryCallId = undefined;
            }
            sawAssistantDelta = true;
            if (replayGuard) {
              if (emittedAssistantText.includes(text) && replaySwallowed + text.length <= replayBudget) {
                replaySwallowed += text.length;
                continue;
              }
              // 出现新内容（或超出重放预算）→ 重放结束，恢复正常透传
              replayGuard = false;
              if (replaySwallowed > 0) {
                log.info(
                  { catId: this.catId, invocationId: options?.invocationId, swallowedChars: replaySwallowed },
                  '[CursorAgent] 已吞掉断线重连后的重放文本',
                );
              }
            }
            emittedAssistantText += text;
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
