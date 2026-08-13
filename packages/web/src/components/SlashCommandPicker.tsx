'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface SlashCommandItem {
  id: string;
  name: string;
  category: string;
  command: string;
  description: string;
  rawTrigger: string;
}

interface SkillEntry {
  name: string;
  category?: string;
  trigger?: string;
  description?: string;
}

interface SkillsResponse {
  skills?: SkillEntry[];
}

interface CommandEntry {
  name: string;
  usage?: string;
  category?: string;
  description?: string;
  source?: string;
  skillId?: string;
}

interface CommandsResponse {
  commands?: CommandEntry[];
}

interface SlashCommandPickerProps {
  query: string;
  selectedIdx: number;
  onSelectIdx: (idx: number) => void;
  onPick: (item: SlashCommandItem) => void;
  onItemsChange: (items: SlashCommandItem[]) => void;
}

function resolveCommand(skill: SkillEntry): string {
  const firstTrigger = skill.trigger
    ?.split(/[、,\s]+/)
    .map((part) => part.trim())
    .find(Boolean);
  if (firstTrigger?.startsWith('/')) return firstTrigger;
  return `/${skill.name}`;
}

function skillToItem(skill: SkillEntry): SlashCommandItem {
  const command = resolveCommand(skill);
  return {
    id: skill.name,
    name: skill.name,
    category: skill.category ?? '未分类',
    command,
    description: skill.description ?? skill.name,
    rawTrigger: skill.trigger ?? '',
  };
}

function commandToItem(command: CommandEntry): SlashCommandItem {
  return {
    id: `${command.source ?? 'command'}:${command.skillId ?? 'core'}:${command.name}`,
    name: command.skillId ?? command.name,
    category: command.category ?? '命令',
    command: command.name,
    description: command.description ?? command.usage ?? command.name,
    rawTrigger: command.usage ?? command.name,
  };
}

export function SlashCommandPicker({
  query,
  selectedIdx,
  onSelectIdx,
  onPick,
  onItemsChange,
}: SlashCommandPickerProps) {
  const [items, setItems] = useState<SlashCommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadSkills = async () => {
      const res = await apiFetch('/api/skills');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SkillsResponse;
      return (data.skills ?? []).map(skillToItem);
    };

    apiFetch('/api/commands?surface=web')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as CommandsResponse;
        const commandItems = (data.commands ?? []).map(commandToItem);
        return commandItems.length > 0 ? commandItems : loadSkills();
      })
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch(async () => {
        try {
          const next = await loadSkills();
          if (!cancelled) setItems(next);
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : '加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => {
      const haystack =
        `${item.command} ${item.name} ${item.category} ${item.description} ${item.rawTrigger}`.toLowerCase();
      return haystack.includes(needle);
    });
  }, [items, query]);

  useEffect(() => {
    onItemsChange(filtered);
  }, [filtered, onItemsChange]);

  return (
    <div
      data-testid="slash-command-picker"
      className="absolute bottom-[calc(100%+8px)] left-0 z-20 flex max-h-80 w-[360px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface shadow-lg"
    >
      <div className="border-b border-[var(--console-border-soft)] px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-cafe-muted">
        Commands
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {filtered.map((item, idx) => (
          <button
            key={item.id}
            type="button"
            className={`flex w-full items-start gap-3 border-l-2 py-2 pr-3 pl-[10px] text-left transition-colors ${
              idx === selectedIdx
                ? 'border-[var(--cafe-accent)] bg-[var(--console-active-bg)]'
                : 'border-transparent hover:bg-[var(--console-hover-bg)]'
            }`}
            onMouseEnter={() => onSelectIdx(idx)}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(item);
            }}
          >
            <span className="mt-0.5 rounded-md border border-[var(--console-border-soft)] bg-[var(--console-hover-bg)] px-1.5 py-0.5 font-mono text-xs font-semibold text-cafe-accent">
              {item.command}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate text-sm font-semibold ${
                  idx === selectedIdx ? 'text-[var(--console-active-fg)]' : 'text-cafe-text'
                }`}
              >
                {item.name}
              </span>
              <span
                className={`block truncate text-xs leading-[1.45] ${
                  idx === selectedIdx ? 'text-[var(--console-active-muted)]' : 'text-cafe-muted'
                }`}
              >
                {item.category} · {item.description}
              </span>
            </span>
          </button>
        ))}
        {!loading && filtered.length === 0 && <div className="px-3 py-3 text-sm text-cafe-muted">没有匹配的命令</div>}
        {loading && <div className="px-3 py-3 text-sm text-cafe-muted">正在加载命令...</div>}
        {error && <div className="px-3 py-3 text-sm text-conn-red-text">加载失败：{error}</div>}
      </div>
      <div className="border-t border-[var(--console-border-soft)] px-3 py-1.5 text-[11px] text-cafe-muted">
        ↑↓ 选择 · Enter 插入 · Esc 关闭
      </div>
    </div>
  );
}
