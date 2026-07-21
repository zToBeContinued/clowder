export const CLI_RUNTIME_PROFILES_CHANGED_EVENT = 'cli-runtime-profiles-changed';

export interface CliRuntimeProfileEnvStatus {
  key: string;
  isSet: true;
}

export interface CliRuntimeProfileSummary {
  id: string;
  displayName: string;
  command?: string;
  envKeys: string[];
  envStatus?: CliRuntimeProfileEnvStatus[];
}

export interface CliRuntimeProfilesResponse {
  configRoot: string;
  profiles: CliRuntimeProfileSummary[];
}

function uniqueNonEmptyStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)),
  );
}

/**
 * 只保留 API 契约中的元数据。环境变量值是 write-only，哪怕服务端误返回也不会进入前端状态。
 */
export function parseCliRuntimeProfilesResponse(value: unknown): CliRuntimeProfilesResponse {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const profiles = Array.isArray(body.profiles)
    ? body.profiles.flatMap((item): CliRuntimeProfileSummary[] => {
        if (!item || typeof item !== 'object') return [];
        const raw = item as Record<string, unknown>;
        const id = typeof raw.id === 'string' ? raw.id.trim() : '';
        const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
        if (!id || !displayName) return [];
        const envStatus = Array.isArray(raw.envStatus)
          ? raw.envStatus.flatMap((status): CliRuntimeProfileEnvStatus[] => {
              if (!status || typeof status !== 'object') return [];
              const candidate = status as Record<string, unknown>;
              const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
              return key && candidate.isSet === true ? [{ key, isSet: true }] : [];
            })
          : [];
        const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command.trim() : undefined;
        return [
          {
            id,
            displayName,
            ...(command ? { command } : {}),
            envKeys: uniqueNonEmptyStrings(raw.envKeys),
            ...(envStatus.length > 0 ? { envStatus } : {}),
          },
        ];
      })
    : [];

  return {
    configRoot: typeof body.configRoot === 'string' ? body.configRoot : '',
    profiles,
  };
}

export function getCliRuntimeProfileEnvKeys(profile: CliRuntimeProfileSummary): string[] {
  return Array.from(new Set([...profile.envKeys, ...(profile.envStatus ?? []).map((status) => status.key)]));
}
