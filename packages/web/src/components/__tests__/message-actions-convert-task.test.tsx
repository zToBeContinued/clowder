import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@/stores/taskStore';

const apiFetchMock = vi.hoisted(() => vi.fn());
const addToastMock = vi.hoisted(() => vi.fn());

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    selector: (state: { removeThreadMessage: () => void; patchMessage: () => void }) => unknown,
  ) => selector({ removeThreadMessage: vi.fn(), patchMessage: vi.fn() }),
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: {
    getState: () => ({ addToast: addToastMock }),
  },
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: apiFetchMock,
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'user-1',
}));

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

const { MessageActions } = await import('@/components/MessageActions');

describe('MessageActions convert to task', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    addToastMock.mockReset();
    useTaskStore.setState({ tasks: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('creates a task from the More menu and links it to the source message', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'task-1',
        kind: 'work',
        threadId: 'thread-1',
        subjectKey: null,
        title: '需要跟进的消息',
        ownerCatId: null,
        status: 'todo',
        why: '由消息转为任务',
        createdBy: 'user',
        createdAt: 1,
        updatedAt: 1,
        sourceMessageId: 'msg-1',
      }),
    });

    await act(async () => {
      root.render(
        <MessageActions
          message={{
            id: 'msg-1',
            type: 'user',
            content: '需要跟进的消息\n第二行不用进标题',
            timestamp: Date.now(),
          }}
          threadId="thread-1"
        >
          <div>message body</div>
        </MessageActions>,
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[title="更多操作"]')?.click();
    });
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find((button) => button.textContent === '转为任务')
        ?.click();
    });

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/tasks',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"sourceMessageId":"msg-1"'),
      }),
    );
    expect(useTaskStore.getState().tasks[0]?.id).toBe('task-1');
    expect(addToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', title: '已转为任务' }));
  });
});
