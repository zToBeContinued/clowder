import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditChannelModal } from '../EditChannelModal';

const cats = [
  {
    id: 'cursor',
    displayName: 'Cursor Auto',
    color: { primary: '#3E63DD', secondary: '#E1E9FF' },
    mentionPatterns: ['@cursor'],
    clientId: 'cursor',
    defaultModel: '',
    avatar: '',
    roleDescription: '实现',
    personality: '',
  },
  {
    id: 'codex',
    displayName: 'Codex',
    color: { primary: '#12A594', secondary: '#D6F5F0' },
    mentionPatterns: ['@codex'],
    clientId: 'openai',
    defaultModel: 'gpt-5.6-sol',
    avatar: '',
    roleDescription: '治理',
    personality: '',
  },
];

const baseProps = {
  open: true,
  title: 'Quant',
  availableCats: cats,
  selectedCatIds: ['cursor', 'codex'],
  isDefaultThread: false,
  isSaving: false,
  isDeleting: false,
  onClose: vi.fn(),
  onSave: vi.fn(),
  onDelete: vi.fn(),
};

describe('EditChannelModal routing settings', () => {
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
    vi.clearAllMocks();
  });

  it('shows the configured default agent, no-mention mode, and generic routing rules', () => {
    const markup = renderToStaticMarkup(
      <EditChannelModal
        {...baseProps}
        routingPolicy={{
          v: 1,
          unmentionedMode: 'default',
          defaultCat: 'cursor',
          rules: [
            {
              id: 'governance',
              label: '治理把关',
              keywords: ['契约冻结', '里程碑'],
              targetCat: 'codex',
            },
          ],
        }}
      />,
    );

    expect(markup).toContain('DEFAULT AGENT');
    expect(markup).toContain('Cursor Auto');
    expect(markup).toContain('固定交给默认 Agent');
    expect(markup).toContain('治理把关');
    expect(markup).toContain('契约冻结, 里程碑');
  });

  it('submits the complete normalized routing policy', async () => {
    const onSave = vi.fn();
    await act(async () => {
      root.render(
        <EditChannelModal
          {...baseProps}
          onSave={onSave}
          routingPolicy={{
            v: 1,
            unmentionedMode: 'default',
            defaultCat: 'cursor',
            fallbackCats: ['cursor', 'codex', 'codex'],
            rules: [
              {
                id: ' governance ',
                label: ' 治理把关 ',
                keywords: [' 契约冻结 ', '里程碑', '里程碑'],
                targetCat: 'codex',
                fallbackCats: ['codex', 'cursor'],
              },
            ],
          }}
        />,
      );
    });

    const form = container.querySelector('form');
    await act(async () => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    expect(onSave).toHaveBeenCalledWith({
      title: 'Quant',
      participatingCats: ['cursor', 'codex'],
      routingPolicy: {
        v: 1,
        unmentionedMode: 'default',
        defaultCat: 'cursor',
        fallbackCats: ['codex'],
        rules: [
          {
            id: 'governance',
            label: '治理把关',
            keywords: ['契约冻结', '里程碑'],
            targetCat: 'codex',
            fallbackCats: ['cursor'],
          },
        ],
      },
    });
  });

  it('disables saving when fixed-default routing has no default agent', () => {
    const markup = renderToStaticMarkup(
      <EditChannelModal {...baseProps} routingPolicy={{ v: 1, unmentionedMode: 'default' }} />,
    );

    expect(markup).toContain('请先选择默认 Agent');
    expect(markup).toMatch(/type="submit"[^>]*disabled/);
  });

  it('shows an explicit empty state when no keyword rules exist', () => {
    const markup = renderToStaticMarkup(<EditChannelModal {...baseProps} routingPolicy={{ v: 1 }} />);

    expect(markup).toContain('暂无关键词路由规则');
  });

  it.each([
    {
      label: 'more than 10 fallbacks',
      routingPolicy: {
        v: 1 as const,
        unmentionedMode: 'default' as const,
        defaultCat: 'cursor',
        fallbackCats: Array.from({ length: 11 }, (_, index) => `fallback-${index}`),
      },
      message: 'fallback 最多配置 10 个 Agent',
    },
    {
      label: 'more than 12 keywords',
      routingPolicy: {
        v: 1 as const,
        rules: [
          {
            id: 'governance',
            label: '治理把关',
            targetCat: 'codex',
            keywords: Array.from({ length: 13 }, (_, index) => `keyword-${index}`),
          },
        ],
      },
      message: '每条规则最多配置 12 个关键词',
    },
    {
      label: 'more than 10 rule fallbacks',
      routingPolicy: {
        v: 1 as const,
        rules: [
          {
            id: 'governance',
            label: '治理把关',
            targetCat: 'codex',
            keywords: ['契约冻结'],
            fallbackCats: Array.from({ length: 11 }, (_, index) => `fallback-${index}`),
          },
        ],
      },
      message: '规则 fallback 最多配置 10 个 Agent',
    },
    {
      label: 'a keyword longer than 50 characters',
      routingPolicy: {
        v: 1 as const,
        rules: [
          {
            id: 'governance',
            label: '治理把关',
            targetCat: 'codex',
            keywords: ['x'.repeat(51)],
          },
        ],
      },
      message: '单个关键词最多 50 个字符',
    },
  ])('disables saving for API-invalid routing limits: $label', ({ routingPolicy, message }) => {
    const markup = renderToStaticMarkup(<EditChannelModal {...baseProps} routingPolicy={routingPolicy} />);

    expect(markup).toContain(message);
    expect(markup).toMatch(/type="submit"[^>]*disabled/);
  });
});
