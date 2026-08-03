'use client';

import { useEffect, useMemo } from 'react';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import type { ThreadKeywordRoutingRuleV1, ThreadRoutingPolicyV1 } from '@/stores/chat-types';

interface AgentOrderEditorProps {
  label: string;
  ids: string[];
  availableCats: CatData[];
  disabled: boolean;
  maxItems?: number;
  onChange: (ids: string[]) => void;
}

interface ChannelRoutingSettingsProps {
  availableCats: CatData[];
  policy?: ThreadRoutingPolicyV1;
  disabled?: boolean;
  onChange: (policy: ThreadRoutingPolicyV1 | undefined) => void;
  onValidityChange?: (valid: boolean) => void;
}

const inputClass =
  'w-full rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-card-bg)] px-2.5 py-2 text-xs text-[var(--cafe-text)] outline-none focus:border-[var(--cafe-accent)] disabled:opacity-50';
const MAX_FALLBACK_CATS = 10;
const MAX_RULE_KEYWORDS = 12;
const MAX_KEYWORD_LENGTH = 50;

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

function updateOptionalArray<T extends object, K extends keyof T>(value: T, key: K, items: string[]): T {
  const next = { ...value };
  if (items.length > 0) next[key] = items as T[K];
  else delete next[key];
  return next;
}

function AgentOrderEditor({
  label,
  ids,
  availableCats,
  disabled,
  maxItems = MAX_FALLBACK_CATS,
  onChange,
}: AgentOrderEditorProps) {
  const catsById = useMemo(() => new Map(availableCats.map((cat) => [cat.id, cat])), [availableCats]);
  const orderedIds = uniqueIds(ids);
  const addable = orderedIds.length >= maxItems ? [] : availableCats.filter((cat) => !orderedIds.includes(cat.id));

  const move = (index: number, offset: number) => {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= orderedIds.length) return;
    const next = [...orderedIds];
    const current = next[index];
    const adjacent = next[nextIndex];
    if (!current || !adjacent) return;
    next[index] = adjacent;
    next[nextIndex] = current;
    onChange(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-[var(--cafe-text-secondary)]">{label}</span>
        <select
          value=""
          disabled={disabled || addable.length === 0}
          onChange={(event) => {
            if (event.target.value) onChange([...orderedIds, event.target.value]);
          }}
          className="max-w-[160px] rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-card-bg)] px-2 py-1.5 text-xs text-[var(--cafe-text)] outline-none focus:border-[var(--cafe-accent)] disabled:opacity-50"
          aria-label={`添加${label}`}
        >
          <option value="">+ 添加</option>
          {addable.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {formatCatName(cat)}
            </option>
          ))}
        </select>
      </div>
      {orderedIds.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {orderedIds.map((id, index) => {
            const cat = catsById.get(id);
            return (
              <div key={id} className="flex min-h-8 items-center gap-1.5 rounded-lg bg-[var(--console-shell-bg)] px-2">
                <span className="min-w-0 flex-1 truncate text-xs text-[var(--cafe-text)]">
                  {cat ? formatCatName(cat) : id}
                </span>
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={disabled || index === 0}
                  className="h-7 w-7 rounded-md text-sm text-[var(--cafe-text-muted)] hover:bg-[var(--console-hover-bg)] disabled:opacity-30"
                  aria-label={`上移 ${id}`}
                  title="上移"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={disabled || index === orderedIds.length - 1}
                  className="h-7 w-7 rounded-md text-sm text-[var(--cafe-text-muted)] hover:bg-[var(--console-hover-bg)] disabled:opacity-30"
                  aria-label={`下移 ${id}`}
                  title="下移"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onChange(orderedIds.filter((candidate) => candidate !== id))}
                  disabled={disabled}
                  className="h-7 w-7 rounded-md text-sm text-[var(--cafe-text-muted)] hover:bg-[var(--console-hover-bg)] hover:text-conn-crimson-text disabled:opacity-30"
                  aria-label={`移除 ${id}`}
                  title="移除"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function makeRule(index: number): ThreadKeywordRoutingRuleV1 {
  return {
    id: `route-${Date.now().toString(36)}-${index}`,
    label: '',
    keywords: [],
    targetCat: '',
  };
}

export function getChannelRoutingPolicyError(policy?: ThreadRoutingPolicyV1): string | null {
  if (policy?.unmentionedMode === 'default' && !policy.defaultCat) return '请先选择默认 Agent。';
  if (uniqueIds(policy?.fallbackCats ?? []).filter((id) => id !== policy?.defaultCat).length > MAX_FALLBACK_CATS) {
    return '默认 fallback 最多配置 10 个 Agent。';
  }
  return (policy?.rules ?? []).map(getKeywordRuleError).find((error) => error !== null) ?? null;
}

function getKeywordRuleError(rule: ThreadKeywordRoutingRuleV1): string | null {
  if (!rule.id.trim() || !rule.label.trim() || !rule.targetCat || !rule.keywords.some((keyword) => keyword.trim())) {
    return '请补全规则的名称、关键词和目标 Agent。';
  }
  const keywords = [...new Set(rule.keywords.map((keyword) => keyword.trim()).filter(Boolean))];
  if (keywords.length > MAX_RULE_KEYWORDS) return '每条规则最多配置 12 个关键词。';
  if (keywords.some((keyword) => keyword.length > MAX_KEYWORD_LENGTH)) return '单个关键词最多 50 个字符。';
  const fallbackCats = uniqueIds(rule.fallbackCats ?? []).filter((id) => id !== rule.targetCat);
  return fallbackCats.length > MAX_FALLBACK_CATS ? '规则 fallback 最多配置 10 个 Agent。' : null;
}

export function isChannelRoutingPolicyValid(policy?: ThreadRoutingPolicyV1): boolean {
  return getChannelRoutingPolicyError(policy) === null;
}

export function normalizeChannelRoutingPolicy(policy?: ThreadRoutingPolicyV1): ThreadRoutingPolicyV1 | null {
  if (!policy) return null;
  const next: ThreadRoutingPolicyV1 = { v: 1 };
  if (policy.scopes && Object.keys(policy.scopes).length > 0) next.scopes = policy.scopes;
  if (policy.unmentionedMode === 'default' && policy.defaultCat) {
    next.unmentionedMode = 'default';
    next.defaultCat = policy.defaultCat;
    const fallbackCats = uniqueIds(policy.fallbackCats ?? []).filter((id) => id !== policy.defaultCat);
    if (fallbackCats.length > 0) next.fallbackCats = fallbackCats;
  }
  if (Array.isArray(policy.rules) && policy.rules.length > 0) {
    next.rules = policy.rules.map((rule) => ({
      id: rule.id.trim(),
      label: rule.label.trim(),
      keywords: [...new Set(rule.keywords.map((keyword) => keyword.trim()).filter(Boolean))],
      targetCat: rule.targetCat,
      ...(rule.fallbackCats?.length
        ? { fallbackCats: uniqueIds(rule.fallbackCats).filter((id) => id !== rule.targetCat) }
        : {}),
    }));
  }
  return Object.keys(next).length > 1 ? next : null;
}

export function ChannelRoutingSettings({
  availableCats,
  policy,
  disabled = false,
  onChange,
  onValidityChange,
}: ChannelRoutingSettingsProps) {
  const mode = policy?.unmentionedMode ?? 'continue';
  const rules = policy?.rules ?? [];
  const validationError = getChannelRoutingPolicyError(policy);
  const valid = validationError === null;

  useEffect(() => onValidityChange?.(valid), [onValidityChange, valid]);

  const patchPolicy = (patch: Partial<ThreadRoutingPolicyV1>) => {
    onChange({ v: 1, ...policy, ...patch });
  };
  const updateRule = (index: number, nextRule: ThreadKeywordRoutingRuleV1) => {
    const nextRules = [...rules];
    nextRules[index] = nextRule;
    patchPolicy({ rules: nextRules });
  };

  return (
    <div className="space-y-4 border-t border-[var(--slock-border-color)] pt-4">
      <div className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
        COLLABORATION ROUTING
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="text-[11px] font-semibold text-[var(--cafe-text-secondary)]">DEFAULT AGENT</span>
          <select
            value={policy?.defaultCat ?? ''}
            disabled={disabled}
            onChange={(event) => patchPolicy({ defaultCat: event.target.value || undefined })}
            className={`mt-1 ${inputClass}`}
          >
            <option value="">未设置</option>
            {availableCats.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {formatCatName(cat)}
              </option>
            ))}
          </select>
        </label>

        <div>
          <span className="text-[11px] font-semibold text-[var(--cafe-text-secondary)]">NO @ ROUTING</span>
          <div className="mt-1 grid grid-cols-2 overflow-hidden rounded-lg border border-[var(--slock-border-color)]">
            {[
              ['continue', '继续当前对话'],
              ['default', '固定交给默认 Agent'],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={disabled}
                onClick={() => patchPolicy({ unmentionedMode: value as 'continue' | 'default' })}
                className={`min-h-9 px-2 text-xs transition-colors disabled:opacity-50 ${
                  mode === value
                    ? 'bg-[var(--cafe-accent)] text-[var(--cafe-accent-foreground)]'
                    : 'bg-[var(--console-card-bg)] text-[var(--cafe-text-secondary)] hover:bg-[var(--console-hover-bg)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === 'default' && (
        <AgentOrderEditor
          label="DEFAULT FALLBACKS"
          ids={policy?.fallbackCats ?? []}
          availableCats={availableCats.filter((cat) => cat.id !== policy?.defaultCat)}
          disabled={disabled}
          onChange={(ids) => patchPolicy({ fallbackCats: uniqueIds(ids) })}
        />
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold text-[var(--cafe-text-secondary)]">ROUTING RULES</span>
          <button
            type="button"
            disabled={disabled || rules.length >= 20}
            onClick={() => patchPolicy({ rules: [...rules, makeRule(rules.length)] })}
            className="console-button-secondary rounded-lg px-2.5 py-1.5 text-xs disabled:opacity-50"
          >
            + 添加规则
          </button>
        </div>

        {rules.length === 0 && (
          <p className="rounded-lg border border-dashed border-[var(--slock-border-color)] px-3 py-2 text-xs text-[var(--cafe-text-muted)]">
            暂无关键词路由规则。没有显式 @ 且未命中规则时，将按上方设置继续路由。
          </p>
        )}

        {rules.map((rule, index) => (
          <div key={rule.id} className="space-y-3 border-l-2 border-[var(--cafe-accent)] pl-3">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_32px]">
              <input
                value={rule.label}
                disabled={disabled}
                maxLength={60}
                placeholder="职责名称"
                aria-label={`规则 ${index + 1} 职责名称`}
                onChange={(event) => updateRule(index, { ...rule, label: event.target.value })}
                className={inputClass}
              />
              <input
                value={rule.keywords.join(', ')}
                disabled={disabled}
                placeholder="关键词，用逗号分隔"
                aria-label={`规则 ${index + 1} 关键词`}
                onChange={(event) =>
                  updateRule(index, {
                    ...rule,
                    keywords: event.target.value.split(/[,，\n]/).map((keyword) => keyword.trim()),
                  })
                }
                className={inputClass}
              />
              <button
                type="button"
                disabled={disabled}
                onClick={() => patchPolicy({ rules: rules.filter((_, candidateIndex) => candidateIndex !== index) })}
                className="h-8 w-8 self-center rounded-md text-base text-[var(--cafe-text-muted)] hover:bg-[var(--console-hover-bg)] hover:text-conn-crimson-text disabled:opacity-50"
                aria-label={`删除规则 ${rule.label || index + 1}`}
                title="删除规则"
              >
                ×
              </button>
            </div>

            <label className="block">
              <span className="text-[11px] font-semibold text-[var(--cafe-text-secondary)]">TARGET AGENT</span>
              <select
                value={rule.targetCat}
                disabled={disabled}
                onChange={(event) => updateRule(index, { ...rule, targetCat: event.target.value })}
                className={`mt-1 ${inputClass}`}
              >
                <option value="">选择 Agent</option>
                {availableCats.map((cat) => (
                  <option key={cat.id} value={cat.id}>
                    {formatCatName(cat)}
                  </option>
                ))}
              </select>
            </label>

            <AgentOrderEditor
              label="RULE FALLBACKS"
              ids={rule.fallbackCats ?? []}
              availableCats={availableCats.filter((cat) => cat.id !== rule.targetCat)}
              disabled={disabled}
              onChange={(ids) => updateRule(index, updateOptionalArray(rule, 'fallbackCats', uniqueIds(ids)))}
            />
          </div>
        ))}
      </div>

      {!valid && <p className="text-xs text-conn-crimson-text">{validationError}</p>}
    </div>
  );
}
