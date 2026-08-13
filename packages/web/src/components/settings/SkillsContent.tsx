'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { CapabilityBoardItem } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import {
  SettingsResourceIconButton,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { PerCatToggles, ProjectSelector, ToggleSwitch } from './capability-settings-ui';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SkillPreviewModal } from './SkillPreviewModal';
import { useCapabilityState } from './useCapabilityState';

// 可安装的 skill 列表（从 /api/skills 获取全量）
interface AvailableSkill {
  name: string;
  category: string;
  trigger: string;
  mounts: { claude: boolean; codex: boolean; gemini: boolean; kimi: boolean };
}

function SkillInstallModal({
  installedNames,
  projectPath,
  onInstalled,
  onClose,
}: {
  installedNames: Set<string>;
  projectPath: string | null;
  onInstalled: () => void;
  onClose: () => void;
}) {
  const [available, setAvailable] = useState<AvailableSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const query = projectPath ? `?projectPath=${encodeURIComponent(projectPath)}` : '';
        const res = await apiFetch(`/api/skills${query}`);
        if (res.ok) {
          const data = (await res.json()) as { skills: AvailableSkill[] };
          setAvailable(data.skills);
        }
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    })();
  }, [projectPath]);

  const notInstalled = available.filter((s) => !installedNames.has(s.name));
  const filtered = filter
    ? notInstalled.filter(
        (s) =>
          s.name.includes(filter.toLowerCase()) ||
          s.category.toLowerCase().includes(filter.toLowerCase()) ||
          s.trigger.toLowerCase().includes(filter.toLowerCase()),
      )
    : notInstalled;

  const handleInstall = useCallback(async () => {
    if (selected.size === 0) return;
    setInstalling(true);
    try {
      const body: Record<string, unknown> = {
        skillNames: [...selected],
        providers: ['claude'],
      };
      if (projectPath) body.projectPath = projectPath;
      const res = await apiFetch('/api/skills/mount', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        onInstalled();
        onClose();
      }
    } catch {
      /* ignore */
    } finally {
      setInstalling(false);
    }
  }, [selected, projectPath, onInstalled, onClose]);

  const toggleSelect = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[70vh] flex flex-col rounded-2xl bg-[var(--console-card-bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-5 py-4">
          <h2 className="text-sm font-bold text-cafe">安装 Skill</h2>
          <button type="button" onClick={onClose} className="text-cafe-muted hover:text-cafe">
            <HubIcon name="x" className="h-5 w-5" />
          </button>
        </div>

        {/* 搜索 */}
        <div className="border-b border-[var(--console-border-soft)] px-5 py-3">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索 skill 名称、分类或触发词..."
            className="w-full rounded-lg border border-[var(--console-border-soft)] bg-transparent px-3 py-2 text-xs text-cafe placeholder:text-cafe-muted focus:border-[var(--color-cafe-accent)] focus:outline-none"
          />
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && <p className="text-xs text-cafe-muted">加载中...</p>}
          {!loading && filtered.length === 0 && (
            <p className="text-xs text-cafe-muted">
              {notInstalled.length === 0 ? '所有可用 Skill 已安装' : '没有匹配的 Skill'}
            </p>
          )}
          <div className="space-y-1">
            {filtered.map((skill) => (
              <label
                key={skill.name}
                className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-[var(--console-border-soft)]/30"
              >
                <input
                  type="checkbox"
                  checked={selected.has(skill.name)}
                  onChange={() => toggleSelect(skill.name)}
                  className="h-4 w-4 rounded border-[var(--console-border-soft)] accent-[var(--color-cafe-accent)]"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-cafe">{skill.name}</p>
                  <p className="truncate text-[11px] text-cafe-muted">
                    {skill.category} · {skill.trigger || '—'}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between border-t border-[var(--console-border-soft)] px-5 py-4">
          <span className="text-xs text-cafe-muted">
            {selected.size > 0 ? `已选 ${selected.size} 个` : '勾选要安装的 Skill'}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-xs font-medium text-cafe-muted hover:text-cafe"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleInstall}
              disabled={selected.size === 0 || installing}
              className="rounded-lg bg-[var(--color-cafe-accent)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {installing ? '安装中...' : `安装 (${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SkillsContent() {
  const cap = useCapabilityState('skill');
  const [previewItem, setPreviewItem] = useState<CapabilityBoardItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showInstall, setShowInstall] = useState(false);

  const installedNames = new Set(cap.items.map((i) => i.id));

  return (
    <div className="space-y-5">
      <SettingsPageHeader title="Skill 管理" subtitle="按需安装，即装即用，无需重启" />

      <ProjectSelector
        resolvedPath={cap.resolvedProjectPath}
        knownProjects={cap.knownProjects}
        currentSelection={cap.projectPath}
        onSwitch={cap.switchProject}
      />

      {/* 安装按钮 */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setShowInstall(true)}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--color-cafe-accent)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90"
        >
          <HubIcon name="plus" className="h-3.5 w-3.5" />
          安装 Skill
        </button>
        {cap.items.length > 0 && (
          <span className="flex items-center text-xs text-cafe-muted">已安装 {cap.items.length} 个</span>
        )}
      </div>

      {cap.loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse rounded-xl bg-[var(--console-card-bg)] p-4">
              <div className="h-4 w-1/3 rounded bg-[var(--console-border-soft)]" />
              <div className="mt-2 h-3 w-2/3 rounded bg-[var(--console-border-soft)]" />
            </div>
          ))}
        </div>
      )}

      {!cap.loading && cap.items.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--console-card-bg)] px-8 py-16 text-center">
          <HubIcon name="zap" className="mb-3 h-10 w-10 text-cafe-muted opacity-40" />
          <p className="text-[15px] font-semibold text-cafe">暂无已安装的 Skill</p>
          <p className="mt-1 text-xs text-cafe-muted">点击上方「安装 Skill」按需添加</p>
        </div>
      )}

      <div className="space-y-3">
        {cap.items.map((item) => {
          const busy = cap.toggling === item.id;
          const expanded = expandedId === item.id;
          return (
            <div key={item.id} className={settingsResourceCardClass}>
              <div className={settingsResourceRowClass}>
                <svg
                  className="h-[18px] w-[18px] shrink-0 text-cafe-muted"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <circle cx="9" cy="5" r="1.5" />
                  <circle cx="15" cy="5" r="1.5" />
                  <circle cx="9" cy="12" r="1.5" />
                  <circle cx="15" cy="12" r="1.5" />
                  <circle cx="9" cy="19" r="1.5" />
                  <circle cx="15" cy="19" r="1.5" />
                </svg>
                <button
                  type="button"
                  onClick={() => setPreviewItem(item)}
                  className="flex min-w-0 flex-1 items-center gap-4 text-left"
                >
                  <div className={settingsResourceAvatarClass}>{item.id.charAt(0).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-cafe">{item.id}</p>
                    <p className="mt-0.5 truncate text-xs text-cafe-secondary">{item.description || '—'}</p>
                    {item.category && <p className="mt-0.5 text-label text-cafe-muted">{item.category}</p>}
                  </div>
                </button>
                <div className={settingsResourceActionGroupClass}>
                  {cap.catFamilies.length > 0 && (
                    <SettingsResourceIconButton
                      onClick={() => setExpandedId(expanded ? null : item.id)}
                      title="按猫开关"
                      aria-label="按猫开关"
                    >
                      <HubIcon name="users" className="h-4 w-4" />
                    </SettingsResourceIconButton>
                  )}
                  <ToggleSwitch
                    enabled={item.enabled}
                    busy={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      cap.handleToggle(item, !item.enabled);
                    }}
                  />
                  <SettingsResourceIconButton
                    onClick={(e) => {
                      e.stopPropagation();
                      cap.unmountSkills([item.id]);
                    }}
                    title="卸载 Skill"
                    aria-label="卸载 Skill"
                    tone="danger"
                  >
                    <HubIcon name="trash" className="h-4 w-4" />
                  </SettingsResourceIconButton>
                </div>
              </div>
              {expanded && (
                <PerCatToggles
                  item={item}
                  catFamilies={cap.catFamilies}
                  toggling={cap.toggling}
                  onToggle={cap.handleToggle}
                />
              )}
            </div>
          );
        })}
      </div>

      {previewItem && (
        <SkillPreviewModal
          skillId={previewItem.id}
          skillName={previewItem.id}
          description={previewItem.description}
          triggers={previewItem.triggers}
          category={previewItem.category}
          projectPath={cap.projectPath}
          onClose={() => setPreviewItem(null)}
        />
      )}

      {showInstall && (
        <SkillInstallModal
          installedNames={installedNames}
          projectPath={cap.projectPath}
          onInstalled={cap.refetch}
          onClose={() => setShowInstall(false)}
        />
      )}
    </div>
  );
}
