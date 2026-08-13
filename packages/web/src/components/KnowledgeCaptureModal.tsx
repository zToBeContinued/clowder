'use client';

import type { FormEvent } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

type KnowledgeType = 'feature' | 'lesson' | 'decision';

interface KnowledgeCaptureResult {
  type: KnowledgeType;
  path: string;
  id: string;
}

interface KnowledgeCaptureModalProps {
  open: boolean;
  sourceThreadId: string;
  defaultTitle: string;
  onClose: () => void;
  onCreated: (result: KnowledgeCaptureResult) => void;
}

const TYPE_OPTIONS: Array<{ value: KnowledgeType; label: string; description: string }> = [
  { value: 'feature', label: 'Feature', description: '生成 docs/features/Fxxx-*.md' },
  { value: 'lesson', label: 'Lesson', description: '追加到 docs/public-lessons.md' },
  { value: 'decision', label: 'Decision', description: '生成 docs/decisions/0xx-*.md' },
];

export function KnowledgeCaptureModal({
  open,
  sourceThreadId,
  defaultTitle,
  onClose,
  onCreated,
}: KnowledgeCaptureModalProps) {
  const [type, setType] = useState<KnowledgeType>('lesson');
  const [title, setTitle] = useState(defaultTitle);
  const [summary, setSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgeCaptureResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setType('lesson');
    setTitle(defaultTitle);
    setSummary('');
    setIsSubmitting(false);
    setError(null);
    setResult(null);
  }, [defaultTitle, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSubmitting, onClose, open]);

  const canSubmit = useMemo(
    () => title.trim().length > 0 && summary.trim().length > 0 && !isSubmitting,
    [isSubmitting, summary, title],
  );

  if (!open) return null;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          title: title.trim(),
          summary: summary.trim(),
          sourceThreadId,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body?.error as string) ?? '沉淀失败，请稍后重试');
        return;
      }
      const created = body as KnowledgeCaptureResult;
      setResult(created);
      onCreated(created);
    } catch {
      setError('网络请求未完成，请稍后重试');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-[var(--console-overlay-backdrop)] px-4"
      role="presentation"
    >
      <div className="absolute inset-0" aria-hidden="true" onClick={isSubmitting ? undefined : onClose} />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="knowledge-capture-title"
        className="relative w-full max-w-[520px] rounded-2xl border border-[var(--slock-border-color)] bg-[var(--console-card-bg)] p-5 shadow-[var(--console-shadow)]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="knowledge-capture-title" className="text-xs font-bold tracking-[0.18em] text-[var(--cafe-text)]">
              沉淀为知识
            </h2>
            <p className="mt-1 text-xs leading-[1.5] text-[var(--cafe-text-secondary)]">
              手动把当前讨论沉淀成 Feature、Lesson 或 Decision。暂不做 AI 自动总结。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg px-2 py-1 text-sm text-[var(--cafe-text-muted)] transition-colors hover:bg-[var(--console-hover-bg)] hover:text-[var(--cafe-text)] disabled:opacity-50"
            aria-label="关闭沉淀弹窗"
          >
            ×
          </button>
        </div>

        <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
          <div>
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">类型</span>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setType(option.value)}
                  className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                    type === option.value
                      ? 'border-[var(--cafe-accent)] bg-[var(--console-card-soft-bg)] text-[var(--cafe-text)]'
                      : 'border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] text-[var(--cafe-text-secondary)] hover:bg-[var(--console-hover-bg)]'
                  }`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-1 block text-[11px] leading-[1.4] text-[var(--cafe-text-muted)]">
                    {option.description}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
              标题 *
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              className="mt-1 w-full rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] px-3 py-2 text-sm text-[var(--cafe-text)] outline-none transition-colors focus:border-[var(--cafe-accent)]"
              // biome-ignore lint/a11y/noAutofocus: 模态框由用户主动打开,聚焦首个必填字段是对话框焦点管理的标准做法
              autoFocus
            />
          </label>

          <label className="block">
            <span className="text-[11px] font-semibold tracking-[0.14em] text-[var(--cafe-text-secondary)]">
              摘要 / 描述 *
            </span>
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="写清楚这条知识要沉淀什么，后续 owner 可继续补 AC、根因或决策细节。"
              className="mt-1 min-h-32 w-full resize-none rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-shell-bg)] px-3 py-2 text-sm leading-[1.5] text-[var(--cafe-text)] outline-none transition-colors placeholder:text-[var(--cafe-text-muted)] focus:border-[var(--cafe-accent)]"
            />
          </label>

          {error && (
            <div className="rounded-lg border border-conn-crimson-ring bg-conn-crimson-bg px-3 py-2 text-xs text-conn-crimson-text">
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-lg border border-conn-green-ring bg-conn-green-bg px-3 py-2 text-xs leading-[1.5] text-conn-green-text">
              已生成：{result.id} → <code>{result.path}</code>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--cafe-text-secondary)] transition-colors hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
            >
              关闭
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-lg bg-[var(--cafe-accent)] px-3 py-2 text-sm font-semibold text-[var(--cafe-accent-foreground)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? '生成中...' : '生成文档'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
