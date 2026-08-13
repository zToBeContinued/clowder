import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chatStore';

const apiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ cats: [] }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/components/ChatMessage', () => ({
  ChatMessage: () => React.createElement('div', null, 'message'),
}));

vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: () => null,
}));

import { InlineThreadPanel } from '@/components/InlineThreadPanel';

const sourceMessage = {
  id: 'source-branch-message',
  type: 'user',
  content: '请分析附件',
  timestamp: 1,
} as ChatMessage;

describe('InlineThreadPanel image upload', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:inline-thread-image');
    URL.revokeObjectURL = vi.fn();
    apiFetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/api/messages?')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: [sourceMessage] }) });
      }
      if (url.startsWith('/api/threads/')) {
        return Promise.resolve({ ok: true, json: async () => ({ activeInvocations: [] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('previews a selected image and sends it with the branch reply metadata', async () => {
    await act(async () => {
      root.render(
        React.createElement(InlineThreadPanel, {
          threadId: 'thread-branch',
          parentThreadId: 'thread-parent',
          sourceMessage,
          parentThreadTitle: 'Parent',
          onClose: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    const image = new File(['diagram'], 'diagram.png', { type: 'image/png' });
    const imageInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(imageInput, 'files', { configurable: true, value: [image] });
    await act(async () => {
      imageInput.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('img[alt="diagram.png"]')).toBeTruthy();

    const sendButton = container.querySelector('button[aria-label="发送 Thread 回复"]') as HTMLButtonElement;
    await act(async () => {
      sendButton.click();
      await Promise.resolve();
    });

    const post = apiFetchMock.mock.calls.find(
      ([url, init]) => url === '/api/messages' && (init as RequestInit | undefined)?.method === 'POST',
    );
    const body = (post?.[1] as RequestInit).body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('threadId')).toBe('thread-branch');
    expect(body.get('replyTo')).toBe('source-branch-message');
    expect(body.getAll('images')).toEqual([image]);
  });

  it('accepts an image pasted into the thread composer', async () => {
    await act(async () => {
      root.render(
        React.createElement(InlineThreadPanel, {
          threadId: 'thread-branch',
          parentThreadId: 'thread-parent',
          sourceMessage,
          parentThreadTitle: 'Parent',
          onClose: vi.fn(),
        }),
      );
      await Promise.resolve();
    });

    const image = new File(['pasted diagram'], 'pasted.png', { type: 'image/png' });
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      configurable: true,
      value: {
        items: [{ type: 'image/png', getAsFile: () => image }],
      },
    });
    await act(async () => {
      (container.querySelector('textarea') as HTMLTextAreaElement).dispatchEvent(paste);
      await Promise.resolve();
    });

    expect(paste.defaultPrevented).toBe(true);
    expect(container.querySelector('img[alt="pasted.png"]')).toBeTruthy();
  });

  it('handles the exact reset command without posting a chat message', async () => {
    await act(async () => {
      root.render(
        React.createElement(InlineThreadPanel, {
          threadId: 'thread-branch',
          parentThreadId: 'thread-parent',
          sourceMessage,
          parentThreadTitle: 'Parent',
          onClose: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
    apiFetchMock.mockClear();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '/reset-context');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('button[aria-label="发送 Thread 回复"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/threads/thread-branch/reset-context',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(
      apiFetchMock.mock.calls.some(
        ([url, init]) => url === '/api/messages' && (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('sends a reset-like prefix as an ordinary message', async () => {
    await act(async () => {
      root.render(
        React.createElement(InlineThreadPanel, {
          threadId: 'thread-branch',
          parentThreadId: 'thread-parent',
          sourceMessage,
          parentThreadTitle: 'Parent',
          onClose: vi.fn(),
        }),
      );
      await Promise.resolve();
    });
    apiFetchMock.mockClear();

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '/reset-contextual');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('button[aria-label="发送 Thread 回复"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    const post = apiFetchMock.mock.calls.find(
      ([url, init]) => url === '/api/messages' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(JSON.parse(String((post?.[1] as RequestInit).body)).content).toBe('/reset-contextual');
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes('/reset-context'))).toBe(false);
  });
});
