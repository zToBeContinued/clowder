import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const apiFetchMock = vi.hoisted(() => vi.fn());

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));
vi.mock('../DailyUsageSection', () => ({ DailyUsageSection: () => null }));
vi.mock('../HubQuotaBoardTab', () => ({ HubQuotaBoardTab: () => null }));

import { HubRoutingPolicyTab, mergeRoutingScopes } from '../HubRoutingPolicyTab';

const initialThread: Thread = {
  id: 'thread-quant',
  projectPath: 'D:/project/quant',
  title: 'quant',
  createdBy: 'user-1',
  participants: [],
  lastActiveAt: 1,
  createdAt: 1,
  routingPolicy: {
    v: 1,
    unmentionedMode: 'default',
    defaultCat: 'cursor',
    rules: [
      {
        id: 'governance',
        label: '治理把关',
        keywords: ['架构裁决'],
        targetCat: 'codex',
      },
    ],
  },
};

describe('HubRoutingPolicyTab generic policy compatibility', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: initialThread.id, threads: [initialThread] });
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({ currentThreadId: 'default', threads: [] });
  });

  it('replaces scopes without erasing generic channel routing fields', () => {
    expect(
      mergeRoutingScopes(
        {
          v: 1,
          unmentionedMode: 'default',
          defaultCat: 'cursor',
          fallbackCats: ['kiro'],
          rules: [
            {
              id: 'governance',
              label: '治理把关',
              keywords: ['架构裁决'],
              targetCat: 'codex',
            },
          ],
          scopes: { review: { avoidCats: ['opus'] } },
        },
        { architecture: { preferCats: ['opus'] } },
      ),
    ).toEqual({
      v: 1,
      unmentionedMode: 'default',
      defaultCat: 'cursor',
      fallbackCats: ['kiro'],
      rules: [
        {
          id: 'governance',
          label: '治理把关',
          keywords: ['架构裁决'],
          targetCat: 'codex',
        },
      ],
      scopes: { architecture: { preferCats: ['opus'] } },
    });
  });

  it('clears only scopes and returns null only when no other routing fields remain', () => {
    expect(mergeRoutingScopes({ v: 1, defaultCat: 'cursor' }, {})).toEqual({ v: 1, defaultCat: 'cursor' });
    expect(mergeRoutingScopes({ v: 1, scopes: { review: { avoidCats: ['opus'] } } }, {})).toBeNull();
  });

  it('updates the shared thread store after saving so channel settings use the latest policy', async () => {
    const updatedThread: Thread = {
      ...initialThread,
      routingPolicy: {
        ...initialThread.routingPolicy!,
        scopes: { review: { avoidCats: ['opus'], reason: 'budget' } },
      },
    };
    apiFetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => initialThread })
      .mockResolvedValueOnce({ ok: true, json: async () => updatedThread });

    await act(async () => {
      root.render(React.createElement(HubRoutingPolicyTab));
    });

    const reviewCheckbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(reviewCheckbox).not.toBeNull();
    await act(async () => {
      reviewCheckbox!.click();
    });
    const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存');
    expect(saveButton).toBeDefined();
    await act(async () => {
      saveButton!.click();
    });

    expect(useChatStore.getState().threads.find((thread) => thread.id === initialThread.id)?.routingPolicy).toEqual(
      updatedThread.routingPolicy,
    );
  });
});
