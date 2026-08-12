'use client';

import type { CatOption } from './chat-input-options';

interface MentionPickerProps {
  options: CatOption[];
  selectedIdx: number;
  onSelectIdx: (idx: number) => void;
  onPick: (option: CatOption) => void;
}

export function MentionPicker({ options, selectedIdx, onSelectIdx, onPick }: MentionPickerProps) {
  return (
    <div
      data-testid="mention-picker"
      className="absolute bottom-[calc(100%+8px)] left-0 z-20 flex max-h-80 w-[24rem] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface shadow-lg"
    >
      <div className="border-b border-[var(--console-border-soft)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-cafe-muted">
        Agents
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {options.map((option, idx) => (
          <button
            key={option.id}
            type="button"
            className={`flex w-full items-start gap-3 border-l-2 py-2 pr-3 pl-[10px] text-left transition-colors ${
              idx === selectedIdx
                ? 'border-[var(--cafe-accent)] bg-[var(--console-active-bg)]'
                : 'border-transparent hover:bg-[var(--console-hover-bg)]'
            }`}
            onMouseEnter={() => onSelectIdx(idx)}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(option);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={option.avatar}
              alt={option.label}
              className="mt-0.5 h-8 w-8 flex-shrink-0 rounded-md"
              onError={(event) => {
                (event.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate text-sm font-semibold ${
                  idx === selectedIdx ? 'text-[var(--console-active-fg)]' : 'text-cafe-text'
                }`}
              >
                {option.label}
              </span>
              {/* 职责/擅长（roleDescription）是选人依据，两行截断保证可读 */}
              <span
                className={`mt-0.5 line-clamp-2 block text-xs leading-relaxed ${
                  idx === selectedIdx ? 'text-[var(--console-active-muted)]' : 'text-cafe-muted'
                }`}
              >
                {option.desc || option.id}
              </span>
            </span>
          </button>
        ))}
        {options.length === 0 && <div className="px-3 py-3 text-sm text-cafe-muted">没有匹配的 Agent</div>}
      </div>
      <div className="border-t border-[var(--console-border-soft)] px-3 py-1.5 text-[11px] text-cafe-muted">
        ↑↓ 选择 · Enter 插入 · Esc 关闭
      </div>
    </div>
  );
}
