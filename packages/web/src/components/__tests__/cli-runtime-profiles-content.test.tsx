import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn(() => Promise.resolve(true)) }));

import { CliRuntimeProfilesContent } from '../settings/CliRuntimeProfilesContent';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function changeValue(element: HTMLInputElement, value: string) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

describe('CliRuntimeProfilesContent', () => {
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
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('never renders returned secret values and sends only explicit replacements/removals', async () => {
    const responseBody = {
      configRoot: 'C:/Users/test/.clowder-local',
      profiles: [
        {
          id: 'office-proxy',
          displayName: '办公室代理',
          command: 'kiro-cli',
          envKeys: ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'],
          envStatus: [
            { key: 'HTTP_PROXY', isSet: true },
            { key: 'HTTPS_PROXY', isSet: true },
            { key: 'NO_PROXY', isSet: true },
          ],
          // 防御性测试：即使服务端意外返回，解析层也必须丢弃。
          envSet: { HTTP_PROXY: 'http://server-secret@example.invalid:8080' },
          env: { HTTPS_PROXY: 'http://another-server-secret.invalid:8080' },
        },
      ],
    };
    mockApiFetch.mockImplementation((path, init) => {
      if (path === '/api/cli-runtime-profiles' && !init?.method) return Promise.resolve(jsonResponse(responseBody));
      if (path === '/api/cli-runtime-profiles/office-proxy' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ profile: responseBody.profiles[0] }));
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });

    await act(async () => {
      root.render(React.createElement(CliRuntimeProfilesContent));
    });
    await flushEffects();

    expect(container.textContent).toContain('C:/Users/test/.clowder-local');
    expect(container.textContent).toContain('HTTP_PROXY · 已设置');
    expect(container.textContent).not.toContain('server-secret');
    expect(container.textContent).not.toContain('another-server-secret');

    await act(async () => button(container, '编辑').click());
    const httpValue = container.querySelector<HTMLInputElement>('input[data-env-value-for="HTTP_PROXY"]');
    const httpsValue = container.querySelector<HTMLInputElement>('input[data-env-value-for="HTTPS_PROXY"]');
    expect(httpValue?.value).toBe('');
    expect(httpsValue?.value).toBe('');
    expect(httpValue?.type).toBe('password');

    await changeValue(httpValue!, 'http://replacement.invalid:3128');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="删除 NO_PROXY"]')?.click();
    });
    await act(async () => button(container, '保存运行环境').click());
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cli-runtime-profiles/office-proxy' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      displayName: '办公室代理',
      envSet: { HTTP_PROXY: 'http://replacement.invalid:3128' },
      envRemove: ['NO_PROXY'],
    });
  });

  it('creates with suggested NO_PROXY while omitting blank proxy values', async () => {
    mockApiFetch.mockImplementation((path, init) => {
      if (path === '/api/cli-runtime-profiles' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ profile: { id: 'home', displayName: '家庭网络' } }, 201));
      }
      if (path === '/api/cli-runtime-profiles') {
        return Promise.resolve(jsonResponse({ configRoot: 'D:/local-config', profiles: [] }));
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });

    await act(async () => {
      root.render(React.createElement(CliRuntimeProfilesContent));
    });
    await flushEffects();
    await act(async () => button(container, '+ 新建 CLI 运行环境').click());

    const noProxy = container.querySelector<HTMLInputElement>('input[data-env-value-for="NO_PROXY"]');
    expect(noProxy?.value).toBe('localhost,127.0.0.1,::1');
    await changeValue(container.querySelector<HTMLInputElement>('input[aria-label="运行环境 ID"]')!, 'home');
    await changeValue(container.querySelector<HTMLInputElement>('input[aria-label="运行环境显示名称"]')!, '家庭网络');
    await act(async () => button(container, '保存运行环境').click());
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cli-runtime-profiles' && init?.method === 'POST',
    );
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      id: 'home',
      displayName: '家庭网络',
      envSet: { NO_PROXY: 'localhost,127.0.0.1,::1' },
    });
  });
});
