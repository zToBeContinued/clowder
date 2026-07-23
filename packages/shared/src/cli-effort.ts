import type { CatProvider } from './types/cat.js';

export const CLI_EFFORT_VALUES = ['low', 'medium', 'high', 'max', 'xhigh'] as const;
export type CliEffortValue = (typeof CLI_EFFORT_VALUES)[number];
// Kiro CLI 的 `acp`/`chat` 子命令原生支持 `--effort low|medium|high|xhigh|max`（比 Claude 多 xhigh）。
export type CliEffortProvider = 'anthropic' | 'openai' | 'kiro';
export type CliEffortPatchValue = CliEffortValue | null;

const CLI_EFFORT_OPTIONS_BY_PROVIDER: Record<CliEffortProvider, readonly CliEffortValue[]> = {
  anthropic: ['low', 'medium', 'high', 'max'],
  openai: ['low', 'medium', 'high', 'xhigh'],
  kiro: ['low', 'medium', 'high', 'xhigh', 'max'],
};

const CLI_EFFORT_DEFAULT_BY_PROVIDER: Record<CliEffortProvider, CliEffortValue> = {
  anthropic: 'max',
  openai: 'xhigh',
  kiro: 'max',
};

function isCliEffortProvider(provider: string): provider is CliEffortProvider {
  return provider === 'anthropic' || provider === 'openai' || provider === 'kiro';
}

export function getCliEffortOptionsForProvider(provider: CatProvider | string): readonly CliEffortValue[] | null {
  return isCliEffortProvider(provider) ? CLI_EFFORT_OPTIONS_BY_PROVIDER[provider] : null;
}

export function getDefaultCliEffortForProvider(provider: CatProvider | string): CliEffortValue | null {
  return isCliEffortProvider(provider) ? CLI_EFFORT_DEFAULT_BY_PROVIDER[provider] : null;
}

export function isValidCliEffortForProvider(
  provider: CatProvider | string,
  effort: string | null | undefined,
): effort is CliEffortValue {
  if (!effort) return false;
  const options = getCliEffortOptionsForProvider(provider);
  return options ? options.includes(effort as CliEffortValue) : false;
}

export function normalizeCliEffortForProvider(
  provider: CatProvider | string,
  effort: string | null | undefined,
): CliEffortValue | null {
  if (!isCliEffortProvider(provider)) return null;
  if (isValidCliEffortForProvider(provider, effort)) return effort;
  return CLI_EFFORT_DEFAULT_BY_PROVIDER[provider];
}
