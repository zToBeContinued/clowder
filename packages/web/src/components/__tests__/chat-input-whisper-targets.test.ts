/**
 * F32-b Phase 3: Regression test for whisper target selection.
 *
 * Verifies that cats with empty mentionPatterns still appear in the
 * whisper target list and can be toggled. This prevents re-coupling
 * whisper targets to the mention-filtered catOptions in future refactors.
 *
 * 2026-08 更新:slock 大改(eb5fe913)移除了 composer 的 whisper 入口
 * (aria-label="Whisper mode" 按钮),ChatInput 内 whisperMode 恒为 false。
 * 防回耦合契约降到 WhisperCatSelector 组件层继续守护;另以一条固化断言
 * 记录「composer 当前无 whisper 入口」的产品现状。
 */
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { WhisperCatSelector } from '@/components/WhisperCatSelector';

// ── Mocks ──
vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (f: File) => Promise.resolve(f) }));

// Two cats: one with mentionPatterns, one without (non-default variant)
const MOCK_CATS = [
  {
    id: 'opus',
    displayName: '布偶猫',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['布偶', '布偶猫', 'opus'],
    clientId: 'anthropic',
    defaultModel: 'opus',
    avatar: '/a.png',
    roleDescription: 'dev',
    personality: 'kind',
  },
  {
    id: 'opus-fast',
    displayName: '布偶猫(快)',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: [] as string[],
    clientId: 'anthropic',
    defaultModel: 'opus-fast',
    avatar: '/a.png',
    roleDescription: '快速变体',
    personality: 'kind',
  },
];

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName: string; variantLabel?: string }) =>
    cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName,
  useCatData: () => ({
    cats: MOCK_CATS,
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

// ── Setup ──
let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 受控 harness:复刻 ChatInput 原有的 whisperTargets Set 状态语义 */
function SelectorHarness() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const onToggle = (catId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  };
  return React.createElement(WhisperCatSelector, {
    cats: MOCK_CATS as never,
    selected,
    activeCatIds: new Set<string>(),
    onToggle,
  });
}

describe('whisper targets with empty mentionPatterns (WhisperCatSelector level)', () => {
  it('shows all cats including those with empty mentionPatterns as whisper targets', () => {
    act(() => {
      root.render(React.createElement(SelectorHarness));
    });

    // F108 Scene 2 v2: floating popup with "悄悄话目标 · 可多选"
    expect(container.textContent).toContain('悄悄话目标');

    // Both cats should appear as rows inside the floating popup (absolute bottom-full)
    const popup = container.querySelector('.absolute.bottom-full');
    expect(popup).not.toBeNull();
    const selectorRows = [...popup!.querySelectorAll('button')];
    const rowTexts = selectorRows.map((b) => b.textContent);

    expect(rowTexts.some((t) => t?.includes('布偶猫'))).toBe(true);
    expect(rowTexts.some((t) => t?.includes('布偶猫(快)'))).toBe(true);
  });

  it('can toggle a whisper target with empty mentionPatterns', () => {
    act(() => {
      root.render(React.createElement(SelectorHarness));
    });

    const popup = container.querySelector('.absolute.bottom-full')!;
    const getRows = () => [...popup.querySelectorAll('button')];
    let fastBtn = getRows().find((b) => b.textContent?.includes('布偶猫(快)'));
    expect(fastBtn).toBeDefined();

    // F108B P1-1: default is NO cats selected — no elevated background
    expect(fastBtn?.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');

    // mousedown to select — should show elevated background
    act(() => fastBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    fastBtn = getRows().find((b) => b.textContent?.includes('布偶猫(快)'));
    expect(fastBtn?.className.split(/\s+/)).toContain('bg-cafe-surface-elevated');

    // mousedown to deselect
    act(() => fastBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    fastBtn = getRows().find((b) => b.textContent?.includes('布偶猫(快)'));
    expect(fastBtn?.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');

    // mousedown again to re-select
    act(() => fastBtn?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    fastBtn = getRows().find((b) => b.textContent?.includes('布偶猫(快)'));
    expect(fastBtn?.className.split(/\s+/)).toContain('bg-cafe-surface-elevated');
  });
});

describe('composer whisper posture (slock overhaul)', () => {
  it('ChatInput no longer renders a whisper entry — selector is unreachable from composer', () => {
    act(() => {
      root.render(React.createElement(ChatInput, { onSend: vi.fn() }));
    });

    // 入口按钮已随 eb5fe913 移除;若未来恢复 whisper 入口,此断言会失败,
    // 提醒把上面的组件级契约测试升回 ChatInput 集成级。
    expect(container.querySelector('[aria-label="Whisper mode"]')).toBeNull();
    expect(container.textContent).not.toContain('悄悄话目标');
  });
});
