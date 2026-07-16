'use client';

import type { HubCatEditorFormState } from './hub-cat-editor.model';
import { SectionCard } from './hub-cat-editor-fields';
import { MODEL_SOURCE_LABELS, type ModelCandidateSource } from './hub-cat-model-options';

export interface LocalCliProbeResult {
  id: 'claude' | 'codex' | 'gemini' | 'kiro' | 'grok' | 'opencode' | 'kimi' | 'cursor' | 'opencli';
  label: string;
  command: string;
  clientId?: HubCatEditorFormState['clientId'];
  defaultModel?: string;
  models: Array<{ id: string; source: ModelCandidateSource; isDefault?: boolean }>;
  modelsStatus: 'ok' | 'config_only' | 'static_only' | 'failed' | 'unsupported';
  installed: boolean;
  resolvedPath?: string;
  version?: string;
  versionStatus: 'ok' | 'failed' | 'not_installed';
  authStatus: 'unknown';
  authStatusReason: string;
  installHint: string;
}

function LocalCliProbeCard({ probe, onAdopt }: { probe: LocalCliProbeResult; onAdopt: () => void }) {
  const modelSource = probe.models?.[0]?.source;
  const modelStatusMessage =
    probe.modelsStatus === 'failed'
      ? '模型扫描失败'
      : probe.modelsStatus === 'unsupported'
        ? '暂不支持模型枚举'
        : probe.installed && (probe.models?.length ?? 0) === 0
          ? '未发现可用模型'
          : null;
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-[13px] font-extrabold text-cafe">
          <span>{probe.installed ? '●' : '○'}</span>
          <span>{probe.label}</span>
          <span className="font-mono text-[11px] text-cafe-secondary">{probe.command}</span>
          <span
            className={[
              'rounded-full px-2 py-0.5 text-[10px] font-extrabold',
              probe.installed
                ? 'bg-conn-green-bg text-conn-green-text'
                : 'bg-[var(--console-field-bg)] text-cafe-secondary',
            ].join(' ')}
          >
            {probe.installed ? '已安装' : '未检测到'}
          </span>
          {modelSource ? (
            <span className="rounded-full bg-[var(--console-field-bg)] px-2 py-0.5 text-[10px] font-extrabold text-cafe-secondary">
              {MODEL_SOURCE_LABELS[modelSource]}
            </span>
          ) : null}
        </p>
        <p className="mt-1 truncate text-[11px] text-cafe-secondary" title={probe.resolvedPath}>
          {probe.installed
            ? `${probe.version ?? '版本未知'} · 认证状态：${probe.authStatusReason}`
            : `安装建议：${probe.installHint}`}
        </p>
        {probe.models?.length ? (
          <p className="mt-1 text-[11px] leading-4 text-cafe-secondary">
            模型：
            <span className="font-mono">
              {probe.models
                .slice(0, 5)
                .map((model) => model.id)
                .join(' / ')}
            </span>
            {probe.models.length > 5 ? ` 等 ${probe.models.length} 个` : ''}
          </p>
        ) : null}
        {modelStatusMessage ? (
          <p className="mt-1 text-[11px] font-bold text-conn-orange-text">{modelStatusMessage}</p>
        ) : null}
      </div>
      {probe.installed && probe.clientId ? (
        <button
          type="button"
          onClick={onAdopt}
          className="shrink-0 rounded-[9px] bg-[var(--console-field-bg)] px-3 py-1.5 text-[12px] font-bold text-cafe-secondary transition hover:text-cafe"
        >
          用 {probe.label}
        </button>
      ) : null}
    </div>
  );
}

export function LocalCliProbeSection({
  probes,
  scanning,
  error,
  onScan,
  onAdopt,
}: {
  probes: LocalCliProbeResult[] | null;
  scanning: boolean;
  error: string | null;
  onScan: () => void;
  onAdopt: (probe: LocalCliProbeResult) => void;
}) {
  return (
    <SectionCard
      title="本地 CLI 探测"
      description="点击后扫描固定 allowlist：claude / codex / gemini / kiro-cli / grok / opencode / kimi / cursor / opencli，按命令、白名单配置、内置清单依次获取模型。不会读取凭证文件。"
    >
      <div className="flex flex-col gap-2 rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2 text-[12px] leading-5 text-cafe-secondary sm:flex-row sm:items-center sm:justify-between">
        <span>用于确认后端机器是否能启动本地 Agent CLI；扫描是手动触发，不会后台自动跑。</span>
        <button
          type="button"
          onClick={onScan}
          disabled={scanning}
          className="shrink-0 rounded-[9px] bg-cafe-accent px-3 py-1.5 text-[12px] font-bold text-[var(--cafe-bg)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {scanning ? '扫描中…' : '扫描本机 CLI 与模型'}
        </button>
      </div>
      {error ? <p className="text-[12px] font-semibold text-conn-red-text">{error}</p> : null}
      {probes ? (
        <div className="space-y-2">
          {probes.map((probe) => (
            <LocalCliProbeCard key={probe.id} probe={probe} onAdopt={() => onAdopt(probe)} />
          ))}
        </div>
      ) : null}
    </SectionCard>
  );
}
