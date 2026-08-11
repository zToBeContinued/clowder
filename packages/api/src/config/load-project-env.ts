import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { findMonorepoRoot } from '../utils/monorepo-root.js';
import { injectWindowsSystemProxy } from './windows-system-proxy.js';

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  const key = match[1]!;
  let value = match[2] ?? '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadProjectEnv(start = process.cwd()): void {
  const envPath = resolve(findMonorepoRoot(start), '.env');
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    process.env[key] ??= value;
  }
}

loadProjectEnv();
// .env 之后注入：显式代理配置（.env / 外部环境）优先于系统代理自动检测
injectWindowsSystemProxy();
