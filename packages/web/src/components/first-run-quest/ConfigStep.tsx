'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { AccountsResponse, ProfileItem } from '../hub-accounts.types';
import {
  builtinAccountIdForClient,
  type ClientValue,
  filterAccounts,
  getCliEffortOptionsForClient,
} from '../hub-cat-editor.model';
import { type UnifiedAuthEditData, UnifiedAuthModal } from '../UnifiedAuthModal';
import { ProfileCard } from './ProfileCard';

export interface FirstRunClientConfig {
  accountRef?: string;
  model?: string;
  /** Reasoning effort (仅部分 CLI 支持，如 kiro/claude/codex)。 */
  effort?: string;
}

const CLI_EFFORT_LABELS: Record<string, string> = {
  low: 'low — 快速',
  medium: 'medium — 标准',
  high: 'high — 深度',
  xhigh: 'xhigh — 超深',
  max: 'max — 最深',
};

interface ConfigStepProps {
  client: string;
  /** Account provider key (anthropic/openai/google) — distinct from model provider. */
  clientId: string;
  onComplete: (config: FirstRunClientConfig) => void;
}

/** Map raw API error messages to user-friendly Chinese */
function humanizeError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized')) return 'Key 好像不对？请检查是否有多余空格或已过期';
  if (lower.includes('403') || lower.includes('forbidden')) return 'Key 权限不足，请确认已开通 API 访问';
  if (lower.includes('429') || lower.includes('rate')) return '请求太频繁，请稍后再试';
  if (lower.includes('timeout') || lower.includes('超时')) return '连接超时，请检查网络';
  if (lower.includes('fetch') || lower.includes('network') || lower.includes('网络')) return '网络错误，请检查连接';
  return msg;
}

export function ConfigStep({ client, clientId, onComplete }: ConfigStepProps) {
  const isKiro = client === 'kiro' || clientId === 'kiro';
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loading, setLoading] = useState(!isKiro);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  // Kiro：模型来自本机 `kiro-cli settings list`（经 /api/local-cli-probes 扫描 → /api/cat-model-options）。
  const [kiroModels, setKiroModels] = useState<string[]>([]);
  const [selectedEffort, setSelectedEffort] = useState('');
  const kiroEffortOptions = getCliEffortOptionsForClient('kiro') ?? [];
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editProfile, setEditProfile] = useState<UnifiedAuthEditData | undefined>();
  const testSigRef = useRef('');
  const testCacheRef = useRef<Map<string, { ok: boolean; message?: string }>>(new Map());

  const fetchProfiles = useCallback(async () => {
    const res = await apiFetch('/api/accounts');
    if (!res.ok) return [];
    const body = (await res.json()) as AccountsResponse;
    const providers = body.providers ?? [];
    setProfiles(providers);
    return providers;
  }, []);

  useEffect(() => {
    if (isKiro) return;
    fetchProfiles()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchProfiles, isKiro]);

  // Kiro：探测本机可用模型（扫描 → 读 /api/cat-model-options 的 kiro 候选）。失败不阻断创建。
  useEffect(() => {
    if (!isKiro) return;
    let cancelled = false;
    (async () => {
      try {
        await apiFetch('/api/local-cli-probes').catch(() => {});
        const res = await apiFetch('/api/cat-model-options');
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { clients?: { kiro?: { defaultModel?: string; models?: string[] } } };
        if (cancelled) return;
        const models = body.clients?.kiro?.models ?? [];
        const def = body.clients?.kiro?.defaultModel ?? '';
        setKiroModels(models);
        setSelectedModel((prev) => prev || (def && models.includes(def) ? def : (models[0] ?? '')));
      } catch {
        /* 模型探测失败不阻断——kiro 可留空使用 CLI 默认 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isKiro]);

  const available = useMemo(() => filterAccounts(clientId as ClientValue, profiles), [clientId, profiles]);

  /** Pick first model from a profile */
  const firstModel = (p?: ProfileItem) => p?.models?.filter(Boolean)?.[0] ?? '';

  useEffect(() => {
    if (isKiro) return;
    if (!selectedProfileId && available.length > 0) {
      const defaultId = builtinAccountIdForClient(clientId as ClientValue) ?? available[0]?.id ?? '';
      setSelectedProfileId(defaultId);
      setExpandedId(defaultId);
      setSelectedModel(firstModel(available.find((p) => p.id === defaultId)));
    }
  }, [available, clientId, isKiro, selectedProfileId]);

  const handleSelectProfile = (id: string) => {
    const collapse = expandedId === id && selectedProfileId === id;
    setSelectedProfileId(id);
    setExpandedId(collapse ? '' : id);
    const model = firstModel(available.find((p) => p.id === id));
    setSelectedModel(model);
    testSigRef.current = '';
    setTesting(false);
    setTestResult(testCacheRef.current.get(`${id}:${model}`) ?? null);
  };

  const handleModelSelect = (m: string) => {
    setSelectedModel(m);
    testSigRef.current = '';
    setTesting(false);
    setTestResult(testCacheRef.current.get(`${selectedProfileId}:${m}`) ?? null);
  };

  const handleTest = async () => {
    if (!isKiro && (!selectedProfileId || !selectedModel)) return;
    const sig = isKiro ? 'kiro:local' : `${selectedProfileId}:${selectedModel}`;
    testSigRef.current = sig;
    setTesting(true);
    setTestResult(null);
    try {
      const selectedProfile = available.find((p) => p.id === selectedProfileId);
      const profileClientId = isKiro ? 'kiro' : (selectedProfile?.provider ?? clientId);
      const res = await apiFetch('/api/first-run/connectivity-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isKiro
            ? { clientId: 'kiro', client: 'kiro' }
            : {
                profileId: selectedProfileId,
                clientId: profileClientId,
                client,
                model: selectedModel || undefined,
              },
        ),
      });
      if (testSigRef.current !== sig) return;
      const body = (await res.json()) as { ok: boolean; message?: string; error?: string };
      const result = {
        ok: body.ok,
        message: body.ok
          ? (body.message ?? (isKiro ? '本地检查通过！' : '连接成功！'))
          : humanizeError(body.error ?? body.message ?? '连接失败'),
      };
      if (result.ok) testCacheRef.current.set(sig, result);
      setTestResult(result);
    } catch {
      if (testSigRef.current !== sig) return;
      setTestResult({ ok: false, message: '网络错误，请检查连接' });
    } finally {
      if (testSigRef.current === sig) setTesting(false);
    }
  };

  const invalidateCacheForProfile = useCallback((profileId: string) => {
    for (const key of testCacheRef.current.keys()) {
      if (key.startsWith(`${profileId}:`)) testCacheRef.current.delete(key);
    }
    if (testSigRef.current.startsWith(`${profileId}:`)) testSigRef.current = '';
  }, []);

  const handleProfileCreated = useCallback(
    async (newProfileId: string) => {
      invalidateCacheForProfile(newProfileId);
      setTestResult(null);
      const updated = await fetchProfiles();
      setSelectedProfileId(newProfileId);
      setExpandedId(newProfileId);
      setSelectedModel(firstModel(updated.find((p) => p.id === newProfileId)));
    },
    [fetchProfiles, invalidateCacheForProfile],
  );

  const handleProfileRefresh = useCallback(async () => {
    invalidateCacheForProfile(selectedProfileId);
    setTestResult(null);
    const updated = await fetchProfiles();
    const profile = updated.find((p) => p.id === selectedProfileId);
    const models = profile?.models?.filter(Boolean) ?? [];
    if (selectedModel && !models.includes(selectedModel)) {
      setSelectedModel(models[0] ?? '');
    }
  }, [fetchProfiles, invalidateCacheForProfile, selectedProfileId, selectedModel]);

  if (loading) {
    return <p className="py-8 text-center text-sm text-cafe-muted">加载认证配置...</p>;
  }

  if (isKiro) {
    const canProceed = Boolean(testResult?.ok);
    return (
      <div>
        <h4 className="mb-1 text-sm font-semibold text-cafe-secondary">Kiro 本机配置</h4>
        <p className="mb-3 text-xs text-cafe-muted">无需在 Clowder 选择账号或模型</p>

        <div className="mb-3 rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
          认证由本机 Kiro CLI 管理。安全检查仅执行 <code>kiro-cli --version</code>，不会启动
          chat、ACP 或发送模型请求。模型与思考强度可选，留空则用 Kiro CLI 默认。
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-semibold text-cafe-secondary">模型（可选）</span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full rounded-lg border border-[var(--console-input-stroke)] bg-[var(--clowder-input-bg)] px-3 py-2 text-sm text-cafe"
          >
            <option value="">默认（Kiro CLI 当前模型）</option>
            {kiroModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-semibold text-cafe-secondary">思考强度（可选）</span>
          <select
            value={selectedEffort}
            onChange={(e) => setSelectedEffort(e.target.value)}
            className="w-full rounded-lg border border-[var(--console-input-stroke)] bg-[var(--clowder-input-bg)] px-3 py-2 text-sm text-cafe"
          >
            <option value="">默认</option>
            {kiroEffortOptions.map((v) => (
              <option key={v} value={v}>
                {CLI_EFFORT_LABELS[v] ?? v}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          disabled={testing}
          onClick={handleTest}
          className="mb-3 w-full rounded-lg border border-conn-amber-ring py-2.5 text-sm font-semibold text-conn-amber-text transition hover:bg-conn-amber-bg disabled:cursor-wait disabled:opacity-60"
        >
          {testing ? '检查中...' : '安全检查'}
        </button>

        {testResult && (
          <div
            className={`mb-3 rounded-lg p-3 text-sm ${
              testResult.ok
                ? 'border border-conn-emerald-ring bg-conn-emerald-bg text-conn-emerald-text'
                : 'border border-conn-red-ring bg-conn-red-bg text-conn-red-text'
            }`}
          >
            {testResult.message}
          </div>
        )}

        <button
          type="button"
          disabled={!canProceed}
          onClick={() => onComplete({ model: selectedModel || undefined, effort: selectedEffort || undefined })}
          className={`w-full rounded-lg py-2.5 text-sm font-semibold transition ${
            canProceed
              ? 'bg-conn-amber-text text-[var(--cafe-surface)] hover:opacity-90'
              : 'cursor-not-allowed bg-cafe-surface-elevated text-cafe-muted'
          }`}
        >
          {canProceed ? '创建猫猫' : '请先完成安全检查'}
        </button>
      </div>
    );
  }

  const canProceed = selectedProfileId && selectedModel && testResult?.ok;

  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold text-cafe-secondary">认证和模型配置</h4>
      <p className="mb-3 text-xs text-cafe-muted">选择账号，配置模型，验证连通性</p>

      <div className="scrollbar-cafe mb-3 max-h-80 space-y-1.5 overflow-y-auto">
        {available.length === 0 && (
          <div className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-4 text-center text-sm text-conn-amber-text">
            未找到可用账号，请点击下方新建一个账号认证
          </div>
        )}
        {available.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            isSelected={selectedProfileId === p.id}
            isExpanded={expandedId === p.id && selectedProfileId === p.id}
            selectedModel={selectedProfileId === p.id ? selectedModel : ''}
            testing={selectedProfileId === p.id && testing}
            testResult={selectedProfileId === p.id ? testResult : null}
            onSelect={() => handleSelectProfile(p.id)}
            onModelSelect={handleModelSelect}
            onTest={handleTest}
            onProfileRefresh={handleProfileRefresh}
            onEdit={() => {
              setEditProfile({
                id: p.id,
                displayName: p.displayName ?? p.name,
                baseUrl: p.baseUrl,
                clientId: p.clientId,
                authType: p.authType,
                models: p.models?.filter(Boolean),
                envVars: p.envVars,
              });
              setShowModal(true);
            }}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={() => {
          setEditProfile(undefined);
          setShowModal(true);
        }}
        className="mb-3 text-xs font-medium text-conn-amber-text hover:text-conn-amber-text"
      >
        + 新建账号认证
      </button>

      <button
        type="button"
        disabled={!canProceed}
        onClick={() => onComplete({ accountRef: selectedProfileId, model: selectedModel })}
        className={`w-full rounded-lg py-2.5 text-sm font-semibold transition ${
          canProceed
            ? 'bg-conn-amber-text text-[var(--cafe-surface)] hover:opacity-90'
            : 'cursor-not-allowed bg-cafe-surface-elevated text-cafe-muted'
        }`}
      >
        {canProceed ? '创建猫猫' : '请先完成连接测试'}
      </button>

      <UnifiedAuthModal
        key={editProfile?.id ?? 'create'}
        open={showModal}
        onClose={() => {
          setShowModal(false);
          setEditProfile(undefined);
        }}
        onCreated={handleProfileCreated}
        editProfile={editProfile}
        initialClientId={clientId as 'anthropic' | 'openai' | 'google' | 'kimi' | 'grok' | 'dare' | 'opencode'}
      />
    </div>
  );
}
