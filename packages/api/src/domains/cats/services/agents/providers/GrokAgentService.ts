import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { type CatId, createCatId } from '@cat-cafe/shared';
import { getCatModel } from '../../../../../config/cat-models.js';
import { formatCliExitError } from '../../../../../utils/cli-format.js';
import { formatCliNotFoundError, resolveCliCommand } from '../../../../../utils/cli-resolve.js';
import {
  archiveRawEvent,
  buildChildEnv,
  isCliError,
  isCliTimeout,
  isLivenessWarning,
  spawnCli,
} from '../../../../../utils/cli-spawn.js';
import type { SpawnFn } from '../../../../../utils/cli-types.js';
import type { AgentMessage, AgentService, AgentServiceOptions, MessageMetadata } from '../../types.js';
import { resolveDefaultClaudeMcpServerPath } from './ClaudeAgentService.js';
import { transformGrokEvent } from './grok-event-transform.js';

interface GrokAgentServiceOptions {
  catId?: CatId;
  model?: string;
  spawnFn?: SpawnFn;
  cliCommand?: string;
  mcpServerPath?: string;
  grokHome?: string;
}

function buildPrompt(prompt: string, systemPrompt?: string): string {
  return systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${prompt}` : prompt;
}

const SENSITIVE_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

const GROK_MCP_BRIDGE_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'ComSpec',
  'PATHEXT',
  'ALLOWED_WORKSPACE_DIRS',
  'CLOWDER_CLI_PATH',
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CLOWDER_API_BEARER_TOKEN',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_THREAD_ID',
  'CAT_CAFE_CURRENT_MESSAGE_ID',
  'CAT_CAFE_SIGNAL_USER',
  'CAT_CAFE_DATA_DIR',
  'CAT_CAFE_READONLY',
  'CAT_CAFE_CALLBACK_OUTBOX_DIR',
  'CAT_CAFE_CALLBACK_OUTBOX_ENABLED',
  'CAT_CAFE_CALLBACK_OUTBOX_MAX_ATTEMPTS',
  'CAT_CAFE_CALLBACK_OUTBOX_MAX_FLUSH_BATCH',
  'CAT_CAFE_CALLBACK_RETRY_DELAYS_MS',
  'CAT_CAFE_PERSONAL_SKILLS_ENABLED',
  'CAT_CAFE_PERSONAL_SKILL_INDEX_PATH',
  'CAT_CAFE_PERSONAL_SKILL_ROOTS',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES',
  'CAT_CAFE_SKILL_MANIFEST_PATH',
] as const;

interface GrokNativeMcpHome {
  path: string;
  authPath: string;
}

function toTomlString(value: string): string {
  return JSON.stringify(value);
}

function buildMcpBridgeSource(): string {
  return `import { spawn } from 'node:child_process';

const serverPath = process.argv[2];
const allowedKeys = ${JSON.stringify(GROK_MCP_BRIDGE_ENV_KEYS)};
const env = {};
for (const key of allowedKeys) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}

const child = spawn(process.execPath, [serverPath], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`;
}

function createNativeMcpHome(options: {
  mcpServerPath: string;
  sourceGrokHome: string;
  profileMode?: string;
}): GrokNativeMcpHome {
  const runtimeHome = mkdtempSync(join(tmpdir(), 'cat-cafe-grok-'));
  try {
    const bridgePath = join(runtimeHome, 'cat-cafe-mcp-bridge.mjs');
    writeFileSync(bridgePath, buildMcpBridgeSource(), { encoding: 'utf8', mode: 0o600 });

    const config = `[compat.claude]
mcps = false

[compat.cursor]
mcps = false

[mcp_servers.cat-cafe-clowder-runtime]
command = ${toTomlString(process.execPath)}
args = [${toTomlString(bridgePath)}, ${toTomlString(options.mcpServerPath)}]
enabled = true
startup_timeout_sec = 30
`;
    writeFileSync(join(runtimeHome, 'config.toml'), config, { encoding: 'utf8', mode: 0o600 });

    const sourceSessions = join(options.sourceGrokHome, 'sessions');
    mkdirSync(sourceSessions, { recursive: true, mode: 0o700 });
    symlinkSync(sourceSessions, join(runtimeHome, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');

    const configuredAuthPath = process.env.GROK_AUTH_PATH?.trim();
    const subscriptionAuthPath = configuredAuthPath || join(options.sourceGrokHome, 'auth.json');
    return {
      path: runtimeHome,
      authPath: options.profileMode === 'subscription' ? subscriptionAuthPath : join(runtimeHome, 'auth.json'),
    };
  } catch (error) {
    rmSync(runtimeHome, { recursive: true, force: true });
    throw error;
  }
}

function redactSensitiveEnvValues(message: string, env: NodeJS.ProcessEnv): string {
  let redacted = message;
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_NAME.test(name) || !value) continue;
    redacted = redacted.replaceAll(value, '<redacted>');
  }
  return redacted;
}

export class GrokAgentService implements AgentService {
  readonly catId: CatId;
  private readonly model: string;
  private readonly spawnFn: SpawnFn | undefined;
  private readonly cliCommand: string;
  private readonly mcpServerPath: string | undefined;
  private readonly sourceGrokHome: string;

  constructor(options?: GrokAgentServiceOptions) {
    this.catId = options?.catId ?? createCatId('grok');
    this.model = options?.model ?? getCatModel(this.catId as string);
    this.spawnFn = options?.spawnFn;
    this.cliCommand = options?.cliCommand ?? 'grok';
    const configuredMcpPath = options?.mcpServerPath ?? process.env.CAT_CAFE_MCP_SERVER_PATH;
    this.mcpServerPath = configuredMcpPath
      ? isAbsolute(configuredMcpPath)
        ? configuredMcpPath
        : resolve(process.cwd(), configuredMcpPath)
      : resolveDefaultClaudeMcpServerPath();
    this.sourceGrokHome = options?.grokHome ?? process.env.GROK_HOME ?? join(homedir(), '.grok');
  }

  async *invoke(prompt: string, options?: AgentServiceOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = { provider: 'grok', model: this.model };
    const command = resolveCliCommand(this.cliCommand);
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

    const args = [
      '-p',
      buildPrompt(prompt, options?.systemPrompt),
      '--output-format',
      'streaming-json',
      '--model',
      this.model,
      // Keep unlisted side-effect tools behind the permission gate; explicit allow rules below stay headless-safe.
      '--permission-mode',
      'default',
      // The isolated GROK_HOME exposes only Cat Cafe's MCP server; approve that namespace explicitly.
      '--allow',
      'MCPTool(cat-cafe-clowder-runtime__*)',
      // Grok names the runtime tool `run_terminal_command`, but permission rules use the Bash alias.
      '--allow',
      'Bash',
      // Structured workspace edits are core engineering actions. Keep them explicit so unknown tools stay gated.
      '--allow',
      'Write',
      '--allow',
      'Edit',
    ];
    if (options?.sessionId) {
      args.push('--resume', options.sessionId);
      metadata.sessionId = options.sessionId;
      yield {
        type: 'session_init',
        catId: this.catId,
        sessionId: options.sessionId,
        metadata: { ...metadata },
        timestamp: Date.now(),
      };
    }

    for (const value of options?.cliConfigArgs ?? []) {
      args.push(...value.trim().split(/\s+/).filter(Boolean));
    }

    const profileMode = options?.callbackEnv?.CAT_CAFE_GROK_PROFILE_MODE;
    const hasCallbackCredentials = Boolean(
      options?.callbackEnv?.CAT_CAFE_INVOCATION_ID && options.callbackEnv.CAT_CAFE_CALLBACK_TOKEN,
    );
    let nativeMcpHome: GrokNativeMcpHome | undefined;
    if (this.mcpServerPath && hasCallbackCredentials) {
      try {
        nativeMcpHome = createNativeMcpHome({
          mcpServerPath: this.mcpServerPath,
          sourceGrokHome: this.sourceGrokHome,
          profileMode,
        });
      } catch (error) {
        yield {
          type: 'error',
          catId: this.catId,
          error: `Grok MCP runtime setup failed: ${error instanceof Error ? error.message : String(error)}`,
          metadata,
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
        return;
      }
    }
    const env: Record<string, string | null> = {
      ...(options?.callbackEnv ?? {}),
      ...(options?.accountEnv ?? {}),
      ...(profileMode === 'subscription' ? { XAI_API_KEY: null } : {}),
      ...(nativeMcpHome ? { GROK_HOME: nativeMcpHome.path, GROK_AUTH_PATH: nativeMcpHome.authPath } : {}),
    };
    const childEnv = buildChildEnv(env);
    const cliOptions = {
      command,
      args,
      ...(options?.workingDirectory ? { cwd: options.workingDirectory } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.invocationId ? { invocationId: options.invocationId } : {}),
      ...(options?.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
      ...(options?.livenessProbe ? { livenessProbe: options.livenessProbe } : {}),
      ...(options?.parentSpan ? { parentSpan: options.parentSpan } : {}),
    };

    let thought = '';
    let emittedSession = Boolean(options?.sessionId);
    let terminalErrorCode: string | undefined;
    const flushThought = (): AgentMessage | null => {
      if (!thought) return null;
      const message: AgentMessage = {
        type: 'system_info',
        catId: this.catId,
        content: JSON.stringify({ type: 'thinking', catId: this.catId, text: thought }),
        metadata,
        timestamp: Date.now(),
      };
      thought = '';
      return message;
    };

    try {
      const events = options?.spawnCliOverride
        ? options.spawnCliOverride(cliOptions)
        : spawnCli(cliOptions, this.spawnFn ? { spawnFn: this.spawnFn } : undefined);
      for await (const rawEvent of events) {
        // 原始事件归档：grok 是目前唯一零归档的 CLI provider——一旦启用出问题
        // （如工具事件形态未知、transformGrokEvent 落 unknown 被丢）无从取证。
        archiveRawEvent(options?.invocationId, rawEvent);
        if (isCliTimeout(rawEvent)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: `Grok CLI 响应超时 (${Math.round(rawEvent.timeoutMs / 1000)}s)`,
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (isLivenessWarning(rawEvent)) continue;
        if (isCliError(rawEvent)) {
          yield {
            type: 'error',
            catId: this.catId,
            error: formatCliExitError('Grok CLI', rawEvent),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }

        const event = transformGrokEvent(rawEvent);
        if (event.kind === 'thought') {
          thought += event.data;
          continue;
        }
        if (event.kind === 'text') {
          const thinkingMessage = flushThought();
          if (thinkingMessage) yield thinkingMessage;
          if (event.data) {
            yield {
              type: 'text',
              catId: this.catId,
              content: event.data,
              metadata,
              timestamp: Date.now(),
            };
          }
          continue;
        }
        if (event.kind === 'error') {
          const message = event.message.trim() || 'Grok CLI reported an error';
          yield {
            type: 'error',
            catId: this.catId,
            error: redactSensitiveEnvValues(message, childEnv),
            metadata,
            timestamp: Date.now(),
          };
          continue;
        }
        if (event.kind === 'end') {
          const thinkingMessage = flushThought();
          if (thinkingMessage) yield thinkingMessage;
          const stopReason = event.stopReason?.trim().toLowerCase();
          if (stopReason?.includes('cancel') && !options?.signal?.aborted && !terminalErrorCode) {
            terminalErrorCode = 'permission_cancelled';
            yield {
              type: 'error',
              catId: this.catId,
              error: 'Grok 工具权限未获批准或确认超时，本轮未完成；此前文本可能不完整。',
              errorCode: terminalErrorCode,
              metadata,
              timestamp: Date.now(),
            };
          }
          if (event.sessionId) {
            metadata.sessionId = event.sessionId;
            if (!emittedSession) {
              emittedSession = true;
              yield {
                type: 'session_init',
                catId: this.catId,
                sessionId: event.sessionId,
                metadata: { ...metadata },
                timestamp: Date.now(),
              };
            }
          }
        }
      }
      const thinkingMessage = flushThought();
      if (thinkingMessage) yield thinkingMessage;
      yield {
        type: 'done',
        catId: this.catId,
        ...(terminalErrorCode ? { errorCode: terminalErrorCode } : {}),
        metadata,
        timestamp: Date.now(),
      };
    } catch (error) {
      yield {
        type: 'error',
        catId: this.catId,
        error: error instanceof Error ? error.message : String(error),
        metadata,
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: this.catId, metadata, timestamp: Date.now() };
    } finally {
      if (nativeMcpHome) rmSync(nativeMcpHome.path, { recursive: true, force: true });
    }
  }
}
