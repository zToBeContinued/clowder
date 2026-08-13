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
  const isCursor = client === 'cursor' || clientId === 'cursor';
  // 本机认证类客户端（accountless）：认证由本机 CLI 管理，Clowder 不绑定账号。
  const isLocalAuth = isKiro || isCursor;
  const [profiles, setProfiles] = useState<ProfileItem[]>([]);
  const [loading, setLoading] = useState(!isLocalAuth);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  // 本机认证客户端的模型：经 /api/local-cli-probes 扫描 → /api/cat-model-options 读取。
  // kiro 用 `kiro-cli settings list`；cursor 用 `cursor-agent models`（effort 已编码在模型名后缀里）。
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [selectedEffort, setSelectedEffort] = useState('');
  // 思考强度独立选项：kiro 是 --effort flag；cursor 没有（effort 在模型变体里，故为空）。
  const localEffortOptions = getCliEffortOptionsForClient(clientId as ClientValue) ?? [];
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
    if (isLocalAuth) return;
    fetchProfiles()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [fetchProfiles, isLocalAuth]);

  // 本机认证客户端：探测可用模型（扫描 → 读 /api/cat-model-options 对应 client 候选）。失败不阻断创建。
  useEffect(() => {
    if (!isLocalAuth) return;
    let cancelled = false;
    (async () => {
      try {
        await apiFetch('/api/local-cli-probes').catch(() => {});
        const res = await apiFetch('/api/cat-model-options');
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as {
          clients?: Record<string, { defaultModel?: string; models?: string[] } | undefined>;
        };
        if (cancelled) return;
        const entry = body.clients?.[clientId];
        const models = entry?.models ?? [];
        const def = entry?.defaultModel ?? '';
        setLocalModels(models);
        setSelectedModel((prev) => prev || (def && models.includes(def) ? def : (models[0] ?? '')));
      } catch {
        /* 模型探测失败不阻断——可留空使用 CLI 默认 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLocalAuth, clientId]);

  const available = useMemo(() => filterAccounts(clientId as ClientValue, profiles), [clientId, profiles]);

  /** Pick first model from a profile */
  const firstModel = (p?: ProfileItem) => p?.models?.filter(Boolean)?.[0] ?? '';

  useEffect(() => {
    if (isLocalAuth) return;
    if (!selectedProfileId && available.length > 0) {
      const defaultId = builtinAccountIdForClient(clientId as ClientValue) ?? available[0]?.id ?? '';
      setSelectedProfileId(defaultId);
      setExpandedId(defaultId);
      setSelectedModel(firstModel(available.find((p) => p.id === defaultId)));
    }
  }, [available, clientId, isLocalAuth, selectedProfileId]);

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
    if (!isLocalAuth && (!selectedProfileId || !selectedModel)) return;
    const sig = isLocalAuth ? `${clientId}:local` : `${selectedProfileId}:${selectedModel}`;
    testSigRef.current = sig;
    setTesting(true);
    setTestResult(null);
    try {
      const selectedProfile = available.find((p) => p.id === selectedProfileId);
      const profileClientId = isLocalAuth ? clientId : (selectedProfile?.provider ?? clientId);
      const res = await apiFetch('/api/first-run/connectivity-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          isLocalAuth
            ? { clientId, client }
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
          ? (body.message ?? (isLocalAuth ? '本地检查通过！' : '连接成功！'))
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

  if (isLocalAuth) {
    const canProceed = Boolean(testResult?.ok);
    const cliLabel = isKiro ? 'Kiro' : 'Cursor';
    const versionCmd = isKiro ? 'kiro-cli --version' : 'cursor-agent --version';
    return (
      <div>
        <h4 className="mb-1 text-sm font-semibold text-cafe-secondary">{cliLabel} 本机配置</h4>
        <p className="mb-3 text-xs text-cafe-muted">
          {isKiro ? '无需在 Clowder 选择账号或模型' : '无需在 Clowder 选择账号'}
        </p>

        <div className="mb-3 rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
          认证由本机 {cliLabel} CLI 管理。安全检查仅执行 <code>{versionCmd}</code>，不会启动 chat 或发送模型请求。
          {isCursor
            ? '模型可选（cursor 的思考强度已编码在模型名后缀里，如 -high/-xhigh/-max）。'
            : '模型与思考强度可选，留空则用 Kiro CLI 默认。'}
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-semibold text-cafe-secondary">模型（可选）</span>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full rounded-lg border border-[var(--console-input-stroke)] bg-[var(--clowder-input-bg)] px-3 py-2 text-sm text-cafe"
          >
            <option value="">默认（{cliLabel} CLI 当前模型）</option>
            {localModels.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        {localEffortOptions.length > 0 ? (
          <label className="mb-3 block">
            <span className="mb-1 block text-xs font-semibold text-cafe-secondary">思考强度（可选）</span>
            <select
              value={selectedEffort}
              onChange={(e) => setSelectedEffort(e.target.value)}
              className="w-full rounded-lg border border-[var(--console-input-stroke)] bg-[var(--clowder-input-bg)] px-3 py-2 text-sm text-cafe"
            >
              <option value="">默认</option>
              {localEffortOptions.map((v) => (
                <option key={v} value={v}>
                  {CLI_EFFORT_LABELS[v] ?? v}
                </option>
              ))}
            </select>
          </label>
        ) : null}

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
