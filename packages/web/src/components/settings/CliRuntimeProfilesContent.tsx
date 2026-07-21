'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  CLI_RUNTIME_PROFILES_CHANGED_EVENT,
  type CliRuntimeProfileSummary,
  type CliRuntimeProfilesResponse,
  getCliRuntimeProfileEnvKeys,
  parseCliRuntimeProfilesResponse,
} from '../cli-runtime-profiles';
import { useConfirm } from '../useConfirm';

interface EnvDraftRow {
  rowId: number;
  key: string;
  value: string;
  existing: boolean;
  remove: boolean;
}

interface ProfileFormState {
  original: CliRuntimeProfileSummary | null;
  id: string;
  displayName: string;
  command: string;
  envRows: EnvDraftRow[];
}

let nextEnvRowId = 1;

function envRow(key: string, value = '', existing = false): EnvDraftRow {
  return { rowId: nextEnvRowId++, key, value, existing, remove: false };
}

function createFormState(): ProfileFormState {
  return {
    original: null,
    id: '',
    displayName: '',
    command: '',
    envRows: [
      envRow('HTTP_PROXY'),
      envRow('HTTPS_PROXY'),
      envRow('NO_PROXY', 'localhost,127.0.0.1,::1'),
    ],
  };
}

function editFormState(profile: CliRuntimeProfileSummary): ProfileFormState {
  return {
    original: profile,
    id: profile.id,
    displayName: profile.displayName,
    command: profile.command ?? '',
    envRows: getCliRuntimeProfileEnvKeys(profile).map((key) => envRow(key, '', true)),
  };
}

function errorMessage(body: Record<string, unknown>, status: number, fallback: string): string {
  if (status === 409 && Array.isArray(body.boundCatIds) && body.boundCatIds.length > 0) {
    return `无法删除：仍有成员绑定此运行环境（${body.boundCatIds.join('、')}）`;
  }
  return typeof body.error === 'string' ? body.error : `${fallback} (${status})`;
}

export function CliRuntimeProfilesContent() {
  const confirm = useConfirm();
  const [data, setData] = useState<CliRuntimeProfilesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileFormState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchProfiles = useCallback(async () => {
    setError(null);
    try {
      const response = await apiFetch('/api/cli-runtime-profiles');
      const body = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
        throw new Error(errorMessage(record, response.status, 'CLI 运行环境加载失败'));
      }
      setData(parseCliRuntimeProfilesResponse(body));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'CLI 运行环境加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProfiles();
  }, [fetchProfiles]);

  const mutate = useCallback(async (path: string, init: RequestInit, fallback: string) => {
    const response = await apiFetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(errorMessage(body, response.status, fallback));
  }, []);

  const saveForm = async () => {
    if (!form || busyId) return;
    const id = form.id.trim();
    const displayName = form.displayName.trim();
    if (!id || !displayName) {
      setError('请填写 ID 和显示名称');
      return;
    }

    const activeRows = form.envRows.filter((row) => !row.remove && row.key.trim());
    const normalizedKeys = activeRows.map((row) => row.key.trim().toUpperCase());
    if (new Set(normalizedKeys).size !== normalizedKeys.length) {
      setError('环境变量名称不能重复');
      return;
    }

    const envSet = Object.fromEntries(
      activeRows
        .filter((row) => row.value.length > 0)
        .map((row) => [row.key.trim(), row.value]),
    ) as Record<string, string>;
    const envRemove = form.envRows.filter((row) => row.existing && row.remove).map((row) => row.key.trim());
    const command = form.command.trim();
    const editing = form.original !== null;
    const payload: Record<string, unknown> = editing
      ? {
          displayName,
          ...(command !== (form.original?.command ?? '')
            ? { command: command.length > 0 ? command : null }
            : {}),
          ...(Object.keys(envSet).length > 0 ? { envSet } : {}),
          ...(envRemove.length > 0 ? { envRemove } : {}),
        }
      : {
          id,
          displayName,
          ...(command ? { command } : {}),
          ...(Object.keys(envSet).length > 0 ? { envSet } : {}),
        };

    setBusyId(id);
    setError(null);
    try {
      await mutate(editing ? `/api/cli-runtime-profiles/${encodeURIComponent(id)}` : '/api/cli-runtime-profiles', {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      }, editing ? 'CLI 运行环境保存失败' : 'CLI 运行环境创建失败');
      setForm(null);
      await fetchProfiles();
      window.dispatchEvent(new CustomEvent(CLI_RUNTIME_PROFILES_CHANGED_EVENT));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'CLI 运行环境保存失败');
    } finally {
      setBusyId(null);
    }
  };

  const deleteProfile = async (profile: CliRuntimeProfileSummary) => {
    if (busyId) return;
    const accepted = await confirm({
      title: '删除 CLI 运行环境',
      message: `确认删除「${profile.displayName}」吗？已绑定成员时服务端会拒绝删除。`,
      variant: 'danger',
      confirmLabel: '删除',
    });
    if (!accepted) return;

    setBusyId(profile.id);
    setError(null);
    try {
      await mutate(
        `/api/cli-runtime-profiles/${encodeURIComponent(profile.id)}`,
        { method: 'DELETE' },
        'CLI 运行环境删除失败',
      );
      if (form?.original?.id === profile.id) setForm(null);
      await fetchProfiles();
      window.dispatchEvent(new CustomEvent(CLI_RUNTIME_PROFILES_CHANGED_EVENT));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'CLI 运行环境删除失败');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && !data) return <p className="text-sm text-cafe-muted">加载中...</p>;

  return (
    <div className="space-y-5">
      <div className="rounded-2xl bg-[var(--console-card-soft-bg)] px-4 py-3 text-xs text-cafe-secondary">
        <p className="font-semibold text-cafe">仅保存在当前机器</p>
        <p className="mt-1">
          Profile 写入本机配置根，不进入 Git；成员只保存引用 ID。环境变量值为 write-only，读取时不会回显。
        </p>
        <p className="mt-2 break-all text-cafe-muted">
          本机配置根：<code>{data?.configRoot || '服务端未返回路径'}</code>
        </p>
      </div>

      {error ? <p className="rounded-lg bg-conn-red-bg px-3 py-2 text-sm text-conn-red-text">{error}</p> : null}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setForm(createFormState())}
          className="h-9 rounded-lg bg-[var(--cafe-accent)] px-3.5 text-[13px] font-semibold text-[var(--cafe-accent-foreground)] transition-opacity hover:opacity-90"
        >
          + 新建 CLI 运行环境
        </button>
      </div>

      {form ? (
        <section
          aria-label={form.original ? '编辑 CLI 运行环境' : '新建 CLI 运行环境'}
          className="space-y-4 rounded-[22px] bg-[var(--console-card-bg)] p-5 shadow-[var(--console-shadow-soft)]"
        >
          <div>
            <h3 className="text-sm font-extrabold text-cafe">{form.original ? '编辑运行环境' : '新建运行环境'}</h3>
            <p className="mt-1 text-xs text-cafe-muted">可用于 Kiro ACP、Codex、Claude 等任意本地 CLI 成员。</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs font-semibold text-cafe-secondary">
              <span>ID</span>
              <input
                aria-label="运行环境 ID"
                value={form.id}
                disabled={Boolean(form.original)}
                onChange={(event) => setForm((current) => current && { ...current, id: event.target.value })}
                className="h-9 w-full rounded-lg bg-[var(--console-field-bg)] px-3 text-sm text-cafe outline-none disabled:opacity-60"
                placeholder="office-proxy"
              />
            </label>
            <label className="space-y-1 text-xs font-semibold text-cafe-secondary">
              <span>显示名称</span>
              <input
                aria-label="运行环境显示名称"
                value={form.displayName}
                onChange={(event) => setForm((current) => current && { ...current, displayName: event.target.value })}
                className="h-9 w-full rounded-lg bg-[var(--console-field-bg)] px-3 text-sm text-cafe outline-none"
                placeholder="办公室代理"
              />
            </label>
          </div>
          <label className="block space-y-1 text-xs font-semibold text-cafe-secondary">
            <span>Command override（可选）</span>
            <input
              aria-label="CLI Command override"
              value={form.command}
              onChange={(event) => setForm((current) => current && { ...current, command: event.target.value })}
              className="h-9 w-full rounded-lg bg-[var(--console-field-bg)] px-3 font-mono text-sm text-cafe outline-none"
              placeholder="留空使用提供方默认命令"
            />
            <span className="block font-normal text-cafe-muted">编辑时清空并保存会移除已有 command override。</span>
          </label>

          <div className="space-y-3">
            <div>
              <h4 className="text-xs font-bold text-cafe">环境变量</h4>
              <p className="mt-1 text-xs text-cafe-muted">
                已设置项不会回显原值：留空表示保留，填写表示替换，标记删除表示明确移除。
              </p>
            </div>
            {form.envRows.map((row, index) => (
              <div
                key={row.rowId}
                className={`grid gap-2 rounded-xl bg-[var(--console-card-soft-bg)] p-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] ${row.remove ? 'opacity-60' : ''}`}
              >
                <label className="space-y-1 text-xs text-cafe-secondary">
                  <span>变量名</span>
                  <input
                    aria-label={`环境变量名称 ${index + 1}`}
                    data-env-key-name={row.key}
                    value={row.key}
                    disabled={row.existing}
                    onChange={(event) =>
                      setForm((current) =>
                        current && {
                          ...current,
                          envRows: current.envRows.map((candidate) =>
                            candidate.rowId === row.rowId ? { ...candidate, key: event.target.value } : candidate,
                          ),
                        },
                      )
                    }
                    className="h-9 w-full rounded-lg bg-[var(--console-field-bg)] px-3 font-mono text-sm text-cafe outline-none disabled:opacity-70"
                    placeholder="HTTP_PROXY"
                  />
                </label>
                <label className="space-y-1 text-xs text-cafe-secondary">
                  <span>{row.existing ? '新值（留空保留）' : '值'}</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    aria-label={`${row.key || `环境变量 ${index + 1}`} 新值`}
                    data-env-value-for={row.key}
                    value={row.value}
                    disabled={row.remove}
                    onChange={(event) =>
                      setForm((current) =>
                        current && {
                          ...current,
                          envRows: current.envRows.map((candidate) =>
                            candidate.rowId === row.rowId ? { ...candidate, value: event.target.value } : candidate,
                          ),
                        },
                      )
                    }
                    className="h-9 w-full rounded-lg bg-[var(--console-field-bg)] px-3 font-mono text-sm text-cafe outline-none disabled:opacity-50"
                    placeholder={row.existing ? '••••••（已设置）' : '输入变量值'}
                  />
                  {row.existing ? <span className="block text-[11px] text-conn-green-text">已设置（值不回显）</span> : null}
                </label>
                <button
                  type="button"
                  aria-label={`${row.remove ? '撤销删除' : '删除'} ${row.key || '未命名变量'}`}
                  onClick={() =>
                    setForm((current) => {
                      if (!current) return current;
                      if (!row.existing) {
                        return { ...current, envRows: current.envRows.filter((candidate) => candidate.rowId !== row.rowId) };
                      }
                      return {
                        ...current,
                        envRows: current.envRows.map((candidate) =>
                          candidate.rowId === row.rowId
                            ? { ...candidate, remove: !candidate.remove, value: '' }
                            : candidate,
                        ),
                      };
                    })
                  }
                  className="self-end rounded-lg px-3 py-2 text-xs font-semibold text-cafe-muted hover:bg-[var(--console-hover-bg)] hover:text-conn-red-text"
                >
                  {row.remove ? '撤销删除' : '删除变量'}
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setForm((current) => current && { ...current, envRows: [...current.envRows, envRow('')] })
              }
              className="rounded-lg px-3 py-2 text-xs font-semibold text-[var(--cafe-accent)] hover:bg-[var(--console-hover-bg)]"
            >
              + 添加环境变量
            </button>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setForm(null)}
              className="h-9 rounded-lg px-4 text-sm font-semibold text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
            >
              取消
            </button>
            <button
              type="button"
              onClick={saveForm}
              disabled={Boolean(busyId)}
              className="h-9 rounded-lg bg-[var(--cafe-accent)] px-4 text-sm font-semibold text-[var(--cafe-accent-foreground)] disabled:opacity-50"
            >
              {busyId ? '保存中…' : '保存运行环境'}
            </button>
          </div>
        </section>
      ) : null}

      <div role="list" aria-label="CLI 运行环境列表" className="space-y-3">
        {(data?.profiles ?? []).map((profile) => {
          const keys = getCliRuntimeProfileEnvKeys(profile);
          return (
            <article key={profile.id} role="listitem" className="rounded-[20px] bg-[var(--console-card-bg)] p-4 shadow-[var(--console-shadow-soft)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-extrabold text-cafe">{profile.displayName}</h3>
                  <p className="mt-1 font-mono text-xs text-cafe-muted">{profile.id}</p>
                  <p className="mt-2 break-all text-xs text-cafe-secondary">
                    Command：{profile.command ?? '使用提供方默认命令'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {keys.length > 0 ? (
                      keys.map((key) => (
                        <span key={key} className="rounded-full bg-[var(--console-card-soft-bg)] px-2 py-1 font-mono text-[11px] text-cafe-secondary">
                          {key} · 已设置
                        </span>
                      ))
                    ) : (
                      <span className="text-xs text-cafe-muted">未设置环境变量</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setForm(editFormState(profile))}
                    className="rounded-lg px-3 py-2 text-xs font-semibold text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteProfile(profile)}
                    disabled={Boolean(busyId)}
                    className="rounded-lg px-3 py-2 text-xs font-semibold text-conn-red-text hover:bg-conn-red-bg disabled:opacity-50"
                  >
                    删除
                  </button>
                </div>
              </div>
            </article>
          );
        })}
        {!loading && (data?.profiles.length ?? 0) === 0 ? (
          <div className="rounded-[20px] bg-[var(--console-card-bg)] px-5 py-10 text-center text-sm text-cafe-muted">
            尚未创建 CLI 运行环境
          </div>
        ) : null}
      </div>
    </div>
  );
}
