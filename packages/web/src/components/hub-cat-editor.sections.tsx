'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';
import type { ProfileItem } from './hub-accounts.types';
import {
  autoSlug,
  CLIENT_OPTIONS,
  CODEX_FAST_MODE_ARG,
  getCliEffortOptionsForClient,
  type HubCatEditorFormState,
  joinTags,
  normalizeMentionPattern,
  splitMentionPatterns,
  splitStrengthTags,
  TOOL_POLICY_OPTIONS,
} from './hub-cat-editor.model';
import { SectionCard, SelectField, TextField } from './hub-cat-editor-fields';
import { MODEL_SOURCE_LABELS, type ModelCandidateSource } from './hub-cat-model-options';
import { TagEditor } from './hub-tag-editor';

type FormPatch = Partial<HubCatEditorFormState>;
type AssetBrowseEntry = { name: string; path: string; isDirectory: boolean };
type AssetBrowseResult = {
  current: string;
  name: string;
  parent: string | null;
  homePath: string;
  entries: AssetBrowseEntry[];
};

const CLI_EFFORT_LABELS: Record<string, string> = {
  low: 'low — 快速思考',
  medium: 'medium — 标准思考',
  high: 'high — 深度思考',
  max: 'max — 最深思考',
  xhigh: 'xhigh — 超深思考',
};

const AVATAR_PRESETS = [
  { label: 'Slock Blue Cat', src: '/avatars/slock/slock-blue-cat.png' },
  { label: 'Slock Yellow Cat', src: '/avatars/slock/slock-yellow-cat.png' },
  { label: 'Slock Purple Bot', src: '/avatars/slock/slock-purple-bot.png' },
  { label: 'Slock Skull', src: '/avatars/slock/slock-skull.png' },
  { label: 'Slock Green Mask', src: '/avatars/slock/slock-green-mask.png' },
  { label: 'Slock Pink Pig', src: '/avatars/slock/slock-pink-pig.png' },
  { label: 'Slock Yellow Wizard', src: '/avatars/slock/slock-yellow-wizard.png' },
  { label: 'Slock Fire', src: '/avatars/slock/slock-fire.png' },
  { label: 'Slock Cyan Gem', src: '/avatars/slock/slock-cyan-gem.png' },
  { label: 'Slock Pink Robot', src: '/avatars/slock/slock-pink-robot.png' },
  { label: 'Slock Purple Eye', src: '/avatars/slock/slock-purple-eye.png' },
  { label: 'Slock Yellow Crown', src: '/avatars/slock/slock-yellow-crown.png' },
  { label: 'Slock Blue Mountain', src: '/avatars/slock/slock-blue-mountain.png' },
  { label: 'Slock Coral Tile', src: '/avatars/slock/slock-coral-tile.png' },
  { label: 'Slock Navy Dome', src: '/avatars/slock/slock-navy-dome.png' },
  { label: 'Slock Green Blob', src: '/avatars/slock/slock-green-blob.png' },
  { label: 'Default', src: '/avatars/default.png' },
  { label: 'Opus', src: '/avatars/opus.png' },
  { label: 'Opus 45', src: '/avatars/opus-45.png' },
  { label: 'Opus 47', src: '/avatars/opus-47.png' },
  { label: 'Opus Kawaii', src: '/avatars/opus-kawaii.png' },
  { label: 'Sonnet', src: '/avatars/sonnet.png' },
  { label: 'Codex', src: '/avatars/codex.png' },
  { label: 'Codex Kawaii', src: '/avatars/codex-kawaii.png' },
  { label: 'Codex Liquid', src: '/avatars/codex_iquid.png' },
  { label: 'GPT52', src: '/avatars/gpt52.png' },
  { label: 'OpenCode', src: '/avatars/opencode.png' },
  { label: 'Gemini', src: '/avatars/gemini.png' },
  { label: 'Gemini 25', src: '/avatars/gemini25.png' },
  { label: 'Gemini Kawaii', src: '/avatars/gemini-kawaii.png' },
  { label: 'Kimi', src: '/avatars/kimi.png' },
  { label: 'Antigravity', src: '/avatars/antigravity.png' },
  { label: 'Antig Opus', src: '/avatars/antig-opus.png' },
  { label: 'Keeper', src: '/avatars/keeper.png' },
  { label: 'Dare', src: '/avatars/dare.png' },
  { label: 'Codex Box', src: '/avatars/codex_box.png' },
] as const;

function safeAvatarSrc(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('/avatars/')) return trimmed;
  return null;
}

function currentAliasTags(form: HubCatEditorFormState): string[] {
  return splitMentionPatterns(form.mentionPatterns).map(normalizeMentionPattern).filter(Boolean);
}

function parentPathOf(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return undefined;
  return trimmed.slice(0, index);
}

function AssetCardFilePicker({
  initialPath,
  onPick,
  onCancel,
}: {
  initialPath?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const [browseResult, setBrowseResult] = useState<AssetBrowseResult | null>(null);
  const [pathInput, setPathInput] = useState(parentPathOf(initialPath) ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPath = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ includeFiles: 'true', ext: '.md' });
      if (path?.trim()) params.set('path', path.trim());
      const response = await apiFetch(`/api/projects/browse?${params.toString()}`);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? `浏览失败：${response.status}`);
      }
      const result = (await response.json()) as AssetBrowseResult;
      setBrowseResult(result);
      setPathInput(result.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : '浏览失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPath(parentPathOf(initialPath));
  }, [initialPath, loadPath]);

  const entries = browseResult?.entries ?? [];

  return (
    <div
      role="group"
      aria-label="Asset Card MD Picker"
      className="rounded-[14px] border border-[var(--console-border-soft)] bg-[var(--console-field-bg)] p-3"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          aria-label="Asset Card Browse Path"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          className="min-w-0 flex-1 rounded-[9px] border border-transparent bg-[var(--console-card-bg)] px-3 py-1.5 text-[12px] text-cafe-black outline-none transition focus:border-cafe-accent focus:ring-2 focus:ring-cafe-accent/30"
          placeholder="输入目录路径"
        />
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void loadPath(pathInput)}
            className="rounded-[9px] bg-cafe-accent px-3 py-1.5 text-[12px] font-bold text-[var(--cafe-bg)] transition hover:opacity-90"
          >
            跳转
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-[9px] bg-[var(--console-card-bg)] px-3 py-1.5 text-[12px] font-bold text-cafe-secondary transition hover:text-cafe"
          >
            取消
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-cafe-secondary">
        <span className="truncate" title={browseResult?.current}>
          当前：{browseResult?.current ?? '加载中'}
        </span>
        {browseResult?.parent ? (
          <button
            type="button"
            onClick={() => void loadPath(browseResult.parent ?? undefined)}
            className="shrink-0 font-bold text-cafe-accent hover:underline"
          >
            上一级
          </button>
        ) : null}
      </div>

      {error ? <p className="mt-2 text-[11px] font-semibold text-conn-red-text">{error}</p> : null}

      <div className="mt-2 max-h-56 overflow-y-auto rounded-[10px] bg-[var(--console-card-bg)] p-1">
        {loading ? <p className="px-2 py-2 text-[12px] text-cafe-secondary">读取中…</p> : null}
        {!loading && entries.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-cafe-secondary">当前目录没有可选择的 Markdown 文件。</p>
        ) : null}
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => {
              if (entry.isDirectory) {
                void loadPath(entry.path);
                return;
              }
              onPick(entry.path);
            }}
            className="flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left text-[12px] text-cafe-secondary transition hover:bg-[var(--console-field-bg)] hover:text-cafe"
          >
            <span className="w-7 shrink-0 text-center font-mono text-[10px]">{entry.isDirectory ? 'DIR' : 'MD'}</span>
            <span className="truncate" title={entry.path}>
              {entry.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function IdentitySection({
  cat,
  form,
  hasError,
  avatarUploading,
  onChange,
  onAvatarUpload,
  onRefAudioUpload,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  hasError?: boolean;
  avatarUploading: boolean;
  onChange: (patch: FormPatch) => void;
  onAvatarUpload: (file: File) => Promise<void>;
  onRefAudioUpload: (file: File) => Promise<void>;
}) {
  const strengthTags = splitStrengthTags(form.strengths);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarSrc = safeAvatarSrc(form.avatar);

  return (
    <SectionCard title="身份信息" tone={hasError ? 'error' : 'neutral'}>
      {!cat ? (
        <>
          <TextField
            label="名称"
            ariaLabel="Name"
            value={form.name}
            onChange={(value) => {
              onChange({ name: value, displayName: value, catId: autoSlug(value, form.catId) });
            }}
            required
            placeholder="成员显示名称，如 我的助手"
          />
          <input type="hidden" aria-label="Cat ID" value={form.catId} />
        </>
      ) : (
        <TextField
          label="名称"
          ariaLabel="Name"
          value={form.name}
          onChange={(value) => onChange({ name: value, displayName: value })}
        />
      )}

      <TextField
        label="昵称"
        ariaLabel="Nickname"
        value={form.nickname}
        onChange={(value) => onChange({ nickname: value })}
        placeholder="可选，铲屎官给的昵称"
      />
      <TextField
        label="显示后缀"
        ariaLabel="Variant Label"
        value={form.variantLabel}
        onChange={(value) => onChange({ variantLabel: value })}
        placeholder="如 GPT-5.5 / Opus 4.7"
      />
      <TextField
        label="角色描述"
        ariaLabel="Description"
        value={form.roleDescription}
        onChange={(value) => onChange({ roleDescription: value })}
        required
        placeholder="角色定位，如 代码审查专家"
      />

      <TextField
        label="擅长领域"
        ariaLabel="Team Strengths"
        value={form.teamStrengths}
        onChange={(value) => onChange({ teamStrengths: value })}
        placeholder="如 架构设计、安全分析"
      />
      <TextField
        label="性格特征"
        ariaLabel="Personality"
        value={form.personality}
        onChange={(value) => onChange({ personality: value })}
        placeholder="如 温柔但有主见"
      />

      <div className="flex items-center gap-[14px]">
        <span className="w-[150px] shrink-0 text-[12px] font-bold text-cafe-secondary">Avatar</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex h-9 items-center gap-2 rounded-[10px] bg-[var(--console-field-bg)] px-3 text-[13px] font-bold text-cafe-secondary transition hover:opacity-80"
        >
          <div className="flex h-[30px] w-[30px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--console-card-bg)] text-[10px] text-cafe-secondary">
            {avatarSrc ? (
              <AvatarImageWithFallback src={avatarSrc} alt="Avatar preview" className="h-full w-full object-cover" />
            ) : (
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" role="img" aria-label="Default avatar">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8Zm-2-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm4 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
              </svg>
            )}
          </div>
          <span>{avatarUploading ? '上传中…' : '点击上传'}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void onAvatarUpload(file).finally(() => {
              if (fileInputRef.current) fileInputRef.current.value = '';
            });
          }}
        />
        <input
          aria-label="Avatar"
          value={form.avatar}
          onChange={(event) => onChange({ avatar: event.target.value })}
          className="sr-only"
        />
      </div>

      <div className="flex items-start gap-[14px]">
        <span className="w-[150px] shrink-0 pt-1 text-[12px] font-bold text-cafe-secondary">预设头像</span>
        <div className="min-w-0 flex-1">
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
            {AVATAR_PRESETS.map((preset) => {
              const selected = form.avatar.trim() === preset.src;
              return (
                <button
                  key={preset.src}
                  type="button"
                  aria-label={`选择预设头像 ${preset.label}`}
                  aria-pressed={selected}
                  title={preset.label}
                  onClick={() => onChange({ avatar: preset.src })}
                  className={[
                    'flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border-2 bg-[var(--console-card-bg)] transition',
                    selected
                      ? 'border-cafe-accent shadow-[0_0_0_2px_rgba(244,111,167,0.18)]'
                      : 'border-[var(--console-border-soft)] opacity-75 hover:border-cafe-accent hover:opacity-100',
                  ].join(' ')}
                >
                  <AvatarImageWithFallback src={preset.src} alt={preset.label} className="h-full w-full object-cover" />
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-cafe-secondary">点击即可切换；仍可上传自定义头像。</p>
        </div>
      </div>

      <div className="flex items-center gap-[14px]">
        <span className="w-[150px] shrink-0 text-[12px] font-bold text-cafe-secondary">Background Color</span>
        <div className="flex items-center gap-2.5">
          <label title="Primary">
            <input
              type="color"
              aria-label="Background Color Primary"
              value={form.colorPrimary}
              onChange={(event) => onChange({ colorPrimary: event.target.value })}
              className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
          <label title="Secondary">
            <input
              type="color"
              aria-label="Background Color Secondary"
              value={form.colorSecondary}
              onChange={(event) => onChange({ colorSecondary: event.target.value })}
              className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
        </div>
      </div>
      <TextField
        label="注意事项"
        ariaLabel="Caution"
        value={form.caution}
        onChange={(value) => onChange({ caution: value })}
        placeholder="可选，留空表示无特殊注意"
      />

      <div className="flex items-start gap-3">
        <span className="w-[150px] shrink-0 pt-1 text-[12px] font-bold text-cafe-secondary">Strengths</span>
        <div className="min-w-0 flex-1">
          <TagEditor
            tags={strengthTags}
            onChange={(tags) => onChange({ strengths: joinTags(tags) })}
            addLabel="+ 选择"
            placeholder="输入标签，例如 security"
            emptyLabel="(无)"
          />
        </div>
        <input
          aria-label="Strengths"
          value={form.strengths}
          onChange={(event) => onChange({ strengths: event.target.value })}
          className="sr-only"
        />
      </div>

      <VoiceConfigSection form={form} onChange={onChange} onRefAudioUpload={onRefAudioUpload} />
    </SectionCard>
  );
}

export function AssetCardSection({
  cat,
  form,
  onChange,
  onReload,
  reloading = false,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  onChange: (patch: FormPatch) => void;
  onReload?: (path: string) => Promise<void>;
  reloading?: boolean;
}) {
  const assetCard = cat?.assetCard;
  const loadedAtLabel = assetCard?.loadedAt ? new Date(assetCard.loadedAt).toLocaleString() : '未同步';
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <SectionCard
      title="资产卡关联"
      description="绑定本地 Markdown 资产卡。Agent 每次执行前会读取这张卡，作为职责、边界和输出格式的强约束。"
      data-guide-id="member-editor.asset-card"
    >
      <TextField
        label="本地路径"
        ariaLabel="Asset Card Path"
        value={form.assetCardPath ?? ''}
        onChange={(value) => onChange({ assetCardPath: value })}
        placeholder="/Users/.../01_需求梳理Agent.md"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          aria-label="选择资产卡 MD"
          onClick={() => setPickerOpen((value) => !value)}
          className="rounded-[9px] bg-[var(--console-field-bg)] px-3 py-1.5 text-[12px] font-bold text-cafe-secondary transition hover:text-cafe"
        >
          选择 MD
        </button>
        {cat && onReload ? (
          <button
            type="button"
            aria-label="重新加载资产卡"
            disabled={reloading || !form.assetCardPath?.trim()}
            onClick={() => void onReload(form.assetCardPath ?? '')}
            className="rounded-[9px] bg-cafe-accent px-3 py-1.5 text-[12px] font-bold text-[var(--cafe-bg)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reloading ? '加载中…' : '重新加载资产卡'}
          </button>
        ) : null}
      </div>
      {pickerOpen ? (
        <AssetCardFilePicker
          initialPath={form.assetCardPath}
          onPick={(path) => {
            onChange({ assetCardPath: path });
            setPickerOpen(false);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      ) : null}
      <div className="rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2 text-[11px] leading-5 text-cafe-secondary">
        <p>
          当前状态：
          {form.assetCardPath?.trim() ? (
            <span className="font-semibold text-cafe">已关联本地资产卡</span>
          ) : (
            <span>未关联</span>
          )}
        </p>
        {assetCard ? (
          <p className="truncate" title={assetCard.path}>
            来源：{assetCard.source ?? 'local-md'} · 版本：{assetCard.version ?? '未设置'} · 加载：{loadedAtLabel}
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}

const VOICE_LANG_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '未设置' },
  { value: 'z', label: '中文 (z)' },
  { value: 'zh', label: '中文 (zh)' },
  { value: 'en-us', label: 'English (en-us)' },
  { value: 'ja', label: '日本語 (ja)' },
];

function refAudioDisplayName(path: string): string {
  if (!path) return '';
  const segments = path.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] ?? path;
}

function RefAudioField({ value, onUpload }: { value: string; onUpload: (file: File) => Promise<void> }) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const filename = refAudioDisplayName(value);

  return (
    <div className="flex flex-col gap-1.5 text-cafe sm:flex-row sm:items-center sm:gap-[14px]">
      <span className="text-[12px] font-bold text-cafe-secondary sm:w-[150px] sm:shrink-0">Ref Audio</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="flex-1 truncate rounded-[10px] bg-[var(--console-field-bg)] px-3 py-1.5 text-[13px] leading-5 text-cafe-black"
          title={value}
        >
          {filename || <span className="text-cafe-muted">未设置</span>}
        </span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="shrink-0 rounded-[10px] bg-[var(--console-field-bg)] px-3 py-1.5 text-[12px] font-bold text-cafe-secondary transition hover:opacity-80"
        >
          上传
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/wav,audio/mpeg,audio/mp3,audio/webm,audio/ogg,.wav,.mp3,.webm,.ogg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void onUpload(file).finally(() => {
              if (fileRef.current) fileRef.current.value = '';
            });
          }}
        />
      </div>
    </div>
  );
}

function VoiceConfigSection({
  form,
  onChange,
  onRefAudioUpload,
}: {
  form: HubCatEditorFormState;
  onChange: (patch: Partial<HubCatEditorFormState>) => void;
  onRefAudioUpload: (file: File) => Promise<void>;
}) {
  const hasVoiceConfig = !!(form.voiceVoice || form.voiceLangCode);
  const [expanded, setExpanded] = useState(hasVoiceConfig);
  const summary = hasVoiceConfig ? `${form.voiceLangCode || '?'}` : '';

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex min-w-0 flex-1 items-center rounded-[10px] bg-[var(--console-field-bg)] px-3 h-[34px] w-full text-left"
      >
        <p className="text-[12px] font-bold text-[var(--console-voice-hint)]">
          {expanded ? '▾' : '▸'} Voice Config{summary ? ` — ${summary}` : ''}
        </p>
      </button>
      {expanded && (
        <div className="space-y-2">
          <SelectField
            label="Lang Code"
            value={form.voiceLangCode}
            options={VOICE_LANG_OPTIONS}
            onChange={(value) => {
              const patch: Partial<HubCatEditorFormState> = { voiceLangCode: value };
              if (value && !form.voiceVoice) patch.voiceVoice = 'zm_yunjian';
              onChange(patch);
            }}
          />
          <TextField
            label="Speed"
            ariaLabel="Voice Speed"
            value={form.voiceSpeed}
            onChange={(value) => onChange({ voiceSpeed: value })}
            placeholder="1.0"
          />
          <RefAudioField value={form.voiceRefAudio} onUpload={onRefAudioUpload} />
          <TextField
            label="Ref Text"
            ariaLabel="Reference Audio Text"
            value={form.voiceRefText}
            onChange={(value) => onChange({ voiceRefText: value })}
            placeholder="参考音频对应的文本"
          />
          <TextField
            label="Instruct"
            ariaLabel="Voice Style Instruction"
            value={form.voiceInstruct}
            onChange={(value) => onChange({ voiceInstruct: value })}
            placeholder="如：用一个调皮狡黠的少年语气说话"
          />
          <TextField
            label="Temperature"
            ariaLabel="Voice Temperature"
            value={form.voiceTemperature}
            onChange={(value) => onChange({ voiceTemperature: value })}
            placeholder="0.3"
          />
        </div>
      )}
    </div>
  );
}

/** Well-known OpenCode provider names (always shown as suggestions). */
export const KNOWN_OC_PROVIDERS = [
  'anthropic',
  'openai',
  'openai-responses',
  'openrouter',
  'google',
  'azure',
  'deepseek',
  'xiaomi-mimo',
];

/** Merge well-known providers with any prefixes extracted from model strings like "openai/gpt-5.4". */
function buildProviderSuggestions(models: string[]): string[] {
  const seen = new Set<string>(KNOWN_OC_PROVIDERS);
  for (const m of models) {
    const idx = m.indexOf('/');
    if (idx > 0) seen.add(m.slice(0, idx));
  }
  return [...seen].sort();
}

function ComboField({
  label,
  ariaLabel,
  value,
  onChange,
  suggestions,
  required = false,
  placeholder,
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  required?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const popupId = `combo-${label.replace(/\s+/g, '-').toLowerCase()}-options`;
  const filteredSuggestions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return suggestions;
    return suggestions.filter((suggestion) => suggestion.toLowerCase().includes(normalizedQuery));
  }, [query, suggestions]);

  return (
    <label className="flex flex-col gap-1.5 text-cafe sm:flex-row sm:items-center sm:gap-[14px]">
      <span className="text-[12px] font-bold text-cafe-secondary sm:w-[150px] sm:shrink-0">
        {label}
        {required && <span className="ml-0.5 text-conn-red-text">*</span>}
      </span>
      <div className="relative min-w-0 flex-1">
        <input
          aria-label={ariaLabel ?? label}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setQuery(event.target.value);
          }}
          onFocus={() => {
            setQuery('');
            setOpen(true);
          }}
          onClick={() => {
            setQuery('');
            setOpen(true);
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          role="combobox"
          aria-expanded={open && filteredSuggestions.length > 0}
          aria-controls={popupId}
          className="w-full rounded-[10px] border border-transparent bg-[var(--console-field-bg)] px-3 py-1.5 text-[13px] leading-5 text-cafe-black placeholder:text-cafe-muted outline-none transition focus:border-cafe-accent focus:ring-2 focus:ring-cafe-accent/30"
          placeholder={placeholder}
        />
        {open && filteredSuggestions.length > 0 ? (
          <div
            id={popupId}
            className="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-[12px] border border-cafe-border bg-[var(--console-card-bg)] p-1 shadow-[0_14px_34px_rgba(43,33,26,0.16)]"
            onMouseDown={(event) => event.preventDefault()}
          >
            {filteredSuggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                className="block w-full rounded-[9px] px-3 py-1.5 text-left text-[12px] font-semibold text-cafe transition hover:bg-[rgba(204,103,67,0.1)]"
                onClick={() => {
                  onChange(suggestion);
                  setQuery('');
                  setOpen(false);
                }}
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </label>
  );
}

// Derive the opencode endpoint suffix from provider name (sole authority).
// Account-level protocol is no longer used — mirrors backend deriveOpenCodeApiType.
export function resolveOpenCodeEndpoint(providerName: string): string {
  const normalized = providerName.toLowerCase();
  if (normalized === 'openai-responses') return '/v1/responses';
  if (normalized === 'anthropic') return '/v1/messages';
  if (normalized === 'google') return '/models/{model}:generateContent';
  return '/v1/chat/completions';
}

interface CallHint {
  label: string;
  url: string;
  warning: string;
}

// Generate a hint showing what API endpoint the CLI will actually call
function buildCallHint(
  client: string,
  profile: ProfileItem | undefined,
  model: string,
  providerName: string,
): CallHint | null {
  if (!profile || profile.authType === 'oauth' || !profile.baseUrl) return null;
  const base = profile.baseUrl.replace(/\/+$/, '');
  const hasV1Suffix = /\/v1$/i.test(base);
  // Strip trailing /v1 from base to avoid /v1/v1 duplication when pathSuffix already includes /v1
  const baseWithoutV1 = hasV1Suffix ? base.replace(/\/v1$/i, '') : base;

  // For opencode, derive endpoint dynamically from provider name (sole authority)
  const ocPath = client === 'opencode' ? resolveOpenCodeEndpoint(providerName) : undefined;

  const cliEndpoints: Record<string, { cli: string; pathSuffix: string }> = {
    anthropic: { cli: 'claude', pathSuffix: '/v1/messages' },
    opencode: { cli: 'opencode', pathSuffix: ocPath ?? '/v1/chat/completions' },
    openai: { cli: 'codex', pathSuffix: '/v1/responses' },
    google: { cli: 'gemini', pathSuffix: `/models/${model || '...'}:generateContent` },
    dare: { cli: 'dare', pathSuffix: '/v1/chat/completions' },
  };
  const info = cliEndpoints[client];
  if (!info) return null;

  // Use baseWithoutV1 for paths starting with /v1 to avoid duplication
  const effectiveBase = info.pathSuffix.startsWith('/v1') ? baseWithoutV1 : base;
  const fullUrl = `${effectiveBase}${info.pathSuffix}`;
  let warning = '';
  if (client === 'google') {
    warning = '\n注意: Google 官方 endpoint 要求 OAuth 认证；第三方 gateway 会走这里展示的 baseUrl。';
  }
  return { label: `${info.cli} CLI 实际调用: `, url: fullUrl, warning };
}

export function AccountSection({
  form,
  hasError,
  modelOptions,
  modelSource,
  modelDrifted,
  modelOptionsError,
  availableProfiles,
  loadingProfiles,
  onChange,
}: {
  form: HubCatEditorFormState;
  hasError?: boolean;
  modelOptions: string[];
  modelSource?: ModelCandidateSource;
  modelDrifted: boolean;
  modelOptionsError: string | null;
  availableProfiles: ProfileItem[];
  loadingProfiles: boolean;
  onChange: (patch: FormPatch) => void;
}) {
  const accountOptions = availableProfiles;
  const selectedProfile = availableProfiles.find((p) => p.id === form.accountRef);
  const callHint = buildCallHint(form.clientId, selectedProfile, form.defaultModel, form.provider);
  const providerSuggestions = useMemo(() => buildProviderSuggestions(modelOptions), [modelOptions]);
  const cliEffortOptions = getCliEffortOptionsForClient(form.clientId);

  return (
    <SectionCard title="认证与模型" tone={hasError ? 'error' : 'neutral'} data-guide-id="member-editor.auth-config">
      <div className="space-y-2">
        <SelectField
          label="Client"
          value={form.clientId}
          options={CLIENT_OPTIONS}
          onChange={(value) =>
            onChange({ clientId: value as HubCatEditorFormState['clientId'], provider: '', cliEffort: '' })
          }
          required
        />

        {form.clientId === 'antigravity' ? (
          <>
            <TextField
              label="CLI Command"
              value={form.commandArgs}
              onChange={(value) => onChange({ commandArgs: value })}
              required
              placeholder="启动命令参数"
            />
            <TextField
              label="Model"
              value={form.defaultModel}
              onChange={(value) => onChange({ defaultModel: value })}
              required
              placeholder="模型标识符"
            />
          </>
        ) : (
          <>
            {form.clientId === 'kiro' ? (
              <div className="rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2 text-[12px] leading-5 text-cafe-secondary">
                认证由本机 Kiro CLI 管理；Clowder 不读取或保存 Kiro 凭证。
              </div>
            ) : (
              <SelectField
                label="认证信息"
                value={form.accountRef}
                options={[
                  { value: '', label: loadingProfiles ? '加载中…' : '请选择认证方式' },
                  ...accountOptions
                    .filter((profile) => {
                      if (form.clientId === 'google' && profile.authType !== 'oauth') return false;
                      return true;
                    })
                    .map((profile) => ({
                      value: profile.id,
                      label:
                        profile.authType === 'oauth'
                          ? `${profile.displayName}（OAuth）`
                          : `${profile.displayName}（API Key）`,
                    })),
                ]}
                onChange={(value) => onChange({ accountRef: value, defaultModel: '', provider: '' })}
                disabled={loadingProfiles}
                required
              />
            )}
            <ComboField
              label="Model"
              ariaLabel="Model"
              value={form.defaultModel}
              onChange={(value) => onChange({ defaultModel: value })}
              suggestions={modelOptions}
              required={form.clientId !== 'kiro'}
              placeholder={
                form.clientId === 'kiro'
                  ? '可留空，使用 Kiro CLI 当前默认模型'
                  : form.clientId === 'opencode'
                    ? '例如 xiaomi-mimo/mimo-v2.5-pro 或 anthropic/claude-opus-4-6'
                    : '模型标识符，如 claude-sonnet-4-5'
              }
            />
            {modelOptionsError ? (
              <p className="rounded-[10px] bg-conn-red-bg px-3 py-2 text-[11px] font-bold text-conn-red-text">
                {modelOptionsError}
              </p>
            ) : null}
            {modelSource ? (
              <p className="text-[11px] leading-4 text-cafe-secondary">
                模型候选来源：
                <span className="ml-1 rounded-full bg-[var(--console-field-bg)] px-2 py-0.5 font-extrabold text-cafe">
                  {MODEL_SOURCE_LABELS[modelSource]}
                </span>
              </p>
            ) : null}
            {modelDrifted ? (
              <p className="rounded-[10px] bg-conn-orange-bg px-3 py-2 text-[11px] font-bold text-conn-orange-text">
                当前模型未在最近扫描中发现
              </p>
            ) : null}
            {cliEffortOptions ? (
              <SelectField
                label="思考等级"
                value={form.cliEffort}
                options={[
                  { value: '', label: '默认（按 Client）' },
                  ...cliEffortOptions.map((value) => ({ value, label: CLI_EFFORT_LABELS[value] ?? value })),
                ]}
                onChange={(value) => onChange({ cliEffort: value as HubCatEditorFormState['cliEffort'] })}
              />
            ) : null}
            {form.clientId === 'openai' ? (
              <label className="flex flex-col gap-1.5 text-cafe sm:flex-row sm:items-start sm:gap-[14px]">
                <span className="text-[12px] font-bold text-cafe-secondary sm:w-[150px] sm:shrink-0 sm:pt-1">
                  Fast Mode
                </span>
                <span className="flex min-w-0 flex-1 items-start gap-2 rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label="Codex Fast Mode"
                    checked={Boolean(form.cliFastMode)}
                    onChange={(event) => onChange({ cliFastMode: event.target.checked })}
                    className="mt-0.5 size-4 accent-[var(--cafe-accent)]"
                  />
                  <span className="text-xs leading-5 text-cafe-secondary">
                    开启 Codex 快速模式，保存时写入 <code>{CODEX_FAST_MODE_ARG}</code>。
                  </span>
                </span>
              </label>
            ) : null}
            <SelectField
              label="工具箱等级"
              value={form.toolPolicy}
              options={TOOL_POLICY_OPTIONS}
              onChange={(value) => onChange({ toolPolicy: value as HubCatEditorFormState['toolPolicy'] })}
            />
            {form.clientId === 'opencode' && selectedProfile?.authType === 'api_key' ? (
              <>
                <ComboField
                  label="Provider 名称"
                  ariaLabel="OC Provider Name"
                  value={form.provider}
                  onChange={(value) => onChange({ provider: value })}
                  suggestions={providerSuggestions}
                  required
                  placeholder="如 anthropic、openai、openai-responses、openrouter、maas"
                />
                <p className="text-[11px] leading-4 text-cafe-secondary">
                  OpenCode 根据 Provider 名称决定实际的 API 协议类型（如 openai → Chat Completions, anthropic →
                  Messages, openai-responses → Responses）
                </p>
              </>
            ) : null}
            {form.clientId === 'opencode' &&
            form.defaultModel.trim() &&
            !form.defaultModel.includes('/') &&
            !form.provider.trim() ? (
              <div className="rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2">
                <p className="text-[11px] leading-4 text-cafe-secondary">
                  建议使用 `providerId/modelId` 格式（例如 `openai/gpt-5.4`），部分 provider 需要前缀才能正确路由。
                </p>
              </div>
            ) : null}
            {callHint ? (
              <div className="rounded-[10px] bg-[var(--console-field-bg)] px-3 py-2">
                <p className="whitespace-pre-wrap text-[11px] leading-4 text-cafe-secondary">
                  {callHint.label}
                  <span className="font-semibold text-cafe">{callHint.url}</span>
                  {callHint.warning}
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}

export function RoutingSection({
  form,
  hasError,
  reservedPatterns,
  onChange,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  hasError?: boolean;
  /** Lowercase alias set already taken by other cats. */
  reservedPatterns?: ReadonlySet<string>;
  onChange: (patch: FormPatch) => void;
}) {
  const aliases = currentAliasTags(form);
  const validateAlias = useMemo(() => {
    if (!reservedPatterns?.size) return undefined;
    return (tag: string) => {
      if (reservedPatterns.has(tag.toLowerCase())) {
        return `别名 "${tag}" 已被其他成员使用`;
      }
      return null;
    };
  }, [reservedPatterns]);
  return (
    <SectionCard title="别名与 @ 路由" tone={hasError ? 'error' : 'neutral'}>
      <TagEditor
        tags={aliases}
        onChange={(tags) => onChange({ mentionPatterns: joinTags(tags) })}
        addLabel="+ 添加"
        placeholder="砚砚"
        emptyLabel="(至少添加 1 个别名，否则无法 @)"
        validate={validateAlias}
        minCount={1}
      />
      <textarea
        aria-label="Aliases"
        value={form.mentionPatterns}
        onChange={(event) => onChange({ mentionPatterns: event.target.value })}
        placeholder="@codex, @缅因猫"
        className="sr-only"
      />
    </SectionCard>
  );
}
