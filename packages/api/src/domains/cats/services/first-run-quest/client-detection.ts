/**
 * F171: Detect which agent CLI clients are installed on the user's machine.
 * Only returns clients that are actually available for binding.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCliCommand } from '../../../../utils/cli-resolve.js';
import { resolveWindowsShimSpawn } from '../../../../utils/cli-spawn-win.js';

const execFileAsync = promisify(execFile);

export interface DetectedClient {
  /** Client ID — the CLI tool identity. */
  client: 'claude' | 'codex' | 'gemini' | 'kiro' | 'opencode' | 'dare' | 'kimi' | 'grok' | 'cursor';
  /** Provider key matching ClientValue in hub-cat-editor (anthropic, openai, etc.) */
  provider: 'anthropic' | 'openai' | 'google' | 'kiro' | 'opencode' | 'dare' | 'kimi' | 'xai' | 'cursor';
  /** Human-readable label */
  label: string;
  /** CLI binary name */
  cli: string;
  /** Whether the CLI binary is found in PATH */
  installed: boolean;
  /** CLI version string if installed */
  version?: string;
  /** Whether an API key env var is set for this provider */
  hasApiKey: boolean;
}

interface CliSpec {
  client: DetectedClient['client'];
  provider: DetectedClient['provider'];
  label: string;
  cli: string;
  versionArgs: readonly string[];
  envKey: string;
}

export interface ClientDetectionOptions {
  resolveCommand?: (command: string) => string | null;
  runCommand?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

const CLI_SPECS: CliSpec[] = [
  {
    client: 'claude',
    provider: 'anthropic',
    label: 'Claude',
    cli: 'claude',
    versionArgs: ['--version'],
    envKey: 'ANTHROPIC_API_KEY',
  },
  {
    client: 'codex',
    provider: 'openai',
    label: 'Codex',
    cli: 'codex',
    versionArgs: ['--version'],
    envKey: 'OPENAI_API_KEY',
  },
  {
    client: 'opencode',
    provider: 'opencode',
    label: 'OpenCode',
    cli: 'opencode',
    versionArgs: ['version'],
    envKey: 'ANTHROPIC_API_KEY',
  },
  {
    client: 'gemini',
    provider: 'google',
    label: 'Gemini',
    cli: 'gemini',
    versionArgs: ['--version'],
    envKey: 'GOOGLE_API_KEY',
  },
  {
    client: 'kiro',
    provider: 'kiro',
    label: 'Kiro',
    cli: 'kiro-cli',
    versionArgs: ['--version'],
    envKey: '',
  },
  { client: 'dare', provider: 'dare', label: 'Dare', cli: 'dare', versionArgs: ['--version'], envKey: '' },
  {
    client: 'kimi',
    provider: 'kimi',
    label: 'Kimi',
    cli: 'kimi',
    versionArgs: ['--version'],
    envKey: 'MOONSHOT_API_KEY',
  },
  {
    client: 'grok',
    provider: 'xai',
    label: 'Grok',
    cli: 'grok',
    versionArgs: ['--version'],
    envKey: 'XAI_API_KEY',
  },
  {
    client: 'cursor',
    provider: 'cursor',
    label: 'Cursor',
    cli: 'cursor-agent',
    versionArgs: ['--version'],
    envKey: 'CURSOR_API_KEY',
  },
];

/**
 * Windows 上把 --version 探测命令解析为可执行形态：
 * - 标准 npm .cmd shim → 解析出底层 .js/.exe 入口（resolveWindowsShimSpawn）；
 * - 非标准 .cmd（如 cursor-agent.cmd 是 powershell 包装器，parseShimFile 解析不了）→ 用 `cmd /c` 直跑；
 * - .ps1（部分 CLI 直接以 .ps1 暴露）→ 用 powershell -File 跑。
 */
function resolveVersionSpawn(
  resolvedCommand: string,
  versionArgs: readonly string[],
): { command: string; args: string[] } | null {
  if (process.platform !== 'win32') return { command: resolvedCommand, args: [...versionArgs] };
  if (/\.cmd$/i.test(resolvedCommand)) {
    const shim = resolveWindowsShimSpawn(resolvedCommand, versionArgs);
    if (shim) return shim;
    return { command: 'cmd', args: ['/c', resolvedCommand, ...versionArgs] };
  }
  if (/\.ps1$/i.test(resolvedCommand)) {
    return {
      command: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedCommand, ...versionArgs],
    };
  }
  return { command: resolvedCommand, args: [...versionArgs] };
}

async function checkCli(spec: CliSpec, options: ClientDetectionOptions): Promise<DetectedClient> {
  const resolveCommand = options.resolveCommand ?? resolveCliCommand;
  const runCommand =
    options.runCommand ??
    (async (file: string, args: readonly string[]) =>
      execFileAsync(file, [...args], {
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      }));
  const resolvedCommand = resolveCommand(spec.cli);
  const base = {
    client: spec.client,
    provider: spec.provider,
    label: spec.label,
    cli: spec.cli,
    hasApiKey: spec.envKey ? Boolean(process.env[spec.envKey]) : false,
  };

  if (!resolvedCommand) return { ...base, installed: false };

  try {
    const spawn = resolveVersionSpawn(resolvedCommand, spec.versionArgs);
    if (!spawn) return { ...base, installed: false };

    const { stdout } = await runCommand(spawn.command, spawn.args);
    const version = stdout.trim().split(/\r?\n/).at(0)?.slice(0, 160) ?? '';
    return {
      ...base,
      installed: true,
      version: version || undefined,
    };
  } catch {
    return { ...base, installed: false };
  }
}

/** Detect all available CLI clients in parallel. */
export async function detectAvailableClients(options: ClientDetectionOptions = {}): Promise<DetectedClient[]> {
  const results = await Promise.all(CLI_SPECS.map((spec) => checkCli(spec, options)));
  return results;
}

/** Detect one allowlisted CLI client without invoking chat, ACP, or a model prompt. */
export async function detectClient(
  client: DetectedClient['client'],
  options: ClientDetectionOptions = {},
): Promise<DetectedClient | null> {
  const spec = CLI_SPECS.find((candidate) => candidate.client === client);
  return spec ? checkCli(spec, options) : null;
}

/** Return only clients that are installed. */
export async function getInstalledClients(options: ClientDetectionOptions = {}): Promise<DetectedClient[]> {
  const all = await detectAvailableClients(options);
  return all.filter((c) => c.installed);
}
