import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RichCardBlock } from '@/stores/chat-types';
import { BriefingCard } from '../BriefingCard';

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'markdown' }, content),
}));

describe('BriefingCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  const block: RichCardBlock = {
    id: 'briefing-1',
    kind: 'card',
    v: 1,
    title: '铲屎官 → 你 · 真相源: test_simple_3pages.py',
    fields: [
      { label: '传球', value: '铲屎官 → 你' },
      { label: '真相源', value: 'test_simple_3pages.py' },
      { label: '下一步', value: '先看 test_simple_3pages.py' },
    ],
    bodyMarkdown: '**传球**: 铲屎官 → 你\n\n**真相源**: test_simple_3pages.py',
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps navigation fields collapsed until the user opens details', () => {
    act(() => {
      root.render(<BriefingCard block={block} />);
    });

    expect(container.textContent).toContain('Context Briefing');
    expect(container.textContent).toContain(block.title);
    expect(container.textContent).toContain('点开看详情');
    expect(container.textContent).not.toContain('下一步先看 test_simple_3pages.py');
    expect(container.querySelector('[data-testid="markdown"]')).toBeNull();

    const toggle = container.querySelector('button');
    expect(toggle).not.toBeNull();
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('下一步先看 test_simple_3pages.py');
    expect(container.querySelector('[data-testid="markdown"]')?.textContent).toContain('真相源');
  });
});
