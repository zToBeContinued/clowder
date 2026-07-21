import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, win32 } from 'node:path';
import type {
  CliRuntimeProfileView,
  CreateCliRuntimeProfileInput,
  PatchCliRuntimeProfileInput,
} from '@cat-cafe/shared';
import { assertSafeTestConfigRoot } from './test-config-write-guard.js';

const CONFIG_SUBDIR = '.cat-cafe';
const STORE_FILENAME = 'cli-runtime-profiles.local.json';
const STORE_VERSION = 1;
const ENV_KEY_RE = /^[A-Z_][A-Za-z0-9_]*$/;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHELL_META_RE = /(?:&&|\|\||[;&|`<>]|\$\()/;
const WINDOWS_EXECUTABLE_RE = /\.(?:exe|cmd|bat|com)$/i;

export interface CliRuntimeProfile {
  readonly id: string;
  readonly displayName: string;
  readonly command?: string;
  readonly envVars: Readonly<Record<string, string>>;
}

interface CliRuntimeProfileFile {
  version: 1;
  profiles: CliRuntimeProfile[];
}

function resolveMachineConfigRoot(): string {
  const configured = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT?.trim();
  return resolve(configured || homedir());
}

export function resolveCliRuntimeProfilesPath(): string {
  return resolve(resolveMachineConfigRoot(), CONFIG_SUBDIR, STORE_FILENAME);
}

export function validateCliRuntimeEnvKey(key: string): string {
  if (!ENV_KEY_RE.test(key)) {
    throw new Error(`env key "${key}" must match [A-Z_][A-Za-z0-9_]*`);
  }
  if (key.startsWith('CAT_CAFE_')) {
    throw new Error(`env key "${key}" uses the reserved CAT_CAFE_ prefix`);
  }
  return key;
}

export function normalizeCliRuntimeCommand(command: string | undefined | null): string | undefined {
  if (command == null) return undefined;
  const value = command.trim();
  if (!value) throw new Error('command must not be empty');
  if (value !== command || /[\0\r\n]/.test(value)) {
    throw new Error('command must be a single executable name or path');
  }
  if (SHELL_META_RE.test(value)) {
    throw new Error('command must not contain shell operators');
  }
  if (/^['"]|['"]$/.test(value) || /\s--?(?:\S|$)/.test(value)) {
    throw new Error('command must not include arguments');
  }

  if (/\s/.test(value)) {
    const isWindowsAbsolute = win32.isAbsolute(value);
    const isPosixAbsolute = isAbsolute(value) && value.startsWith('/');
    // A bare name containing whitespace is necessarily a command plus argument.
    // Windows paths with whitespace must end in a known executable suffix; POSIX
    // absolute paths may legitimately contain whitespace and have no suffix.
    if ((!isWindowsAbsolute || !WINDOWS_EXECUTABLE_RE.test(value)) && !isPosixAbsolute) {
      throw new Error('command must not include arguments');
    }
  }
  return value;
}

function normalizeProfileId(id: string): string {
  const value = id.trim();
  if (!PROFILE_ID_RE.test(value)) {
    throw new Error('profile id must use 1-64 letters, numbers, dots, underscores, or hyphens');
  }
  return value;
}

function normalizeDisplayName(displayName: string): string {
  const value = displayName.trim();
  if (!value) throw new Error('displayName is required');
  if (value.length > 120) throw new Error('displayName must be at most 120 characters');
  return value;
}

function normalizeEnvVars(envVars: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(envVars ?? {})) {
    validateCliRuntimeEnvKey(key);
    if (typeof value !== 'string') throw new Error(`env value for "${key}" must be a string`);
    result[key] = value;
  }
  return result;
}

function normalizeStoredProfile(value: unknown): CliRuntimeProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('profile must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.displayName !== 'string') {
    throw new Error('profile id and displayName are required');
  }
  if (record.command != null && typeof record.command !== 'string') {
    throw new Error(`profile "${record.id}" command must be a string`);
  }
  if (record.envVars != null && (typeof record.envVars !== 'object' || Array.isArray(record.envVars))) {
    throw new Error(`profile "${record.id}" envVars must be an object`);
  }
  return {
    id: normalizeProfileId(record.id),
    displayName: normalizeDisplayName(record.displayName),
    ...(record.command != null ? { command: normalizeCliRuntimeCommand(record.command as string) } : {}),
    envVars: normalizeEnvVars(record.envVars as Record<string, string> | undefined),
  };
}

function readFileState(): CliRuntimeProfileFile {
  const filePath = resolveCliRuntimeProfilesPath();
  if (!existsSync(filePath)) return { version: STORE_VERSION, profiles: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`CLI runtime profile store is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CLI runtime profile store must be an object');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== STORE_VERSION || !Array.isArray(record.profiles)) {
    throw new Error(`CLI runtime profile store must use version ${STORE_VERSION}`);
  }
  const profiles = record.profiles.map(normalizeStoredProfile);
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.id)) throw new Error(`duplicate CLI runtime profile id "${profile.id}"`);
    seen.add(profile.id);
  }
  return { version: STORE_VERSION, profiles };
}

function chmodOwnerOnlyBestEffort(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows and some network filesystems cannot enforce POSIX modes.
  }
}

function writeFileState(state: CliRuntimeProfileFile): void {
  const root = resolveMachineConfigRoot();
  assertSafeTestConfigRoot(root, 'cli-runtime-profile-store.write');
  const filePath = resolveCliRuntimeProfilesPath();
  const dir = resolve(root, CONFIG_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    chmodOwnerOnlyBestEffort(tempPath);
    renameSync(tempPath, filePath);
    chmodOwnerOnlyBestEffort(filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

function deriveProfileId(displayName: string, existingIds: ReadonlySet<string>): string {
  const seed =
    displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `profile-${randomUUID().slice(0, 8)}`;
  if (!existingIds.has(seed)) return seed;
  let suffix = 2;
  while (existingIds.has(`${seed}-${suffix}`)) suffix += 1;
  return `${seed}-${suffix}`;
}

export function toCliRuntimeProfileView(profile: CliRuntimeProfile): CliRuntimeProfileView {
  const envKeys = Object.keys(profile.envVars).sort();
  return {
    id: profile.id,
    displayName: profile.displayName,
    ...(profile.command ? { command: profile.command } : {}),
    envKeys,
    envStatus: envKeys.map((key) => ({ key, isSet: true as const })),
  };
}

export function listCliRuntimeProfiles(): CliRuntimeProfile[] {
  return readFileState().profiles.map((profile) => ({ ...profile, envVars: { ...profile.envVars } }));
}

export function getCliRuntimeProfile(id: string): CliRuntimeProfile | undefined {
  const normalizedId = id.trim();
  const profile = readFileState().profiles.find((candidate) => candidate.id === normalizedId);
  return profile ? { ...profile, envVars: { ...profile.envVars } } : undefined;
}

export function createCliRuntimeProfile(input: CreateCliRuntimeProfileInput): CliRuntimeProfile {
  const state = readFileState();
  const displayName = normalizeDisplayName(input.displayName);
  const existingIds = new Set(state.profiles.map((profile) => profile.id));
  const id = input.id ? normalizeProfileId(input.id) : deriveProfileId(displayName, existingIds);
  if (existingIds.has(id)) throw new Error(`CLI runtime profile "${id}" already exists`);
  const profile: CliRuntimeProfile = {
    id,
    displayName,
    ...(input.command !== undefined ? { command: normalizeCliRuntimeCommand(input.command) } : {}),
    envVars: normalizeEnvVars(input.envSet),
  };
  writeFileState({ version: STORE_VERSION, profiles: [...state.profiles, profile] });
  return { ...profile, envVars: { ...profile.envVars } };
}

export function patchCliRuntimeProfile(id: string, patch: PatchCliRuntimeProfileInput): CliRuntimeProfile {
  const state = readFileState();
  const index = state.profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error(`CLI runtime profile "${id}" not found`);

  const envSet = normalizeEnvVars(patch.envSet);
  const envRemove = [...new Set(patch.envRemove ?? [])];
  for (const key of envRemove) validateCliRuntimeEnvKey(key);
  const overlap = envRemove.find((key) => Object.hasOwn(envSet, key));
  if (overlap) throw new Error(`env key "${overlap}" cannot be set and removed in the same patch`);

  const current = state.profiles[index];
  const envVars = { ...current.envVars };
  for (const key of envRemove) delete envVars[key];
  Object.assign(envVars, envSet);
  const next: CliRuntimeProfile = {
    id: current.id,
    displayName: patch.displayName !== undefined ? normalizeDisplayName(patch.displayName) : current.displayName,
    ...(patch.command !== undefined
      ? normalizeCliRuntimeCommand(patch.command)
        ? { command: normalizeCliRuntimeCommand(patch.command) }
        : {}
      : current.command
        ? { command: current.command }
        : {}),
    envVars,
  };
  const profiles = [...state.profiles];
  profiles[index] = next;
  writeFileState({ version: STORE_VERSION, profiles });
  return { ...next, envVars: { ...next.envVars } };
}

export function deleteCliRuntimeProfile(id: string): boolean {
  const state = readFileState();
  const profiles = state.profiles.filter((profile) => profile.id !== id);
  if (profiles.length === state.profiles.length) return false;
  writeFileState({ version: STORE_VERSION, profiles });
  return true;
}

/** Profile command wins over member command; service constructors own provider defaults. */
export function resolveCliRuntimeCommand(
  profile: Pick<CliRuntimeProfile, 'command'> | undefined,
  catCommand: string | undefined,
  providerDefault?: string,
): string | undefined {
  return profile?.command ?? catCommand ?? providerDefault;
}

/** Legacy account environment is intentionally applied last for compatibility. */
export function mergeCliRuntimeProfileEnv(
  profileEnv: Readonly<Record<string, string>> | undefined,
  legacyAccountEnv: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!profileEnv && !legacyAccountEnv) return undefined;
  const merged = { ...(profileEnv ?? {}), ...(legacyAccountEnv ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}
