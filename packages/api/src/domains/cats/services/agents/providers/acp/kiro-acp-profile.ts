import type { AcpProviderProfile } from './types.js';

export const KIRO_MCP_WHITELIST = ['cat-cafe', 'cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'] as const;

export interface KiroAcpProfileInput {
  defaultModel?: string;
  cli?: {
    command?: string;
    defaultArgs?: readonly string[];
  };
}

/** Build the process profile for the official `kiro-cli acp` carrier. */
export function createKiroAcpProfile(config: KiroAcpProfileInput): AcpProviderProfile {
  const configuredArgs = [...(config.cli?.defaultArgs ?? [])];
  const withoutEntrypoint = configuredArgs[0] === 'acp' ? configuredArgs.slice(1) : configuredArgs;
  // This deployment explicitly opts every non-interactive Kiro ACP process into
  // trust-all. Normalize the short alias and duplicates to one auditable flag.
  const extraArgs = withoutEntrypoint.filter((arg) => arg !== '--trust-all-tools' && arg !== '-a');
  const model = config.defaultModel?.trim();

  return {
    command: config.cli?.command ?? 'kiro-cli',
    startupArgs: ['acp', '--trust-all-tools', ...extraArgs],
    mcpServers: [],
    model: model || undefined,
    supportsMultiplexing: false,
  };
}
