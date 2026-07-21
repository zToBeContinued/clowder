'use client';

import type { CliRuntimeProfileSummary } from './cli-runtime-profiles';
import { getCliRuntimeProfileEnvKeys } from './cli-runtime-profiles';

interface CliRuntimeProfileBindingSectionProps {
  value: string;
  profiles: CliRuntimeProfileSummary[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  onChange: (value: string) => void;
}

export function CliRuntimeProfileBindingSection({
  value,
  profiles,
  loading,
  loaded,
  error,
  onChange,
}: CliRuntimeProfileBindingSectionProps) {
  const selected = profiles.find((profile) => profile.id === value) ?? null;
  const missing = Boolean(value && loaded && !selected);

  return (
    <section className="space-y-3 rounded-[18px] bg-[var(--console-card-bg)] p-[18px] shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <div>
        <h4 className="text-base font-extrabold text-cafe">CLI 运行环境</h4>
        <p className="mt-1 text-xs font-semibold text-cafe-secondary">
          可为任意本地 CLI（包括 Kiro ACP）独立选择本机 command override 与代理环境变量。
        </p>
      </div>
      <label className="block space-y-1.5 text-xs font-semibold text-cafe-secondary">
        <span>运行环境</span>
        <select
          aria-label="CLI 运行环境"
          value={value}
          disabled={loading}
          onChange={(event) => onChange(event.target.value)}
          className="h-10 w-full rounded-xl bg-[var(--console-field-bg)] px-3 text-sm text-cafe outline-none disabled:opacity-60"
        >
          <option value="">不使用独立运行环境</option>
          {missing ? <option value={value}>已缺失：{value}</option> : null}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.displayName}（{profile.id}）
            </option>
          ))}
        </select>
      </label>
      {loading ? <p className="text-xs text-cafe-muted">正在加载本机运行环境...</p> : null}
      {error ? <p className="rounded-xl bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text">{error}</p> : null}
      {missing ? (
        <p role="alert" className="rounded-xl bg-conn-red-bg px-3 py-2 text-xs font-semibold text-conn-red-text">
          当前引用的 CLI 运行环境「{value}」在本机不存在。引用 ID 已保留；请选择其他环境或“不使用独立运行环境”以清除。
        </p>
      ) : null}
      {selected ? (
        <div className="rounded-xl bg-[var(--console-card-soft-bg)] px-3 py-2 text-xs text-cafe-muted">
          <p>Command：{selected.command ?? '使用提供方默认命令'}</p>
          <p className="mt-1 break-all">
            环境变量：{getCliRuntimeProfileEnvKeys(selected).join('、') || '未设置'}（值不会回显）
          </p>
        </div>
      ) : null}
    </section>
  );
}
