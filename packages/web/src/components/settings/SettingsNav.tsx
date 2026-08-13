'use client';

import { type CSSProperties, useState } from 'react';
import { usePinnedSections } from '@/hooks/usePinnedSections';
import { HubIcon } from '../hub-icons';
import {
  isDailySettingsSection,
  SETTINGS_GROUP_LABELS,
  SETTINGS_SECTIONS,
  type SettingsSection,
  type SettingsSectionGroup,
} from './settings-nav-config';

interface SettingsNavProps {
  activeSection: string;
  onSelect: (sectionId: string) => void;
  searchQuery?: string;
  variant?: 'sidebar' | 'strip';
}

function NavItem({
  section,
  active,
  pinned,
  pinningEnabled,
  onPin,
  onSelect,
  variant = 'sidebar',
}: {
  section: SettingsSection;
  active: boolean;
  pinned: boolean;
  pinningEnabled: boolean;
  onPin: () => void;
  onSelect: () => void;
  variant?: 'sidebar' | 'strip';
}) {
  const isStrip = variant === 'strip';

  return (
    <div className={`group relative flex items-center ${isStrip ? 'shrink-0' : ''}`}>
      <button
        type="button"
        onClick={onSelect}
        data-guide-id={`settings.${section.id}`}
        data-active={active ? 'true' : 'false'}
        className={`flex h-9 items-center gap-2 rounded-lg px-2.5 text-left transition-colors ${
          isStrip ? 'w-auto whitespace-nowrap' : 'w-full'
        } ${active ? 'bg-[var(--console-active-bg)] font-medium' : 'hover:bg-[var(--console-hover-bg)]'}`}
        style={
          active
            ? ({
                ['--console-active-bg' as string]: `color-mix(in srgb, ${section.color} 10%, var(--console-card-bg) 90%)`,
                color: section.color,
              } as CSSProperties)
            : undefined
        }
      >
        <span
          className="flex-shrink-0"
          style={active ? { color: section.color } : { color: 'var(--cafe-text-secondary)' }}
        >
          <HubIcon name={section.icon} className="h-4 w-4" />
        </span>
        <span className={`text-compact truncate ${active ? 'font-medium' : 'text-cafe-secondary'}`}>
          {section.label}
        </span>
      </button>
      {!isStrip && pinningEnabled && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
          className={`absolute right-1 h-6 w-6 flex items-center justify-center rounded transition-opacity ${
            pinned
              ? 'opacity-80 text-cafe-secondary'
              : 'opacity-0 pointer-events-none group-hover:opacity-60 group-hover:pointer-events-auto focus-visible:opacity-60 focus-visible:pointer-events-auto text-cafe-muted hover:text-cafe-secondary'
          }`}
          title={pinned ? '取消固定到侧栏' : '固定到侧栏'}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill={pinned ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.2"
            className="h-3 w-3"
          >
            <path d="M9.5 1.5l5 5-3 1-2 3-3.5-3.5-4 4M6.5 7L3 10.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );
}

const SETTINGS_GROUP_ORDER: SettingsSectionGroup[] = ['basic', 'advanced', 'experimental'];

const SECTION_KEYWORDS: Record<string, string> = {
  members: '猫猫 成员 名册 roster cat',
  accounts: '密钥 API key 账号 credentials',
  'cli-runtime':
    'CLI 运行环境 runtime profile 本机 local command override HTTP_PROXY HTTPS_PROXY NO_PROXY 代理 环境变量 Kiro Codex Claude',
  im: '飞书 钉钉 企微 telegram 微信 connector',
  skills: 'skill 技能 能力 marketplace',
  mcp: 'MCP tool 工具',
  plugins: '插件 集成 GitHub PR email calendar',
  voice: '语音 TTS STT whisper',
  rules: '规则 家规 提示词 system prompt SOP 协作 governance',
  system: '配置 环境 .env bubble A2A codex',
  notify: '推送 通知 push web',
  ops: '运维 监控 排行 记忆 健康 命令 救援 usage',
};

export function SettingsNav({ activeSection, onSelect, searchQuery, variant = 'sidebar' }: SettingsNavProps) {
  const { isPinned, pin, unpin } = usePinnedSections();
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<SettingsSectionGroup>>(() => new Set(['basic']));
  const q = searchQuery?.toLowerCase().trim() ?? '';
  const filtered = q
    ? SETTINGS_SECTIONS.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (SECTION_KEYWORDS[s.id] ?? '').toLowerCase().includes(q),
      )
    : variant === 'strip'
      ? SETTINGS_SECTIONS.filter(isDailySettingsSection)
      : SETTINGS_SECTIONS;

  const renderItem = (section: SettingsSection) => (
    <NavItem
      key={section.id}
      section={section}
      active={section.id === activeSection}
      pinned={isPinned(section.id)}
      pinningEnabled={isDailySettingsSection(section)}
      onPin={() => (isPinned(section.id) ? unpin(section.id) : pin(section.id))}
      onSelect={() => onSelect(section.id)}
      variant={variant}
    />
  );

  const toggleGroup = (group: SettingsSectionGroup) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) {
        next.delete(group);
      } else {
        next.add(group);
      }
      return next;
    });
  };

  return (
    <nav
      className={variant === 'strip' ? 'flex min-w-0 flex-row gap-1.5 overflow-x-auto pb-1' : 'flex flex-col gap-0.5'}
      aria-label="设置导航"
    >
      {filtered.length === 0 && q ? (
        <p className="console-card-soft rounded-xl px-4 py-3 text-xs text-cafe-muted">没有匹配的设置分区</p>
      ) : q || variant === 'strip' ? (
        filtered.map(renderItem)
      ) : (
        SETTINGS_GROUP_ORDER.map((group) => {
          const sections = filtered.filter((section) => section.group === group);
          if (sections.length === 0) return null;
          const expanded = expandedGroups.has(group);
          if (group === 'basic') {
            return (
              <div key={group} className="contents">
                {sections.map(renderItem)}
              </div>
            );
          }
          return (
            <div key={group} className="mt-2">
              <button
                type="button"
                onClick={() => toggleGroup(group)}
                className="flex w-full items-center justify-between rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-cafe-muted hover:bg-[var(--console-hover-bg)]"
                aria-expanded={expanded}
              >
                <span>{SETTINGS_GROUP_LABELS[group]}</span>
                <span aria-hidden="true">{expanded ? '−' : '+'}</span>
              </button>
              {expanded && <div className="mt-1 flex flex-col gap-0.5">{sections.map(renderItem)}</div>}
            </div>
          );
        })
      )}
    </nav>
  );
}
