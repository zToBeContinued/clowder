/**
 * Bootcamp 入口(F106)现状测试。
 *
 * 入口演进:slock 大改(eb5fe913)移除了 ThreadSidebar 的
 * data-testid="sidebar-bootcamp" 按钮,训练营入口迁移到 ChatContainer
 * 空线程状态(empty-state-bootcamp / empty-state-bootcamp-list)。
 * 本文件接替原 thread-sidebar-bootcamp-entry.test.tsx 守护「入口存在 +
 * 点击打开训练营列表」的等价语义。
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatContainer } from '@/components/ChatContainer';

function createMockStoreState() {
  return {
    messages: [],
    isLoading: false,
    hasActiveInvocation: false,
    intentMode: null,
    targetCats: [],
    catStatuses: {},
    catInvocations: {},
    activeInvocations: {},
    addMessage: vi.fn(),
    removeMessage: vi.fn(),
    setLoading: vi.fn(),
    setHasActiveInvocation: vi.fn(),
    setIntentMode: vi.fn(),
    setTargetCats: vi.fn(),
    clearCatStatuses: vi.fn(),
    setCurrentThread: vi.fn(),
    updateThreadTitle: vi.fn(),
    setCurrentGame: vi.fn(),
    currentGame: null,

    viewMode: 'single' as const,
    setViewMode: vi.fn(),
    clearUnread: vi.fn(),
    confirmUnreadAck: vi.fn(),
    armUnreadSuppression: vi.fn(),
    splitPaneThreadIds: [],
    setSplitPaneThreadIds: vi.fn(),
    setSplitPaneTarget: vi.fn(),
    threads: [],
  };
}

let storeState = createMockStoreState();

vi.mock('@/stores/chatStore', () => {
  const hook = (selector?: (s: ReturnType<typeof createMockStoreState>) => unknown) => {
    return selector ? selector(storeState) : storeState;
  };
  return { useChatStore: hook };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    tasks: [],
    addTask: vi.fn(),
    updateTask: vi.fn(),
    clearTasks: vi.fn(),
  }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ cancelInvocation: vi.fn(), syncRooms: vi.fn() }),
}));

vi.mock('@/hooks/useAgentMessages', () => ({
  useAgentMessages: () => ({
    handleAgentMessage: vi.fn(),
    handleStop: vi.fn(),
    resetRefs: vi.fn(),
    resetTimeout: vi.fn(),
  }),
}));

vi.mock('@/hooks/useChatHistory', () => ({
  useChatHistory: () => ({
    handleScroll: vi.fn(),
    scrollContainerRef: { current: null },
    messagesEndRef: { current: null },
    isLoadingHistory: false,
    hasMore: false,
  }),
}));

vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn() }),
}));

vi.mock('@/hooks/useAuthorization', () => ({
  useAuthorization: () => ({ pending: [], respond: vi.fn(), handleAuthRequest: vi.fn(), handleAuthResponse: vi.fn() }),
}));

vi.mock('@/hooks/useSplitPaneKeys', () => ({ useSplitPaneKeys: vi.fn() }));

vi.mock('../AuthorizationCard', () => ({ AuthorizationCard: () => null }));
// 关键:BootcampListModal 用尊重 open 属性的 stub,断言入口点击后弹出。
vi.mock('../BootcampListModal', () => ({
  BootcampListModal: ({ open }: { open?: boolean }) =>
    open ? React.createElement('div', { 'data-testid': 'bootcamp-list-modal' }) : null,
}));
vi.mock('../BootstrapOrchestrator', () => ({ BootstrapOrchestrator: () => null }));
vi.mock('../CatCafeHub', () => ({ CatCafeHub: () => null }));
vi.mock('../ChatContainerHeader', () => ({ ChatContainerHeader: () => null }));
vi.mock('../ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../ChatMessage', () => ({ ChatMessage: () => null }));
vi.mock('../game/GameOverlayConnector', () => ({ GameOverlayConnector: () => null }));
vi.mock('../MessageActions', () => ({
  MessageActions: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('../MessageNavigator', () => ({ MessageNavigator: () => null }));
vi.mock('../MobileStatusSheet', () => ({ MobileStatusSheet: () => null }));
vi.mock('../ParallelStatusBar', () => ({ ParallelStatusBar: () => null }));
vi.mock('../ProjectSetupCard', () => ({ ProjectSetupCard: () => null }));
vi.mock('../QueuePanel', () => ({ QueuePanel: () => null }));
vi.mock('../RightStatusPanel', () => ({ RightStatusPanel: () => null }));
vi.mock('../ScrollToBottomButton', () => ({ ScrollToBottomButton: () => null }));
vi.mock('../SplitPaneView', () => ({
  SplitPaneView: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
vi.mock('../ThreadExecutionBar', () => ({ ThreadExecutionBar: () => null }));
vi.mock('../ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('../VoteActiveBar', () => ({ VoteActiveBar: () => null }));
vi.mock('../VoteConfigModal', () => ({ VoteConfigModal: () => null }));
vi.mock('../WorkspacePanel', () => ({ WorkspacePanel: () => null }));
vi.mock('../workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));

describe('ChatContainer bootcamp entry (empty state)', () => {
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
    storeState = createMockStoreState();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('empty thread shows the bootcamp entry (moved here from the sidebar)', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    const entry = container.querySelector('[data-testid="empty-state-bootcamp"]');
    expect(entry).not.toBeNull();
    expect(entry?.textContent).toContain('训练营');
  });

  it('clicking the bootcamp entry opens the bootcamp list', () => {
    act(() => {
      root.render(React.createElement(ChatContainer, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="bootcamp-list-modal"]')).toBeNull();

    const entry = container.querySelector('[data-testid="empty-state-bootcamp"]') as HTMLButtonElement;
    act(() => {
      entry.click();
    });

    expect(container.querySelector('[data-testid="bootcamp-list-modal"]')).not.toBeNull();
  });
});
