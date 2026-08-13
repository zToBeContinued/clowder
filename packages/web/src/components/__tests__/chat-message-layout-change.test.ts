import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
      threads: [],
      currentThreadId: 'default',
      catStatuses: {},
      messages: [],
    }),
  resolveBubbleExpanded: (override: string | undefined, globalDefault: string) => {
    if (override && override !== 'global') return override === 'expanded';
    return globalDefault === 'expanded';
  },
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('ChatMessage layout-change event timing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('dispatches chat-layout-changed after thinking collapse state commits (cloud P2)', async () => {
    const { ChatMessage } = await import('@/components/ChatMessage');

    const message = {
      id: 'm1',
      type: 'assistant',
      catId: 'codex',
      timestamp: Date.now(),
      visibility: 'public',
      revealedAt: null,
      whisperTo: null,
      origin: 'assistant',
      variant: null,
      isStreaming: false,
      content: '',
      thinking: 'hello thinking',
      contentBlocks: null,
      toolEvents: null,
      metadata: null,
      summary: null,
      evidence: null,
      extra: null,
      source: null,
    } as const;

    let expandedPresentAtEvent: boolean | null = null;
    const handler = () => {
      expandedPresentAtEvent = Boolean(container.querySelector('div.cli-output-md'));
    };
    window.addEventListener('catcafe:chat-layout-changed', handler);

    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          message: message as unknown as ChatMessageType,
          getCatById: () => undefined,
        }),
      );
    });

    const thinkingToggle = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Thinking'),
    );
    expect(thinkingToggle).toBeTruthy();

    act(() => {
      (thinkingToggle as HTMLButtonElement).click();
    });

    expect(container.querySelector('div.cli-output-md')).toBeTruthy();
    expect(expandedPresentAtEvent).toBe(true);

    window.removeEventListener('catcafe:chat-layout-changed', handler);
  });
});
