import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  API_URL: 'http://localhost:3102',
}));
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(() => ({}), { getState: () => ({}) });
  return { useChatStore: hook };
});
vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ pinned: [], pin: vi.fn(), unpin: vi.fn(), isPinned: () => false }),
}));

import { SettingsNav } from '../settings/SettingsNav';
import { isDailySettingsSection, SETTINGS_SECTIONS } from '../settings/settings-nav-config';

describe('SettingsNav search filtering', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders only daily sections when no search query', () => {
    act(() => {
      root.render(React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn() }));
    });
    const buttons = Array.from(container.querySelectorAll('[data-active]'));
    expect(buttons).toHaveLength(SETTINGS_SECTIONS.filter(isDailySettingsSection).length);
    expect(container.textContent).toContain('规则与 SOP');
    expect(container.textContent).not.toContain('MCP 管理');
    expect(container.textContent).toContain('高级');
  });

  it('reveals advanced sections after expanding the advanced group', () => {
    act(() => {
      root.render(React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn() }));
    });
    const advancedToggle = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('高级'),
    );
    expect(advancedToggle).toBeTruthy();

    act(() => {
      advancedToggle!.click();
    });

    expect(container.textContent).toContain('MCP 管理');
    expect(container.textContent).toContain('运维监控');
  });

  it('filters sections by label match', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: '语音' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('[data-active]'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('语音管理');
  });

  it('filters by keyword match (e.g. telegram matches IM 对接)', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: 'telegram' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('[data-active]'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('IM 对接');
  });

  it('search can find advanced sections while they are collapsed by default', () => {
    act(() => {
      root.render(React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: 'MCP' }));
    });
    const buttons = Array.from(container.querySelectorAll('[data-active]'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('MCP 管理');
  });

  it('filters governance keywords to the rules and SOP section', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: '家规' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('[data-active]'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('规则与 SOP');
  });

  it('finds CLI runtime profiles by proxy environment variable keyword', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: 'HTTP_PROXY' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('[data-active]'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toContain('CLI 运行环境');
  });

  it('shows empty message when no match', () => {
    act(() => {
      root.render(
        React.createElement(SettingsNav, { activeSection: 'members', onSelect: vi.fn(), searchQuery: 'zzzznotfound' }),
      );
    });
    const buttons = Array.from(container.querySelectorAll('[data-active]'));
    expect(buttons).toHaveLength(0);
    expect(container.textContent).toContain('没有匹配的设置分区');
  });

  it('marks the active item with font-medium class for visual distinction', () => {
    act(() => {
      root.render(React.createElement(SettingsNav, { activeSection: 'voice', onSelect: vi.fn() }));
    });

    const navButtons = Array.from(container.querySelectorAll('[data-active]'));
    const active = navButtons.find((b) => b.textContent?.includes('语音管理'));
    expect(active).toBeTruthy();
    expect(active?.className).toContain('font-medium');
  });
});
