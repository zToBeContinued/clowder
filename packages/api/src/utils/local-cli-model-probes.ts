import { readFile as readFileFs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';

export type LocalCliModelSource = 'cli' | 'config' | 'static';
export type LocalCliModelsStatus = 'ok' | 'config_only' | 'static_only' | 'failed' | 'unsupported';

export interface LocalCliModelCandidate {
  readonly id: string;
  readonly source: LocalCliModelSource;
  readonly isDefault?: boolean;
}

export interface LocalCliModelCommandProbe {
  readonly args: readonly string[];
  readonly parse: (output: string) => string[];
  /** 解析哪条输出流，默认 stdout。部分 CLI 把模型目录写在 stderr 的参数校验报错里。 */
  readonly stream?: 'stdout' | 'stderr' | 'merged';
  /** 允许非零退出码：命令以失败告终，但输出仍包含可解析的模型目录。 */
  readonly allowNonZeroExit?: boolean;
}

export interface LocalCliModelsProbeDefinition {
  readonly command?: LocalCliModelCommandProbe;
  /**
   * 只用于探测本机默认模型的附加命令；返回列表的第一项被当作默认模型。
   * 适用于 CLI 把「可用目录」和「当前默认」放在两个不同命令里的情况。
   */
  readonly defaultModelCommand?: LocalCliModelCommandProbe;
  readonly configFile?: { readonly path: string; readonly extract: (content: string) => string[] };
  readonly static?: readonly string[];
  /** The command parser deliberately returns the active default model first. */
  readonly firstResultIsDefault?: boolean;
}

export interface ModelChainOptions {
  readonly installed: boolean;
  readonly resolvedPath?: string;
  readonly defaultModel?: string;
  readonly modelsProbe?: LocalCliModelsProbeDefinition;
  readonly homeDir?: string;
  readonly runCommand: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  readonly readFile?: (path: string) => Promise<string>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are the intended input.
const ANSI_PATTERN = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CREDENTIAL_FILE_PATTERN = /(auth|credential|token|key)/i;
const SECRET_PATTERN = /\bsk_(?:agent|machine|proj|live|test)_[A-Za-z0-9_-]+/g;

export function redactProbeOutput(value: string): string {
  return value.replace(SECRET_PATTERN, (match) => {
    const prefix = match.split('_').slice(0, 2).join('_');
    return `${prefix}_<redacted>`;
  });
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function uniqueModelIds(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = stripAnsi(raw).trim().slice(0, 256);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseLineModelCatalog(stdout: string): string[] {
  return uniqueModelIds(stdout.split(/\r?\n/));
}

export function parseGrokModelCatalog(stdout: string): string[] {
  const models: string[] = [];
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^[*-]\s+([^\s]+)(?:\s+\(default\))?$/);
    if (match?.[1]) models.push(match[1]);
  }
  return uniqueModelIds(models);
}

export function parseCodexModelCatalog(content: string): string[] {
  const parsed = parseJsonObject(content);
  if (!parsed || !Array.isArray(parsed.models)) return [];
  return uniqueModelIds(
    parsed.models.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const model = item as Record<string, unknown>;
      return typeof model.slug === 'string' && model.visibility !== 'hide' ? [model.slug] : [];
    }),
  );
}

export function extractJsonModelFields(content: string): string[] {
  const parsed = parseJsonObject(content);
  if (!parsed) return [];
  const models: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'model' && typeof nested === 'string') models.push(nested);
      else visit(nested);
    }
  };
  visit(parsed);
  return uniqueModelIds(models);
}

/**
 * 用于向 Kiro CLI 索取模型目录的哨兵模型名：一定不存在，因此 CLI 在参数校验阶段
 * 就会失败并把完整目录写进 stderr，不会发起任何对话请求。
 */
export const KIRO_MODEL_PROBE_SENTINEL = 'clowder-model-probe-invalid';

/**
 * `kiro-cli chat --model <哨兵>` 的兜底目录快照。L1 命令探测成功时会被真实目录覆盖，
 * 命令不可用（未安装 / CLI 改了报错格式）时才用这份。
 * settings 只记录被用户显式改过的模型，因此不能当作目录使用。
 */
export const KIRO_MODEL_CATALOG = [
  'auto',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-opus-4.8',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-opus-4.5',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-haiku-4.5',
  'deepseek-3.2',
  'minimax-m2.5',
  'minimax-m2.1',
  'glm-5',
  'qwen3-coder-next',
] as const;

/**
 * 从 `kiro-cli chat --model <哨兵>` 的报错里提取 "Available models: a, b, c"。
 * 只取该标记之后的同一行，去掉所有空白后按逗号切分（模型 ID 不含空白）。
 */
export function parseKiroAvailableModels(output: string): string[] {
  const match = stripAnsi(output).match(/available models:(.*)/i);
  if (!match?.[1]) return [];
  return uniqueModelIds(match[1].replace(/\s+/g, '').replace(/\.$/, '').split(','));
}

/**
 * Parse the safe `kiro-cli settings list --format json` response.
 * Deliberately ignores every root except `chat`, and inside `chat` only reads
 * `defaultModel` plus explicit IDs under `modelDefaults`.
 *
 * 结果只用于确定本机默认模型（首项为 `chat.defaultModel`），不代表可用目录。
 */
export function parseKiroSettingsModels(content: string): string[] {
  const parsed = parseJsonObject(content);
  const chat = parsed ? kiroChatSettings(parsed) : null;
  if (!chat) return [];

  const models: string[] = typeof chat.defaultModel === 'string' ? [chat.defaultModel] : [];
  const defaults = chat.modelDefaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    for (const [key, value] of Object.entries(defaults as Record<string, unknown>)) {
      if (looksLikeModelId(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        models.push(key);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      for (const field of ['modelId', 'model', 'id'] as const) {
        if (typeof entry[field] === 'string') models.push(entry[field]);
      }
    }
  }
  return uniqueModelIds(models);
}

/**
 * 取出 settings 里的 chat 段。kiro-cli 2.14 输出的是扁平点号键
 * （`{"chat.defaultModel": "...", "chat.modelDefaults": {...}}`），
 * 这里同时兼容扁平与嵌套两种形状，且只读取 chat 前缀，其余根键一律忽略。
 */
function kiroChatSettings(parsed: Record<string, unknown>): Record<string, unknown> | null {
  if (parsed.chat && typeof parsed.chat === 'object' && !Array.isArray(parsed.chat)) {
    return parsed.chat as Record<string, unknown>;
  }
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith('chat.')) flattened[key.slice('chat.'.length)] = value;
  }
  return Object.keys(flattened).length > 0 ? flattened : null;
}

function looksLikeModelId(value: string): boolean {
  return value.length <= 256 && !/\s/.test(value) && /[-/:.]/.test(value);
}

export function extractOpenCodeConfigModels(content: string): string[] {
  const parsed = parseJsonObject(content);
  if (!parsed) return [];
  const models: string[] = typeof parsed.model === 'string' ? [parsed.model] : [];
  if (parsed.provider && typeof parsed.provider === 'object' && !Array.isArray(parsed.provider)) {
    for (const [providerId, value] of Object.entries(parsed.provider as Record<string, unknown>)) {
      models.push(...extractOpenCodeProviderModels(providerId, value));
    }
  }
  return uniqueModelIds(models);
}

function extractOpenCodeProviderModels(providerId: string, value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const providerModels = (value as Record<string, unknown>).models;
  if (!providerModels || typeof providerModels !== 'object' || Array.isArray(providerModels)) return [];
  return Object.keys(providerModels as Record<string, unknown>).map((modelId) => `${providerId}/${modelId}`);
}

export function extractKimiConfigModels(content: string): string[] {
  try {
    const parsed = parseToml(content) as Record<string, unknown>;
    const models: string[] = typeof parsed.default_model === 'string' ? [parsed.default_model] : [];
    if (parsed.models && typeof parsed.models === 'object' && !Array.isArray(parsed.models)) {
      models.push(...Object.keys(parsed.models as Record<string, unknown>));
    }
    return uniqueModelIds(models);
  } catch {
    return [];
  }
}

export function parseCursorModelCatalog(stdout: string): string[] {
  const models: string[] = [];
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === 'Available models' || line.startsWith('Tip:') || /authentication required/i.test(line))
      continue;
    const separator = line.indexOf(' - ');
    if (separator > 0) models.push(line.slice(0, separator));
  }
  return uniqueModelIds(models);
}

export const LOCAL_CLI_MODELS_PROBES = {
  // Claude Code 2.1.203 has no non-interactive model-list command; settings.json is the safe L2 source.
  claude: {
    configFile: { path: '~/.claude/settings.json', extract: extractJsonModelFields },
    static: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-4-7', 'claude-opus-4-6'],
  },
  // Codex 0.144.0 exposes debug models --bundled, but its ~287KB output exceeds the shared 16KB safety cap.
  // L1 is still attempted; normal execution therefore falls through to the explicit, non-credential model cache.
  codex: {
    command: { args: ['debug', 'models', '--bundled'], parse: parseCodexModelCatalog },
    configFile: { path: '~/.codex/models_cache.json', extract: parseCodexModelCatalog },
    static: [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ],
  },
  // Gemini CLI 0.28.2 has no list-models command and the local settings file may contain no model field.
  gemini: {
    configFile: { path: '~/.gemini/settings.json', extract: extractJsonModelFields },
    static: [
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite',
      'gemini-3-flash-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ],
  },
  // Kiro CLI 没有 models 命令，但 --model 的参数校验发生在任何网络请求之前：
  // 传哨兵模型名即可让它在 stderr 里列出完整目录并以退出码 1 结束。
  // 默认模型另由只读的 settings 命令提供。
  kiro: {
    command: {
      args: ['chat', '--model', KIRO_MODEL_PROBE_SENTINEL, '--no-interactive', '.'],
      parse: parseKiroAvailableModels,
      stream: 'stderr',
      allowNonZeroExit: true,
    },
    defaultModelCommand: { args: ['settings', 'list', '--format', 'json'], parse: parseKiroSettingsModels },
    static: KIRO_MODEL_CATALOG,
  },
  // OpenCode 1.15.13: models --pure is non-interactive and prints one provider/model id per line.
  opencode: {
    command: { args: ['models', '--pure'], parse: parseLineModelCatalog },
    configFile: { path: '~/.config/opencode/opencode.json', extract: extractOpenCodeConfigModels },
    static: ['xiaomi-mimo/mimo-v2.5-pro'],
  },
  // Kimi CLI 1.48.0 has no models command; config.toml exposes default_model and the models table.
  kimi: {
    configFile: { path: '~/.kimi/config.toml', extract: extractKimiConfigModels },
    static: ['kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed'],
  },
  // Grok CLI 0.2.93 prints a human-readable catalog with one bullet per model.
  grok: {
    command: { args: ['models'], parse: parseGrokModelCatalog },
    static: ['grok-4.5', 'grok-composer-2.5-fast'],
  },
  // Cursor Agent 2026.07.01 has an account-scoped, non-interactive models command; unauthenticated runs fail cleanly.
  cursor: {
    command: { args: ['models'], parse: parseCursorModelCatalog },
    configFile: { path: '~/.cursor/cli-config.json', extract: extractJsonModelFields },
    static: [],
  },
  // OpenCLI 1.8.4 has no generic agent-model catalog; app adapters may launch UI and are intentionally unsupported.
  opencli: { static: [] },
} as const satisfies Record<string, LocalCliModelsProbeDefinition>;

function resolveExplicitConfigPath(rawPath: string, homeDir: string): string {
  const normalizedRaw = normalize(rawPath);
  if (rawPath.split(/[\\/]/).includes('..') || normalizedRaw.split(sep).includes('..')) {
    throw new Error('model config path traversal is not allowed');
  }
  if (CREDENTIAL_FILE_PATTERN.test(basename(rawPath))) {
    throw new Error('credential-shaped model config filename is not allowed');
  }
  if (rawPath === '~') return homeDir;
  if (rawPath.startsWith('~/')) return join(homeDir, rawPath.slice(2));
  if (isAbsolute(rawPath)) return rawPath;
  throw new Error('model config path must be absolute or home-relative');
}

function candidates(
  ids: readonly string[],
  source: LocalCliModelSource,
  defaultModel?: string,
): LocalCliModelCandidate[] {
  return uniqueModelIds(ids).map((id) => ({
    id,
    source,
    ...(id === defaultModel ? { isDefault: true } : {}),
  }));
}

interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * 非零退出码时 promisify(execFile) 会 reject，但把已收集的输出挂在 error 上。
 * 只有声明了 allowNonZeroExit 的探测才会读取这里。
 */
function commandOutputFromError(error: unknown): CommandOutput | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { stdout?: unknown; stderr?: unknown };
  const stdout = typeof candidate.stdout === 'string' ? candidate.stdout : '';
  const stderr = typeof candidate.stderr === 'string' ? candidate.stderr : '';
  if (!stdout && !stderr) return null;
  return { stdout, stderr };
}

function selectStream(output: CommandOutput, stream: LocalCliModelCommandProbe['stream']): string {
  if (stream === 'stderr') return output.stderr;
  if (stream === 'merged') return `${output.stdout}\n${output.stderr}`;
  return output.stdout;
}

async function runModelCommand(options: ModelChainOptions, command: LocalCliModelCommandProbe): Promise<string[]> {
  if (!options.installed || !options.resolvedPath) return [];
  let output: CommandOutput | null = null;
  try {
    output = await options.runCommand(options.resolvedPath, command.args);
  } catch (error) {
    // A timeout, buffer cap, or auth failure normally ends the chain here.
    if (!command.allowNonZeroExit) return [];
    output = commandOutputFromError(error);
  }
  if (!output) return [];
  try {
    return command.parse(redactProbeOutput(selectStream(output, command.stream)));
  } catch {
    return [];
  }
}

export async function probeLocalCliModels(
  options: ModelChainOptions,
): Promise<{ models: LocalCliModelCandidate[]; modelsStatus: LocalCliModelsStatus }> {
  const probe = options.modelsProbe;
  if (!probe) return { models: [], modelsStatus: 'unsupported' };

  const detectedDefault = probe.defaultModelCommand
    ? (await runModelCommand(options, probe.defaultModelCommand))[0]
    : undefined;
  const defaultModel = options.defaultModel ?? detectedDefault;

  const commandModels = await probeCommandModels(options, probe, defaultModel);
  if (commandModels.length > 0) return { models: commandModels, modelsStatus: 'ok' };

  const configModels = await probeConfigModels(options, probe, defaultModel);
  if (configModels.length > 0) return { models: configModels, modelsStatus: 'config_only' };

  if (probe.static && probe.static.length > 0) {
    return { models: candidates(probe.static, 'static', defaultModel), modelsStatus: 'static_only' };
  }
  const hasProbeLayer = Boolean(probe.command || probe.configFile);
  return { models: [], modelsStatus: hasProbeLayer ? 'failed' : 'unsupported' };
}

async function probeCommandModels(
  options: ModelChainOptions,
  probe: LocalCliModelsProbeDefinition,
  defaultModel?: string,
): Promise<LocalCliModelCandidate[]> {
  if (!probe.command) return [];
  const ids = await runModelCommand(options, probe.command);
  if (ids.length === 0) return [];
  return candidates(ids, 'cli', defaultModel ?? (probe.firstResultIsDefault ? ids[0] : undefined));
}

async function probeConfigModels(
  options: ModelChainOptions,
  probe: LocalCliModelsProbeDefinition,
  defaultModel?: string,
): Promise<LocalCliModelCandidate[]> {
  if (!probe.configFile || !options.installed) return [];
  try {
    const path = resolveExplicitConfigPath(probe.configFile.path, options.homeDir ?? homedir());
    const content = await (options.readFile ?? ((value) => readFileFs(value, 'utf8')))(path);
    return candidates(probe.configFile.extract(redactProbeOutput(content)), 'config', defaultModel);
  } catch {
    // Includes explicit rejection of sensitive or traversing paths, then falls through to L3.
    return [];
  }
}
