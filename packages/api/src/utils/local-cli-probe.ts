import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCliCommand } from './cli-resolve.js';
import {
  LOCAL_CLI_MODELS_PROBES,
  type LocalCliModelCandidate,
  type LocalCliModelsProbeDefinition,
  type LocalCliModelsStatus,
  probeLocalCliModels,
  redactProbeOutput,
} from './local-cli-model-probes.js';

const execFileAsync = promisify(execFile);

export type LocalCliId = 'claude' | 'codex' | 'gemini' | 'kiro' | 'opencode' | 'kimi' | 'grok' | 'cursor' | 'opencli';

export interface LocalCliProbeDefinition {
  readonly id: LocalCliId;
  readonly label: string;
  readonly command: string;
  readonly commandAliases?: readonly string[];
  readonly clientId?: 'anthropic' | 'openai' | 'google' | 'kiro' | 'opencode' | 'kimi' | 'grok';
  readonly defaultModel?: string;
  readonly modelsProbe?: LocalCliModelsProbeDefinition;
  readonly installHint: string;
  readonly versionArgs: readonly string[];
}

export interface LocalCliProbeResult {
  readonly id: LocalCliId;
  readonly label: string;
  readonly command: string;
  readonly clientId?: LocalCliProbeDefinition['clientId'];
  readonly defaultModel?: string;
  readonly models: readonly LocalCliModelCandidate[];
  readonly modelsStatus: LocalCliModelsStatus;
  readonly installed: boolean;
  readonly resolvedPath?: string;
  readonly version?: string;
  readonly versionStatus: 'ok' | 'failed' | 'not_installed';
  readonly authStatus: 'unknown';
  readonly authStatusReason: string;
  readonly installHint: string;
}

export const LOCAL_CLI_ALLOWLIST: readonly LocalCliProbeDefinition[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    clientId: 'anthropic',
    defaultModel: 'claude-sonnet-5',
    modelsProbe: LOCAL_CLI_MODELS_PROBES.claude,
    installHint: 'npm install -g @anthropic-ai/claude-code',
    versionArgs: ['--version'],
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    clientId: 'openai',
    defaultModel: 'gpt-5.6-sol',
    modelsProbe: LOCAL_CLI_MODELS_PROBES.codex,
    installHint: 'npm install -g @openai/codex',
    versionArgs: ['--version'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    command: 'gemini',
    clientId: 'google',
    defaultModel: 'gemini-3.1-pro-preview',
    modelsProbe: LOCAL_CLI_MODELS_PROBES.gemini,
    installHint: 'npm install -g @google/gemini-cli',
    versionArgs: ['--version'],
  },
  {
    id: 'kiro',
    label: 'Kiro CLI',
    command: 'kiro-cli',
    clientId: 'kiro',
    modelsProbe: LOCAL_CLI_MODELS_PROBES.kiro,
    installHint: '按 Kiro CLI 官方安装文档安装，并确保 kiro-cli 可被后端进程访问',
    versionArgs: ['--version'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    clientId: 'opencode',
    defaultModel: 'xiaomi-mimo/mimo-v2.5-pro',
    modelsProbe: LOCAL_CLI_MODELS_PROBES.opencode,
    installHint: 'npm install -g opencode',
    versionArgs: ['--version'],
  },
  {
    id: 'kimi',
    label: 'Kimi CLI',
    command: 'kimi',
    clientId: 'kimi',
    defaultModel: 'kimi-code/kimi-for-coding',
    modelsProbe: LOCAL_CLI_MODELS_PROBES.kimi,
    installHint: 'uv tool install --python 3.13 kimi-cli',
    versionArgs: ['--version'],
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    command: 'grok',
    clientId: 'grok',
    defaultModel: 'grok-4.5',
    modelsProbe: LOCAL_CLI_MODELS_PROBES.grok,
    installHint: '按 xAI Grok CLI 官方说明安装 grok，并确保命令可被后端进程访问',
    versionArgs: ['--version'],
  },
  {
    id: 'cursor',
    label: 'Cursor CLI',
    command: 'cursor',
    commandAliases: ['cursor-agent'],
    modelsProbe: LOCAL_CLI_MODELS_PROBES.cursor,
    installHint: '在 Cursor 中启用 shell command，或安装 cursor CLI',
    versionArgs: ['--version'],
  },
  {
    id: 'opencli',
    label: 'OpenCLI',
    command: 'opencli',
    modelsProbe: LOCAL_CLI_MODELS_PROBES.opencli,
    installHint: '安装 opencli 并确保命令可被后端进程访问',
    versionArgs: ['--version'],
  },
] as const;

export interface ProbeLocalClisOptions {
  readonly definitions?: readonly LocalCliProbeDefinition[];
  readonly homeDir?: string;
  readonly resolveCommand?: (command: string) => string | null;
  readonly runCommand?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  readonly readFile?: (path: string) => Promise<string>;
}

function firstLine(value: string): string | undefined {
  const redacted = redactProbeOutput(value);
  const line = redacted
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  // Keep probe output useful but never forward large command output into UI.
  return line.slice(0, 160);
}

async function runVersionProbe(
  file: string,
  args: readonly string[],
  runCommand: NonNullable<ProbeLocalClisOptions['runCommand']>,
): Promise<Pick<LocalCliProbeResult, 'version' | 'versionStatus'>> {
  try {
    const { stdout, stderr } = await runCommand(file, args);
    return {
      version: firstLine(stdout) ?? firstLine(stderr),
      versionStatus: 'ok',
    };
  } catch {
    return { versionStatus: 'failed' };
  }
}

export async function probeLocalAgentClis(options: ProbeLocalClisOptions = {}): Promise<LocalCliProbeResult[]> {
  const definitions = options.definitions ?? LOCAL_CLI_ALLOWLIST;
  const resolveCommand = options.resolveCommand ?? resolveCliCommand;
  const runCommand =
    options.runCommand ??
    (async (file: string, args: readonly string[]) =>
      execFileAsync(file, [...args], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      }));

  const results: LocalCliProbeResult[] = [];
  for (const definition of definitions) {
    const resolvedPath = [definition.command, ...(definition.commandAliases ?? [])]
      .map((command) => resolveCommand(command))
      .find((value): value is string => Boolean(value));
    const installed = Boolean(resolvedPath);
    const version = resolvedPath
      ? await runVersionProbe(resolvedPath, definition.versionArgs, runCommand)
      : ({ versionStatus: 'not_installed' } as const);
    const modelProbe = await probeLocalCliModels({
      installed,
      resolvedPath,
      defaultModel: definition.defaultModel,
      modelsProbe: definition.modelsProbe,
      homeDir: options.homeDir,
      runCommand,
      readFile: options.readFile,
    });
    const defaultModel = definition.defaultModel ?? modelProbe.models.find((model) => model.isDefault)?.id;
    results.push({
      id: definition.id,
      label: definition.label,
      command: definition.command,
      clientId: definition.clientId,
      defaultModel,
      ...modelProbe,
      installed,
      ...(resolvedPath ? { resolvedPath } : {}),
      ...version,
      authStatus: 'unknown',
      authStatusReason: installed
        ? '安全模式：只运行只读命令并读取模型白名单配置；不读取凭证文件，认证状态由首次实际运行验证。'
        : '未安装，未执行认证探测。',
      installHint: definition.installHint,
    });
  }
  return results;
}
