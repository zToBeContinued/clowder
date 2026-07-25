/**
 * Sidebar thread deletion.
 *
 * Replaces the earlier "confirm dialog" contract. Deleting a thread is a soft delete
 * (server keeps it with `deletedAt`, the trash bin lists it), so the flow trades the
 * blocking confirmation for an undo affordance on the resulting toast. These tests pin
 * that contract: one click deletes, the toast offers undo, and undo restores.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '@/stores/toastStore';
import { ThreadSidebar } from '../ThreadSidebar';

// ── Mocks ─────────────────────────────────────────────────────
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://localhost:3102',
}));

const TEST_THREAD = {
  id: 'thread_abc123',
  title: '和砚砚讨论家规',
  projectPath: '/projects/cat-cafe',
  createdBy: 'user1',
  participants: ['user1'],
  lastActiveAt: Date.now(),
  createdAt: Date.now() - 100000,
  pinned: false,
  favorited: false,
  preferredCats: [] as string[],
};

let storeThreads = [TEST_THREAD];
const mockStore: Record<string, unknown> = {
  get threads() {
    return storeThreads;
  },
  currentThreadId: 'default',
  setThreads: vi.fn((t: typeof storeThreads) => {
    storeThreads = t;
  }),
  setCurrentProject: vi.fn(),
  isLoadingThreads: false,
  setLoadingThreads: vi.fn(),
  updateThreadTitle: vi.fn(),
  getThreadState: () => ({ catStatuses: {}, unreadCount: 0 }),
  updateThreadPin: vi.fn(),
  updateThreadFavorite: vi.fn(),
  updateThreadPreferredCats: vi.fn(),
  threadStates: {},
  clearUnread: vi.fn(),
  clearAllUnread: vi.fn(),
  initThreadUnread: vi.fn(),
  fetchGlobalBubbleDefaults: vi.fn(),
};

vi.mock('@/stores/chatStore', () => {
  const setState = (updater: unknown) => {
    const next = typeof updater === 'function' ? (updater as (s: unknown) => unknown)(mockStore) : updater;
    const patch = next as { threads?: typeof storeThreads };
    if (patch?.threads) storeThreads = patch.threads;
  };
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore, setState },
  );
  return { useChatStore: hook };
});
vi.mock('../TaskPanel', () => ({ TaskPanel: () => null }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => null, cats: [] }),
}));

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(data) });
}

function deleteCallsFor(threadId: string) {
  return mockApiFetch.mock.calls.filter(
    (call: unknown[]) =>
      call[0] === `/api/threads/${threadId}` && (call[1] as { method?: string } | undefined)?.method === 'DELETE',
  );
}

describe('Sidebar thread delete + undo', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    storeThreads = [TEST_THREAD];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockPush.mockReset();
    useToastStore.setState({ toasts: [] });
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/threads') return jsonOk({ threads: [TEST_THREAD] });
      if (path.endsWith('/restore')) return jsonOk(TEST_THREAD);
      return jsonOk({});
    });
    const store: Record<string, string> = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => {
          store[k] = v;
        },
        removeItem: (k: string) => {
          delete store[k];
        },
      },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  function findDeleteControl(threadId: string): HTMLElement | null {
    return container.querySelector(`[data-testid="thread-delete-${threadId}"]`);
  }

  /** F095 defaults all sections collapsed. Click expand-all first. */
  function expandAll() {
    const expandBtn = container.querySelector('[data-testid="expand-all-btn"]') as HTMLButtonElement | null;
    if (expandBtn)
      act(() => {
        expandBtn.click();
      });
  }

  async function renderSidebar() {
    act(() => {
      root.render(React.createElement(ThreadSidebar));
    });
    await flush();
    expandAll();
  }

  it('exposes a delete affordance for a non-default thread', async () => {
    await renderSidebar();
    const control = findDeleteControl(TEST_THREAD.id);
    expect(control, 'delete affordance should exist for non-default thread').toBeTruthy();
    // Nested <button> would be invalid HTML — the row itself is already a button.
    expect(control?.tagName).toBe('SPAN');
    expect(control?.getAttribute('role')).toBe('button');
  });

  it('never renders a delete affordance for the default thread', async () => {
    await renderSidebar();
    expect(findDeleteControl('default')).toBeNull();
  });

  it('soft-deletes in one click, without a blocking confirmation', async () => {
    await renderSidebar();
    const control = findDeleteControl(TEST_THREAD.id);

    await act(async () => {
      control?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const calls = deleteCallsFor(TEST_THREAD.id);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.[1] as { headers?: Record<string, string> }).headers).toMatchObject({
      'X-Clowder-Dangerous-Action-Confirmed': 'thread.soft_delete',
    });
  });

  it('offers undo on the resulting toast and restores the thread', async () => {
    await renderSidebar();
    const control = findDeleteControl(TEST_THREAD.id);

    await act(async () => {
      control?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.title).toContain(TEST_THREAD.title);
    expect(toast?.message).toContain('回收站');
    expect(toast?.action?.label).toBe('撤销');

    await act(async () => {
      await toast?.action?.onClick();
    });
    await flush();

    const restoreCalls = mockApiFetch.mock.calls.filter(
      (call: unknown[]) => call[0] === `/api/threads/${TEST_THREAD.id}/restore`,
    );
    expect(restoreCalls).toHaveLength(1);
  });

  it('surfaces an error toast when the delete request fails', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/threads') return jsonOk({ threads: [TEST_THREAD] });
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: '服务端拒绝删除' }) });
    });
    await renderSidebar();

    await act(async () => {
      findDeleteControl(TEST_THREAD.id)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const toast = useToastStore.getState().toasts.at(-1);
    expect(toast?.type).toBe('error');
    expect(toast?.message).toBe('服务端拒绝删除');
  });
});
