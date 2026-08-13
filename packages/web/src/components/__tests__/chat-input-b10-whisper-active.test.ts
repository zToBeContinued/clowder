/**
 * F122B AC-B10: Whisper mode disables actively-executing cats.
 *
 * 2026-08 更新:slock 大改(eb5fe913)移除了 composer 的 whisper 入口与
 * 排队 placeholder,ChatInput 的 whisperMode 恒为 false、WhisperCatSelector
 * 不再可达。AC-B10 的存活语义(执行中的猫在耳语选择器中禁用/带「执行中」
 * 徽章/点击无效)落在 WhisperCatSelector 组件层,本文件在该层继续守护;
 * 另以 composer 现状断言固化「入口移除 + 排队 placeholder 退役」。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { WhisperCatSelector } from '@/components/WhisperCatSelector';
import { useChatStore } from '@/stores/chatStore';

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

const MOCK_CATS = [
  {
    id: 'opus',
    displayName: '布偶猫',
    color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
    mentionPatterns: ['布偶', 'opus'],
    clientId: 'anthropic',
    defaultModel: 'opus',
    avatar: '/a.png',
    roleDescription: 'dev',
    personality: 'kind',
  },
  {
    id: 'codex',
    displayName: '缅因猫',
    color: { primary: '#4CAF50', secondary: '#C8E6C9' },
    mentionPatterns: ['缅因', 'codex'],
    clientId: 'openai',
    defaultModel: 'codex',
    avatar: '/b.png',
    roleDescription: 'review',
    personality: 'steady',
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
  useChatStore.setState({ activeInvocations: {}, hasActiveInvocation: false });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderSelector(overrides: Partial<React.ComponentProps<typeof WhisperCatSelector>> = {}) {
  const props = {
    cats: MOCK_CATS as never,
    selected: new Set<string>(),
    activeCatIds: new Set<string>(),
    onToggle: vi.fn(),
    ...overrides,
  };
  act(() => root.render(React.createElement(WhisperCatSelector, props)));
  return props;
}

function getChips() {
  const popup = container.querySelector('.absolute.bottom-full');
  if (!popup) return [];
  return [...popup.querySelectorAll('button')];
}

describe('F122B AC-B10: executing cats in whisper selector (WhisperCatSelector level)', () => {
  it('disables executing cat chips and keeps idle cats selectable', () => {
    renderSelector({ activeCatIds: new Set(['opus']) });

    const chips = getChips();
    const opusChip = chips.find((b) => b.textContent?.includes('布偶猫'));
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));

    expect(opusChip).toBeDefined();
    expect(codexChip).toBeDefined();
    expect(opusChip?.disabled).toBe(true);
    expect(codexChip?.disabled).toBe(false);
    expect(opusChip?.className).toContain('cursor-not-allowed');
  });

  it('mousedown on executing cat does NOT toggle; idle cat toggles', () => {
    const { onToggle } = renderSelector({ activeCatIds: new Set(['opus']) });

    const chips = getChips();
    const opusChip = chips.find((b) => b.textContent?.includes('布偶猫'));
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));

    act(() => opusChip?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onToggle).not.toHaveBeenCalled();

    act(() => codexChip?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onToggle).toHaveBeenCalledWith('codex');
  });

  it('shows "执行中" status badge on executing cat row', () => {
    renderSelector({ activeCatIds: new Set(['codex']) });

    const chips = getChips();
    const codexChip = chips.find((b) => b.textContent?.includes('缅因猫'));
    expect(codexChip?.textContent).toContain('执行中');
  });

  it('F108B P1-1: with empty selection, no chip is pre-selected (executing or idle)', () => {
    renderSelector({ activeCatIds: new Set(['opus']) });

    for (const chip of getChips()) {
      expect(chip.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');
    }
  });

  it('all cats selectable and none pre-selected when none are executing', () => {
    renderSelector();

    const chips = getChips();
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.disabled).toBe(false);
      expect(chip.className.split(/\s+/)).not.toContain('bg-cafe-surface-elevated');
    }
  });
});

describe('composer whisper posture (slock overhaul)', () => {
  it('no whisper entry and no selector popup, even while a cat is executing', () => {
    useChatStore.setState({
      activeInvocations: { 'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } } as never,
      hasActiveInvocation: true,
    });
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));

    expect(container.querySelector('[aria-label="Whisper mode"]')).toBeNull();
    expect(container.textContent).not.toContain('悄悄话目标');
  });

  it('queue placeholder retired: placeholder stays default while a cat is executing', () => {
    useChatStore.setState({
      activeInvocations: { 'inv-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } } as never,
      hasActiveInvocation: true,
    });
    act(() => root.render(React.createElement(ChatInput, { onSend: vi.fn(), hasActiveInvocation: true })));

    const textarea = container.querySelector('textarea')!;
    // eb5fe913 前:执行中显示「继续输入,消息会排队...」;现统一为默认 placeholder。
    expect(textarea.placeholder).toBe('输入消息 #当前对话');
  });
});
