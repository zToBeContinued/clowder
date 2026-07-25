import type { CliEffortValue } from '@cat-cafe/shared';
import type { AcpProviderProfile } from './types.js';

/**
 * MCP servers offered to every Kiro ACP session.
 *
 * `cat-cafe*` are built-in and auto-resolved from projectRoot. `codegraph` is an
 * external entry read from projectRoot/.mcp.json — it lets cats answer structural
 * questions from an index instead of reading whole files into context, which is the
 * main driver of Kiro's ContextWindowOverflow. Projects without a `.codegraph/`
 * index simply get a "not indexed" reply, so listing it globally is safe.
 */
export const KIRO_MCP_WHITELIST = [
  'cat-cafe',
  'cat-cafe-collab',
  'cat-cafe-memory',
  'cat-cafe-signals',
  'codegraph',
] as const;

export interface KiroAcpProfileInput {
  defaultModel?: string;
  cli?: {
    command?: string;
    defaultArgs?: readonly string[];
    /** Reasoning effort → `kiro-cli acp --effort <value>`。ACP 无运行时 set_effort，只能启动时设定。 */
    effort?: CliEffortValue | null;
  };
}

/** 从参数列表中剔除已有的 `--effort <value>`（含其后跟的取值 token），避免与配置项重复。 */
function stripEffortArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--effort') {
      i += 1; // 跳过其后的取值 token
      continue;
    }
    result.push(args[i]!);
  }
  return result;
}

/** Build the process profile for the official `kiro-cli acp` carrier. */
export function createKiroAcpProfile(config: KiroAcpProfileInput): AcpProviderProfile {
  const configuredArgs = [...(config.cli?.defaultArgs ?? [])];
  const withoutEntrypoint = configuredArgs[0] === 'acp' ? configuredArgs.slice(1) : configuredArgs;
  // This deployment explicitly opts every non-interactive Kiro ACP process into
  // trust-all. Normalize the short alias and duplicates to one auditable flag.
  // 同时剥离历史 --effort，改由配置的 cli.effort 统一控制（保证池指纹稳定、无重复）。
  const extraArgs = stripEffortArgs(
    withoutEntrypoint.filter((arg) => arg !== '--trust-all-tools' && arg !== '-a'),
  );
  const model = config.defaultModel?.trim();
  const effort = config.cli?.effort?.trim();

  return {
    command: config.cli?.command ?? 'kiro-cli',
    startupArgs: ['acp', '--trust-all-tools', ...(effort ? ['--effort', effort] : []), ...extraArgs],
    mcpServers: [],
    model: model || undefined,
    supportsMultiplexing: false,
  };
}
