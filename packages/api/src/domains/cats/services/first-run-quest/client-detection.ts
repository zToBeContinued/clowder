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
  client: 'claude' | 'codex' | 'gemini' | 'kiro' | 'opencode' | 'dare' | 'kimi' | 'grok';
  /** Provider key matching ClientValue in hub-cat-editor (anthropic, openai, etc.) */
  provider: 'anthropic' | 'openai' | 'google' | 'kiro' | 'opencode' | 'dare' | 'kimi' | 'xai';
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
];

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
    const spawn =
      process.platform === 'win32' && /\.cmd$/i.test(resolvedCommand)
        ? resolveWindowsShimSpawn(resolvedCommand, spec.versionArgs)
        : { command: resolvedCommand, args: [...spec.versionArgs] };
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
