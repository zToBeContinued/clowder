import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addToastMock,
  createInLobby,
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  mockApiFetch,
  openCreateDialog,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
  textFail,
} from './thread-sidebar-test-helpers';

describe('ThreadSidebar create error feedback', () => {
  let harness: ThreadSidebarHarness;

  beforeAll(() => {
    installThreadSidebarGlobals();
  });

  beforeEach(() => {
    resetThreadSidebarMocks();
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  afterAll(() => {
    resetThreadSidebarGlobals();
  });

  it('shows an error toast when createInProject gets a non-ok response', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/threads' && init?.method === 'POST') return textFail(500, 'create failed');
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    await openCreateDialog(harness.container, harness.flush);
    await createInLobby(harness.container, harness.flush);

    expect(addToastMock).toHaveBeenCalledOnce();
    expect(addToastMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'error',
      title: '创建线程失败',
    });
  });

  it('runs project setup before creating a checked project channel', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/projects/setup' && init?.method === 'POST') return defaultSidebarApiMock(path);
      if (path === '/api/threads' && init?.method === 'POST') return defaultSidebarApiMock(path);
      return defaultSidebarApiMock(path);
    });

    await harness.render();

    await openCreateDialog(harness.container, harness.flush);

    const initProjectCheckbox = Array.from(harness.container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('这是项目'))
      ?.querySelector('input');
    if (!initProjectCheckbox) throw new Error('这是项目 checkbox not found');

    await harness.flush();
    expect(initProjectCheckbox.disabled).toBe(false);

    await act(async () => {
      initProjectCheckbox.click();
    });

    const confirmButton = Array.from(harness.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('创建对话'),
    );
    if (!confirmButton) throw new Error('创建对话 button not found');

    await act(async () => {
      confirmButton.click();
    });
    await harness.flush();

    const setupCall = mockApiFetch.mock.calls.find((call) => call[0] === '/api/projects/setup');
    expect(setupCall).toBeTruthy();
    expect(JSON.parse((setupCall?.[1] as RequestInit).body as string)).toMatchObject({
      projectPath: '/test',
      mode: 'skip',
      initProject: true,
    });

    const setupIndex = mockApiFetch.mock.calls.findIndex((call) => call[0] === '/api/projects/setup');
    const threadCreateIndex = mockApiFetch.mock.calls.findIndex(
      (call) => call[0] === '/api/threads' && (call[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(threadCreateIndex).toBeGreaterThan(setupIndex);
  });

  it('does not run project setup when the project checkbox is not checked', async () => {
    await harness.render();

    await openCreateDialog(harness.container, harness.flush);

    const confirmButton = Array.from(harness.container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('创建对话'),
    );
    if (!confirmButton) throw new Error('创建对话 button not found');

    await act(async () => {
      confirmButton.click();
    });
    await harness.flush();

    expect(mockApiFetch.mock.calls.some((call) => call[0] === '/api/projects/setup')).toBe(false);
    expect(
      mockApiFetch.mock.calls.some(
        (call) => call[0] === '/api/threads' && (call[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(true);
  });
});
