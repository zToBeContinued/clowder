import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('{}', { status: 200 }))),
}));

const mockConfirm = vi.fn(() => Promise.resolve(true));
vi.mock('@/components/useConfirm', () => ({
  useConfirm: () => mockConfirm,
}));

import { HubCatEditor } from '@/components/HubCatEditor';
import type { ProfileItem } from '@/components/hub-accounts.types';
import {
  buildCatPayload,
  builtinAccountIdForClient,
  DEFAULT_ANTIGRAVITY_COMMAND_ARGS,
  filterProfiles,
  getCliEffortOptionsForClient,
  initialState,
  type HubCatEditorFormState,
  splitCommandArgs,
  validateModelFormatForClient,
} from '@/components/hub-cat-editor.model';

const mockApiFetch = vi.mocked(apiFetch);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function profileItem(
  input: Omit<ProfileItem, 'kind' | 'builtin'> & Partial<Pick<ProfileItem, 'kind' | 'builtin'>>,
): ProfileItem {
  const builtin = input.builtin ?? input.authType === 'oauth';
  return { ...input, builtin, kind: input.kind ?? (builtin ? 'builtin' : 'api_key') };
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function changeField(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventType: 'input' | 'change' = 'input',
) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event(eventType, { bubbles: true }));
  });
}

function queryField<T extends HTMLElement>(container: HTMLElement, selector: string): T {
  const element = container.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element as T;
}

function expectTextOrder(text: string, labels: string[]) {
  let previous = -1;
  let previousLabel = 'start';
  for (const label of labels) {
    const current = text.indexOf(label);
    expect(current, `Missing label: ${label}`).toBeGreaterThanOrEqual(0);
    expect(current, `${label} should appear after ${previousLabel}`).toBeGreaterThan(previous);
    previous = current;
    previousLabel = label;
  }
}

describe('HubCatEditor', () => {
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
    mockApiFetch.mockReset();
    mockConfirm.mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('buildCatPayload keeps name in PATCH payload when editing an existing cat', () => {
    const form: HubCatEditorFormState = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      variantLabel: 'GPT-5.5',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'openai',
      accountRef: '',
      defaultModel: 'gpt-5.4',
      toolPolicy: 'standard',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      voiceVoice: '',
      voiceLangCode: '',
      voiceSpeed: '',
      voiceRefAudio: '',
      voiceRefText: '',
      voiceInstruct: '',
      voiceTemperature: '',
    };
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#16a34a', secondary: '#bbf7d0' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: '审查',
    } as CatData;

    const payload = buildCatPayload(form, existingCat) as Record<string, unknown>;
    expect(payload.name).toBe('运行时缅因猫');
    expect(payload.variantLabel).toBe('GPT-5.5');
  });

  it('buildCatPayload creates, updates, and clears cliRuntimeProfileRef', () => {
    const existingCat: CatData = {
      id: 'runtime-kiro',
      name: 'runtime-kiro',
      displayName: '运行时 Kiro 猫',
      clientId: 'kiro',
      defaultModel: '',
      color: { primary: '#6750a4', secondary: '#eaddff' },
      mentionPatterns: ['@runtime-kiro'],
      avatar: '/avatars/kiro.png',
      roleDescription: 'Kiro ACP',
      personality: '',
      cliRuntimeProfileRef: 'old-proxy',
    };
    const editForm = initialState(existingCat, null);

    expect(buildCatPayload({ ...editForm, cliRuntimeProfileRef: 'new-proxy' }, existingCat)).toMatchObject({
      cliRuntimeProfileRef: 'new-proxy',
    });
    expect(buildCatPayload({ ...editForm, cliRuntimeProfileRef: '' }, existingCat)).toMatchObject({
      cliRuntimeProfileRef: null,
    });
    expect(buildCatPayload({ ...initialState(null, null), cliRuntimeProfileRef: 'create-proxy' }, null)).toMatchObject({
      cliRuntimeProfileRef: 'create-proxy',
    });
  });

  it('buildCatPayload recomputes mcpSupport when client changes on existing cat', () => {
    const baseForm: HubCatEditorFormState = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'openai',
      accountRef: '',
      defaultModel: 'gpt-5.4',
      toolPolicy: 'standard',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      voiceVoice: '',
      voiceLangCode: '',
      voiceSpeed: '',
      voiceRefAudio: '',
      voiceRefText: '',
      voiceInstruct: '',
      voiceTemperature: '',
    };
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'antigravity',
      defaultModel: 'gemini-bridge',
      color: { primary: '#16a34a', secondary: '#bbf7d0' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: '审查',
    } as CatData;

    const payload = buildCatPayload(baseForm, existingCat) as Record<string, unknown>;
    expect(payload.mcpSupport).toBe(true);
  });

  it('buildCatPayload clears stale accountRef and enables MCP when switching to Kiro', () => {
    const form: HubCatEditorFormState = {
      catId: 'runtime-codex',
      name: '运行时 Kiro 猫',
      displayName: '运行时 Kiro 猫',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/kiro.png',
      colorPrimary: '#6750a4',
      colorSecondary: '#eaddff',
      mentionPatterns: '@runtime-kiro',
      roleDescription: 'Kiro ACP',
      personality: '',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'kiro',
      accountRef: 'codex',
      defaultModel: '',
      toolPolicy: 'standard',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      voiceVoice: '',
      voiceLangCode: '',
      voiceSpeed: '',
      voiceRefAudio: '',
      voiceRefText: '',
      voiceInstruct: '',
      voiceTemperature: '',
    };
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时 Codex 猫',
      clientId: 'openai',
      accountRef: 'codex',
      defaultModel: 'gpt-5.4',
      color: { primary: '#16a34a', secondary: '#bbf7d0' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: '审查',
    } as CatData;

    const payload = buildCatPayload(form, existingCat) as Record<string, unknown>;
    expect(payload.clientId).toBe('kiro');
    expect(payload.accountRef).toBeNull();
    expect(payload.defaultModel).toBe('');
    expect(payload.mcpSupport).toBe(true);
  });

  it('preserves a missing cliRuntimeProfileRef, warns, and reloads after the change event', async () => {
    const existingCat: CatData = {
      id: 'runtime-kiro',
      name: 'runtime-kiro',
      displayName: '运行时 Kiro 猫',
      clientId: 'kiro',
      defaultModel: '',
      color: { primary: '#6750a4', secondary: '#eaddff' },
      mentionPatterns: ['@runtime-kiro'],
      avatar: '/avatars/kiro.png',
      roleDescription: 'Kiro ACP',
      personality: '',
      cliRuntimeProfileRef: 'missing-office-proxy',
    };
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', providers: [] }));
      if (path === '/api/cat-model-options') return Promise.resolve(jsonResponse({ clients: {} }));
      if (path === '/api/config/session-strategy') return Promise.resolve(jsonResponse({ cats: [] }));
      if (path === '/api/cli-runtime-profiles') {
        return Promise.resolve(
          jsonResponse({
            configRoot: '/tmp/local-config',
            profiles: [{ id: 'home', displayName: '家庭网络', envKeys: ['NO_PROXY'] }],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: existingCat,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();
    await flushEffects();

    const runtimeSelect = queryField<HTMLSelectElement>(container, 'select[aria-label="CLI 运行环境"]');
    expect(runtimeSelect.value).toBe('missing-office-proxy');
    expect(container.textContent).toContain('当前引用的 CLI 运行环境「missing-office-proxy」在本机不存在');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('引用 ID 已保留');
    expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/cli-runtime-profiles')).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('cli-runtime-profiles-changed'));
    });
    await flushEffects();
    expect(mockApiFetch.mock.calls.filter(([path]) => path === '/api/cli-runtime-profiles')).toHaveLength(2);
  });

  it('adopts Kiro CLI without an account selector and permits an empty model', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-07-16T00:00:00.000Z',
                updatedAt: '2026-07-16T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cat-model-options') {
        return Promise.resolve(
          jsonResponse({
            source: 'local-cli-scan-v1',
            clients: {
              kiro: {
                defaultModel: 'gpt-5.6-sol',
                models: ['gpt-5.6-sol'],
                modelsSource: 'cli',
              },
            },
          }),
        );
      }
      if (path === '/api/cat-templates') return Promise.resolve(jsonResponse({ templates: [] }));
      if (path === '/api/local-cli-probes') {
        return Promise.resolve(
          jsonResponse({
            clis: [
              {
                id: 'kiro',
                label: 'Kiro CLI',
                command: 'kiro-cli',
                clientId: 'kiro',
                defaultModel: 'gpt-5.6-sol',
                models: [{ id: 'gpt-5.6-sol', source: 'cli', isDefault: true }],
                modelsStatus: 'ok',
                installed: true,
                resolvedPath: 'C:/Users/test/AppData/Local/Kiro-Cli/kiro-cli.exe',
                version: 'kiro-cli-chat 2.12.2',
                versionStatus: 'ok',
                authStatus: 'unknown',
                authStatusReason: '认证由本机 Kiro CLI 管理。',
                installHint: '按 Kiro CLI 官方安装文档安装',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-kiro' } }, 201));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    const scanButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '扫描本机 CLI 与模型',
    );
    await act(async () => scanButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();

    const adoptButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '用 Kiro CLI',
    );
    expect(adoptButton).toBeTruthy();
    await act(async () => adoptButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();

    const clientSelect = queryField<HTMLSelectElement>(container, 'select[aria-label="Client"]');
    expect(Array.from(clientSelect.options).some((option) => option.value === 'kiro')).toBe(true);
    expect(clientSelect.value).toBe('kiro');
    expect(container.querySelector('select[aria-label="认证信息"]')).toBeNull();
    expect(container.textContent).toContain('认证由本机 Kiro CLI 管理');

    const modelInput = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    expect(modelInput.required).toBe(false);
    await changeField(modelInput, '');
    await flushEffects();
    expect(modelInput.value).toBe('');

    await changeField(queryField(container, 'input[aria-label="Name"]'), '本地 Kiro');
    await changeField(queryField(container, 'input[aria-label="Description"]'), 'Kiro ACP 执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-kiro');
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats' && init?.method === 'POST');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.clientId).toBe('kiro');
    expect(payload.accountRef).toBeUndefined();
    expect(payload.defaultModel).toBe('');
    expect(payload.mcpSupport).toBe(true);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('buildCatPayload seeds default Antigravity command args when the field is still blank', () => {
    const form: HubCatEditorFormState = {
      catId: 'runtime-bridge',
      name: '桥接猫',
      displayName: '桥接猫',
      variantLabel: '',
      nickname: '',
      avatar: '/avatars/bridge.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-bridge',
      roleDescription: 'bridge',
      personality: 'steady',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'antigravity',
      accountRef: '',
      defaultModel: 'gemini-bridge',
      toolPolicy: 'standard',
      commandArgs: '',
      cliConfigArgs: [],
      cliEffort: '',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      voiceVoice: '',
      voiceLangCode: '',
      voiceSpeed: '',
      voiceRefAudio: '',
      voiceRefText: '',
      voiceInstruct: '',
      voiceTemperature: '',
    };

    const payload = buildCatPayload(form, null) as Record<string, unknown>;
    expect(payload.commandArgs).toEqual(splitCommandArgs(DEFAULT_ANTIGRAVITY_COMMAND_ARGS));
  });

  it('exposes provider-aware effort options for Claude and Codex only', () => {
    expect(getCliEffortOptionsForClient('anthropic')).toEqual(['low', 'medium', 'high', 'max']);
    expect(getCliEffortOptionsForClient('openai')).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(getCliEffortOptionsForClient('opencode')).toBeNull();
  });

  it('buildCatPayload keeps structured cli.effort separate from raw cliConfigArgs', () => {
    const form = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      commandArgs: '',
      cliConfigArgs: ['--config model_provider="custom"'],
      cliEffort: 'xhigh',
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      voiceVoice: '',
      voiceLangCode: '',
      voiceSpeed: '',
      voiceRefAudio: '',
      voiceRefText: '',
      voiceInstruct: '',
      voiceTemperature: '',
    } as HubCatEditorFormState & { cliEffort: string };

    const payload = buildCatPayload(form, null) as Record<string, unknown>;
    expect(payload.cli).toEqual({ effort: 'xhigh' });
    expect(payload.cliConfigArgs).toEqual(['--config model_provider="custom"']);
  });

  it('buildCatPayload maps Codex Fast Mode to cliConfigArgs', () => {
    const form = {
      catId: 'runtime-codex',
      name: '运行时缅因猫',
      displayName: '运行时缅因猫',
      nickname: '',
      avatar: '/avatars/codex.png',
      colorPrimary: '#16a34a',
      colorSecondary: '#bbf7d0',
      mentionPatterns: '@runtime-codex',
      roleDescription: '审查',
      personality: '严谨',
      teamStrengths: '',
      caution: '',
      strengths: '',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      commandArgs: '',
      cliConfigArgs: ['--config model_provider="custom"'],
      cliEffort: '',
      cliFastMode: true,
      provider: '',
      sessionChain: 'true',
      maxPromptTokens: '',
      maxContextTokens: '',
      maxMessages: '',
      maxContentLengthPerMsg: '',
      voiceVoice: '',
      voiceLangCode: '',
      voiceSpeed: '',
      voiceRefAudio: '',
      voiceRefText: '',
      voiceInstruct: '',
      voiceTemperature: '',
    } as HubCatEditorFormState;

    const enabledPayload = buildCatPayload(form, null) as Record<string, unknown>;
    expect(enabledPayload.cliConfigArgs).toEqual(['--config model_provider="custom"', '--enable fast_mode']);

    const disabledPayload = buildCatPayload(
      { ...form, cliFastMode: false, cliConfigArgs: ['--config model_provider="custom"', '--enable fast_mode'] },
      null,
    ) as Record<string, unknown>;
    expect(disabledPayload.cliConfigArgs).toEqual(['--config model_provider="custom"']);
  });

  it('splitCommandArgs preserves quoted segments', () => {
    expect(splitCommandArgs('chat --mode "agent bridge" --path "/tmp/work tree"')).toEqual([
      'chat',
      '--mode',
      'agent bridge',
      '--path',
      '/tmp/work tree',
    ]);
  });

  it('validateModelFormatForClient rejects opencode model without providerId/modelId format', () => {
    expect(validateModelFormatForClient('opencode', 'gpt-5.4')).toMatch(/providerId\/modelId/i);
    expect(validateModelFormatForClient('opencode', 'openai/gpt-5.4')).toBeNull();
    expect(validateModelFormatForClient('openai', 'gpt-5.4')).toBeNull();
  });

  it('renders normal member provider/model fields and saves to /api/cats', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            providers: [
              {
                id: 'claude-oauth',
                provider: 'claude-oauth',
                displayName: 'Claude (OAuth)',
                name: 'Claude (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(container.textContent).toContain('认证信息');
    expect(container.textContent).not.toContain('CLI Command');

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Avatar"]'), '/avatars/spark.png');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4-mini');
    const effortSelect = queryField<HTMLSelectElement>(container, 'select[aria-label="思考等级"]');
    expect(Array.from(effortSelect.options).map((option) => option.textContent)).toEqual([
      '默认（按 Client）',
      'low — 快速思考',
      'medium — 标准思考',
      'high — 深度思考',
      'xhigh — 超深思考',
    ]);
    await changeField(effortSelect, 'high', 'change');
    expect(container.textContent).not.toContain('CLI Effort');
    const fastModeToggle = queryField<HTMLInputElement>(container, 'input[aria-label="Codex Fast Mode"]');
    expect(fastModeToggle.checked).toBe(false);
    await act(async () => {
      fastModeToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    expect(postCall?.[1]?.method).toBe('POST');
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.clientId).toBe('openai');
    expect(payload.catId).toMatch(/^cat-[a-z0-9]+$/);
    expect(payload.accountRef).toBe('codex-sponsor');
    expect(payload.defaultModel).toBe('gpt-5.4-mini');
    expect(payload.cli).toEqual({ effort: 'high' });
    expect(payload.cliConfigArgs).toEqual(['--enable fast_mode']);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('loads model candidates from /api/cat-model-options for the model picker', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            providers: [
              {
                id: 'claude-oauth',
                provider: 'claude-oauth',
                displayName: 'Claude (OAuth)',
                name: 'Claude (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cat-model-options') {
        return Promise.resolve(
          jsonResponse({
            scannedAt: '2026-07-10T08:00:00.000Z',
            clients: {
              anthropic: {
                defaultModel: 'claude-sonnet-5',
                models: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-opus-4-7'],
                modelsSource: 'config',
              },
            },
          }),
        );
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'anthropic', accountRef: 'claude-oauth', defaultModel: 'claude-opus-4-8' },
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();
    await flushEffects();

    const modelInput = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    await act(async () => {
      modelInput.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/cat-model-options');
    expect(container.textContent).toContain('claude-sonnet-5');
    expect(container.textContent).toContain('claude-opus-4-7');
    expect(container.textContent).toContain('claude-opus-4-6');
    expect(container.textContent).toContain('配置');
    expect(container.textContent).not.toContain('当前模型未在最近扫描中发现');

    await changeField(modelInput, 'claude-not-in-latest-scan');
    expect(container.textContent).toContain('当前模型未在最近扫描中发现');
    await changeField(modelInput, 'claude-opus-4-8');
    expect(container.textContent).not.toContain('当前模型未在最近扫描中发现');
  });

  it('shows an explicit error when the initial model-candidate request fails', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', providers: [] }));
      }
      if (path === '/api/cat-model-options') {
        return Promise.resolve(jsonResponse({ error: '模型候选加载失败：未授权' }, 401));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();
    await flushEffects();

    expect(container.textContent).toContain('模型候选加载失败：未授权');
  });

  it('does not report model drift when this client only has static fallback candidates', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            providers: [
              {
                id: 'claude-oauth',
                provider: 'claude-oauth',
                displayName: 'Claude (OAuth)',
                name: 'Claude (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                mode: 'subscription',
                models: ['claude-opus-4-8'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cat-model-options') {
        return Promise.resolve(
          jsonResponse({
            scannedAt: '2026-07-10T08:00:00.000Z',
            clients: {
              openai: {
                models: ['gpt-5.6-sol'],
                modelsSource: 'config',
              },
              anthropic: {
                models: ['claude-sonnet-5'],
                modelsSource: 'static',
              },
            },
          }),
        );
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'anthropic', accountRef: 'claude-oauth', defaultModel: 'claude-opus-4-8' },
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();
    await flushEffects();

    expect(container.textContent).toContain('内置(可能过期)');
    expect(container.textContent).not.toContain('当前模型未在最近扫描中发现');
  });

  it('reports a model-candidate refresh failure after a successful local CLI scan', async () => {
    let modelOptionsCalls = 0;
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', providers: [] }));
      }
      if (path === '/api/cat-model-options') {
        modelOptionsCalls += 1;
        if (modelOptionsCalls === 1) {
          return Promise.resolve(jsonResponse({ clients: {} }));
        }
        return Promise.resolve(jsonResponse({ error: '模型候选刷新失败：扫描结果不可用' }, 503));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      if (path === '/api/local-cli-probes') {
        return Promise.resolve(jsonResponse({ clis: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();
    await flushEffects();

    const scanButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '扫描本机 CLI 与模型',
    );
    await act(async () => {
      scanButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await flushEffects();

    expect(modelOptionsCalls).toBe(2);
    expect(container.textContent).toContain('模型候选刷新失败：扫描结果不可用');
  });

  it('clears an initial model-candidate error after a successful manual scan refresh', async () => {
    let modelOptionsCalls = 0;
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', providers: [] }));
      }
      if (path === '/api/cat-model-options') {
        modelOptionsCalls += 1;
        return modelOptionsCalls === 1
          ? Promise.resolve(jsonResponse({ error: '模型候选加载失败：临时不可用' }, 503))
          : Promise.resolve(jsonResponse({ clients: {} }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      if (path === '/api/local-cli-probes') {
        return Promise.resolve(jsonResponse({ clis: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();
    await flushEffects();
    expect(container.textContent).toContain('模型候选加载失败：临时不可用');

    const scanButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '扫描本机 CLI 与模型',
    );
    await act(async () => {
      scanButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    await flushEffects();

    expect(modelOptionsCalls).toBe(2);
    expect(container.textContent).not.toContain('模型候选加载失败：临时不可用');
  });

  it('scans local CLIs only after explicit click and adopts the first scanned model before fallback default', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.5'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cat-model-options') {
        return Promise.resolve(
          jsonResponse({
            clients: {
              openai: {
                models: [
                  'gpt-5.6-sol',
                  'gpt-5.6-terra',
                  'gpt-5.6-luna',
                  'gpt-5.5',
                  'gpt-5.4',
                  'gpt-5.4-mini',
                  'gpt-5.3-codex-spark',
                ],
              },
            },
          }),
        );
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      if (path === '/api/local-cli-probes') {
        return Promise.resolve(
          jsonResponse({
            clis: [
              {
                id: 'codex',
                label: 'Codex',
                command: 'codex',
                clientId: 'openai',
                defaultModel: 'gpt-fallback-default',
                models: [
                  { id: 'gpt-5.6-sol', source: 'config' },
                  { id: 'gpt-5.6-terra', source: 'config' },
                  { id: 'gpt-5.6-luna', source: 'config' },
                  { id: 'gpt-5.5', source: 'config' },
                  { id: 'gpt-5.4', source: 'config' },
                  { id: 'gpt-5.4-mini', source: 'config' },
                  { id: 'gpt-5.3-codex-spark', source: 'config' },
                ],
                modelsStatus: 'config_only',
                installed: true,
                resolvedPath: '/usr/local/bin/codex',
                version: 'codex 1.2.3',
                versionStatus: 'ok',
                authStatus: 'unknown',
                authStatusReason: '安全模式：只做只读版本探测，不读取凭证文件；认证状态由首次实际运行验证。',
                installHint: 'npm install -g @openai/codex',
              },
              {
                id: 'gemini',
                label: 'Gemini CLI',
                command: 'gemini',
                clientId: 'google',
                defaultModel: 'gemini-3.1-pro-preview',
                installed: false,
                versionStatus: 'not_installed',
                authStatus: 'unknown',
                authStatusReason: '未安装，未执行认证探测。',
                installHint: 'npm install -g @google/gemini-cli',
              },
              {
                id: 'opencode',
                label: 'OpenCode',
                command: 'opencode',
                clientId: 'opencode',
                models: [],
                modelsStatus: 'failed',
                installed: true,
                resolvedPath: '/usr/local/bin/opencode',
                version: 'opencode 1.0.0',
                versionStatus: 'ok',
                authStatus: 'unknown',
                authStatusReason: '安全模式：不读取凭证文件。',
                installHint: 'npm install -g opencode-ai',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }, 201));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/local-cli-probes');

    const scanButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '扫描本机 CLI 与模型',
    );
    await act(async () => {
      scanButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith('/api/local-cli-probes');
    expect(container.textContent).toContain('Codex');
    expect(container.textContent).toContain('gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-5.4');
    expect(container.textContent).toContain('Gemini CLI');
    expect(container.textContent).toContain('npm install -g @google/gemini-cli');
    expect(container.textContent).toContain('模型扫描失败');

    const adoptCodex = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '用 Codex',
    );
    await act(async () => {
      adoptCodex?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await changeField(queryField(container, 'input[aria-label="Name"]'), '本地 Codex');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '本机 Codex 执行');
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.clientId).toBe('openai');
    expect(payload.accountRef).toBe('codex-sponsor');
    expect(payload.defaultModel).toBe('gpt-5.6-sol');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('adopts a scanned Grok CLI with its builtin account and default model', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            providers: [
              {
                id: 'grok',
                provider: 'grok',
                displayName: 'Grok',
                name: 'Grok',
                authType: 'oauth',
                kind: 'builtin',
                builtin: true,
                mode: 'subscription',
                clientId: 'grok',
                models: ['grok-4'],
                hasApiKey: false,
                createdAt: '2026-07-13T00:00:00.000Z',
                updatedAt: '2026-07-13T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cat-model-options') {
        return Promise.resolve(jsonResponse({ clients: { grok: { models: ['grok-4'] } } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      if (path === '/api/local-cli-probes') {
        return Promise.resolve(
          jsonResponse({
            clis: [
              {
                id: 'grok',
                label: 'Grok CLI',
                command: 'grok',
                clientId: 'grok',
                defaultModel: 'grok-fallback',
                models: [{ id: 'grok-4', source: 'config', isDefault: true }],
                modelsStatus: 'config_only',
                installed: true,
                resolvedPath: '/usr/local/bin/grok',
                version: 'grok 1.0.0',
                versionStatus: 'ok',
                authStatus: 'unknown',
                authStatusReason: '安全模式：不读取凭证文件。',
                installHint: 'npm install -g @vibe-kit/grok-cli',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-grok' } }, 201));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    const scanButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '扫描本机 CLI 与模型',
    );
    await act(async () => {
      scanButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const adoptGrok = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '用 Grok CLI',
    );
    expect(adoptGrok).toBeTruthy();
    await act(async () => {
      adoptGrok?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await changeField(queryField(container, 'input[aria-label="Name"]'), '本地 Grok');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '本机 Grok 执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@grok');
    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.clientId).toBe('grok');
    expect(payload.accountRef).toBe('grok');
    expect(payload.defaultModel).toBe('grok-4');
  });

  it('AC-C2: defaults API-key member aliases to the selected model name', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'openai', accountRef: 'codex-sponsor', defaultModel: 'gpt-5.4-mini' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.accountRef).toBe('codex-sponsor');
    expect(payload.defaultModel).toBe('gpt-5.4-mini');
    expect(payload.mentionPatterns).toContain('@gpt-5.4-mini');
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('dispatches guide:confirm only after a successful member save', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const onGuideConfirm = vi.fn();
    window.addEventListener('guide:confirm', onGuideConfirm as EventListener);
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      return Promise.resolve(jsonResponse({ config: {} }));
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'openai', accountRef: 'codex-sponsor', defaultModel: 'gpt-5.4-mini' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onGuideConfirm).toHaveBeenCalledTimes(1);
    expect((onGuideConfirm.mock.calls[0]?.[0] as CustomEvent<{ target: string }>).detail).toEqual({
      target: 'member-editor.profile',
    });

    window.removeEventListener('guide:confirm', onGuideConfirm as EventListener);
  });

  it('does not dispatch guide:confirm when member save fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const onGuideConfirm = vi.fn();
    window.addEventListener('guide:confirm', onGuideConfirm as EventListener);
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ error: '保存失败' }, 500));
      }
      return Promise.resolve(jsonResponse({ config: {} }));
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'openai', accountRef: 'codex-sponsor', defaultModel: 'gpt-5.4-mini' },
          onClose: vi.fn(),
          onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onSaved).not.toHaveBeenCalled();
    expect(onGuideConfirm).not.toHaveBeenCalled();

    window.removeEventListener('guide:confirm', onGuideConfirm as EventListener);
  });

  it('blocks creating opencode+api_key member without ocProviderName', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'opencode',
            providers: [
              {
                id: 'opencode',
                provider: 'opencode',
                displayName: 'OpenCode (OAuth)',
                name: 'OpenCode (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'oc-apikey',
                provider: 'oc-apikey',
                displayName: 'OC API Key',
                name: 'OC API Key',
                authType: 'api_key',
                mode: 'api_key',
                models: ['glm-5'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: {
            clientId: 'opencode',
            accountRef: 'oc-apikey',
            defaultModel: 'glm-5',
          },
          onClose: vi.fn(),
          onSaved: onSaved,
        }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '运行时金渐层');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '审查');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-jinjianceng');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    // Save should be blocked — opencode+api_key without provider is rejected.
    const postCall = mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats' && init?.method === 'POST');
    expect(postCall).toBeUndefined();
    expect(container.textContent).toContain('Provider 名称');
  });

  it('resets defaultModel when switching Provider to prevent stale model carry-over', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [
          {
            id: 'claude',
            provider: 'claude',
            displayName: 'Claude (OAuth)',
            name: 'Claude (OAuth)',
            authType: 'oauth',
            clientId: 'anthropic',
            models: ['claude-opus-4-6', 'claude-sonnet-4-5'],
            hasApiKey: false,
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'codex-sponsor',
            provider: 'codex-sponsor',
            displayName: 'Codex Sponsor',
            name: 'Codex Sponsor',
            authType: 'api_key',
            models: ['gpt-5.4-mini'],
            hasApiKey: true,
            baseUrl: 'https://proxy.example',
            createdAt: '',
            updatedAt: '',
          },
        ],
      }),
    );

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: {
            id: 'opus',
            displayName: 'Opus',
            breedDisplayName: 'Ragdoll',
            nickname: '',
            clientId: 'anthropic',
            accountRef: 'claude',
            defaultModel: 'claude-opus-4-6',
            color: { primary: '#000', secondary: '#fff' },
            mentionPatterns: ['@opus'],
            avatar: '',
            roleDescription: '',
            personality: '',
          },
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    // Initially model should be claude-opus-4-6
    const modelInput = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    expect(modelInput.value).toBe('claude-opus-4-6');

    // Switch Provider to codex-sponsor (API Key)
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await flushEffects();

    // defaultModel should have been reset (not still 'claude-opus-4-6')
    const modelInputAfter = queryField<HTMLInputElement>(container, 'input[aria-label="Model"]');
    expect(modelInputAfter.value).not.toBe('claude-opus-4-6');
  });

  it('resets provider when switching account to prevent stale provider carry-over', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [
          {
            id: 'maas-key',
            provider: 'maas-key',
            displayName: 'MaaS Key',
            name: 'MaaS Key',
            authType: 'api_key',
            models: ['glm-5'],
            hasApiKey: true,
            baseUrl: 'https://maas.example',
            createdAt: '',
            updatedAt: '',
          },
          {
            id: 'deepseek-key',
            provider: 'deepseek-key',
            displayName: 'DeepSeek Key',
            name: 'DeepSeek Key',
            authType: 'api_key',
            models: ['deepseek-r2'],
            hasApiKey: true,
            baseUrl: 'https://deepseek.example',
            createdAt: '',
            updatedAt: '',
          },
        ],
      }),
    );

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          cat: {
            id: 'oc-maas',
            displayName: 'OC MaaS',
            breedDisplayName: 'OpenCode',
            nickname: '',
            clientId: 'opencode',
            accountRef: 'maas-key',
            defaultModel: 'maas/glm-5',
            provider: 'maas',
            color: { primary: '#000', secondary: '#fff' },
            mentionPatterns: ['@oc-maas'],
            avatar: '',
            roleDescription: '',
            personality: '',
          } as CatData,
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    // Initially provider (model provider name) should be 'maas'
    const providerInput = queryField<HTMLInputElement>(container, 'input[aria-label="OC Provider Name"]');
    expect(providerInput.value).toBe('maas');

    // Switch account to deepseek-key
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'deepseek-key', 'change');
    await flushEffects();

    // provider should have been cleared (not still 'maas')
    const providerInputAfter = queryField<HTMLInputElement>(container, 'input[aria-label="OC Provider Name"]');
    expect(providerInputAfter.value).toBe('');
  });

  it('switches to Antigravity branch and shows CLI command field', async () => {
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [],
      }),
    );

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'antigravity', 'change');
    expect(container.textContent).toContain('CLI Command');
    expect(container.querySelector('select[aria-label="认证信息"]')).toBeNull();
  });

  it('shows the selected client builtin account together with all API key accounts', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'claude-sponsor',
                provider: 'claude-sponsor',
                displayName: 'Claude Sponsor',
                name: 'Claude Sponsor',
                authType: 'api_key',
                protocol: 'anthropic',
                mode: 'api_key',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    const providerSelect = queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]');
    const optionLabels = Array.from(providerSelect.options).map((option) => option.textContent ?? '');
    expect(optionLabels).toContain('Codex (OAuth)（OAuth）');
    expect(optionLabels).toContain('Claude Sponsor（API Key）');
  });

  it('keeps builtin accounts client-specific while exposing all API key accounts', () => {
    const profiles: ProfileItem[] = [
      profileItem({
        id: 'claude-oauth',
        provider: 'claude-oauth',
        displayName: 'Claude (OAuth)',
        name: 'Claude (OAuth)',
        authType: 'oauth',
        mode: 'subscription',
        models: ['claude-opus-4-6'],
        hasApiKey: false,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      }),
      profileItem({
        id: 'claude-sponsor',
        provider: 'claude-sponsor',
        displayName: 'Claude Sponsor',
        name: 'Claude Sponsor',
        authType: 'api_key',
        mode: 'api_key',
        models: ['claude-opus-4-6'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      }),
      profileItem({
        id: 'codex-oauth',
        provider: 'codex-oauth',
        displayName: 'Codex (OAuth)',
        name: 'Codex (OAuth)',
        authType: 'oauth',
        mode: 'subscription',
        models: ['gpt-5.4'],
        hasApiKey: false,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      }),
      profileItem({
        id: 'codex-sponsor',
        provider: 'codex-sponsor',
        displayName: 'Codex Sponsor',
        name: 'Codex Sponsor',
        authType: 'api_key',
        mode: 'api_key',
        models: ['gpt-5.4'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      }),
    ];

    expect(filterProfiles('openai', profiles).map((profile) => profile.id)).toEqual([
      'codex-oauth',
      'claude-sponsor',
      'codex-sponsor',
    ]);
    expect(filterProfiles('anthropic', profiles).map((profile) => profile.id)).toEqual([
      'claude-oauth',
      'claude-sponsor',
      'codex-sponsor',
    ]);
    expect(filterProfiles('dare', profiles).map((profile) => profile.id)).toEqual(['claude-sponsor', 'codex-sponsor']);
    expect(filterProfiles('opencode', profiles).map((profile) => profile.id)).toEqual([
      'claude-sponsor',
      'codex-sponsor',
    ]);

    // F159: catagent shares anthropic credential family
    expect(filterProfiles('catagent', profiles).map((profile) => profile.id)).toEqual(
      filterProfiles('anthropic', profiles).map((profile) => profile.id),
    );
    expect(builtinAccountIdForClient('catagent')).toEqual('claude');
  });

  it('allows google to use builtin auth plus third-party gateway accounts only', () => {
    const profiles: ProfileItem[] = [
      {
        id: 'gemini',
        provider: 'gemini',
        displayName: 'Gemini (OAuth)',
        name: 'Gemini (OAuth)',
        authType: 'oauth',
        kind: 'builtin',
        builtin: true,
        mode: 'subscription',
        clientId: 'google',
        models: ['gemini-2.5-pro'],
        hasApiKey: false,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
      {
        id: 'gemini-proxy',
        provider: 'gemini-proxy',
        displayName: 'Gemini Proxy',
        name: 'Gemini Proxy',
        authType: 'api_key',
        kind: 'api_key',
        builtin: false,
        mode: 'api_key',
        baseUrl: 'https://gateway.example/google',
        models: ['openrouter/google/gemini-3-flash-preview'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
      {
        id: 'google-official',
        provider: 'google-official',
        displayName: 'Google Official API',
        name: 'Google Official API',
        authType: 'api_key',
        kind: 'api_key',
        builtin: false,
        mode: 'api_key',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        models: ['gemini-2.5-pro'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
      {
        id: 'broken-proxy',
        provider: 'broken-proxy',
        displayName: 'Broken Proxy',
        name: 'Broken Proxy',
        authType: 'api_key',
        kind: 'api_key',
        builtin: false,
        mode: 'api_key',
        baseUrl: 'not-a-valid-url',
        models: ['gemini-2.5-pro'],
        hasApiKey: true,
        createdAt: '2026-03-18T00:00:00.000Z',
        updatedAt: '2026-03-18T00:00:00.000Z',
      },
    ];

    expect(filterProfiles('google', profiles).map((profile) => profile.id)).toEqual(['gemini', 'gemini-proxy']);
  });

  it('hides google api_key accounts in the member account selector', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: null,
            providers: [
              {
                id: 'gemini',
                provider: 'gemini',
                displayName: 'Gemini (OAuth)',
                name: 'Gemini (OAuth)',
                authType: 'oauth',
                kind: 'builtin',
                builtin: true,
                clientId: 'google',
                mode: 'subscription',
                models: ['gemini-2.5-pro'],
                hasApiKey: false,
                createdAt: '',
                updatedAt: '',
              },
              {
                id: 'gemini-proxy',
                provider: 'gemini-proxy',
                displayName: 'Gemini Proxy',
                name: 'Gemini Proxy',
                authType: 'api_key',
                kind: 'api_key',
                builtin: false,
                clientId: 'google',
                mode: 'api_key',
                baseUrl: 'https://gateway.example/google',
                models: ['openrouter/google/gemini-3-flash-preview'],
                hasApiKey: true,
                createdAt: '',
                updatedAt: '',
              },
              {
                id: 'google-official',
                provider: 'google-official',
                displayName: 'Google Official API',
                name: 'Google Official API',
                authType: 'api_key',
                kind: 'api_key',
                builtin: false,
                clientId: 'google',
                mode: 'api_key',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                models: ['gemini-2.5-pro'],
                hasApiKey: true,
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, {
          open: true,
          draft: { clientId: 'google', accountRef: 'gemini', defaultModel: 'gemini-2.5-pro' },
          onClose: vi.fn(),
          onSaved: vi.fn(),
        }),
      );
    });
    await flushEffects();

    const providerSelect = queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]');
    const optionLabels = Array.from(providerSelect.options).map((option) => option.textContent ?? '');
    expect(optionLabels).toContain('Gemini (OAuth)（OAuth）');
    expect(optionLabels).not.toContain('Gemini Proxy（API Key）');
    expect(optionLabels).not.toContain('Google Official API（API Key）');
  });

  it('preserves existing model when it is not listed in provider defaults', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-oauth',
      defaultModel: 'gpt-5.3-codex-spark',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.defaultModel).toBe('gpt-5.3-codex-spark');
  });

  it('keeps unbound cats unbound when opening the editor', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeUndefined();
  });

  it('keeps unbound opencode members unbound until a provider is chosen', async () => {
    const existingCat = {
      id: 'runtime-opencode',
      name: 'runtime-opencode',
      displayName: '运行时 OpenCode',
      clientId: 'opencode',
      defaultModel: 'claude-opus-4-6',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-opencode'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'claude-oauth',
            providers: [
              {
                id: 'claude-oauth',
                provider: 'claude-oauth',
                displayName: 'Claude (OAuth)',
                name: 'Claude (OAuth)',
                authType: 'oauth',
                protocol: 'anthropic',
                mode: 'subscription',
                models: ['claude-opus-4-6'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
              {
                id: 'claude-sponsor',
                provider: 'claude-sponsor',
                displayName: 'Claude Sponsor',
                name: 'Claude Sponsor',
                authType: 'api_key',
                protocol: 'anthropic',
                mode: 'api_key',
                models: ['claude-opus-4-6'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/runtime-opencode' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-opencode' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeUndefined();
  });

  it('allows saving existing opencode members while provider profiles are still loading', async () => {
    const existingCat = {
      id: 'runtime-opencode',
      name: 'runtime-opencode',
      displayName: '运行时 OpenCode',
      clientId: 'opencode',
      defaultModel: 'claude-opus-4-6',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-opencode'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'review',
    } as CatData;

    let resolveProfiles!: (value: Response) => void;
    const profilesPromise = new Promise<Response>((resolve) => {
      resolveProfiles = resolve;
    });

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return profilesPromise;
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/runtime-opencode' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-opencode' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    expect(saveButton).toBeTruthy();
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();
    expect(
      mockApiFetch.mock.calls.find(([path, init]) => path === '/api/cats/runtime-opencode' && init?.method === 'PATCH'),
    ).toBeTruthy();

    resolveProfiles(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: 'claude-oauth',
        providers: [
          {
            id: 'claude-oauth',
            provider: 'claude-oauth',
            displayName: 'Claude (OAuth)',
            name: 'Claude (OAuth)',
            authType: 'oauth',
            protocol: 'anthropic',
            mode: 'subscription',
            models: ['claude-opus-4-6'],
            hasApiKey: false,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
          {
            id: 'claude-sponsor',
            provider: 'claude-sponsor',
            displayName: 'Claude Sponsor',
            name: 'Claude Sponsor',
            authType: 'api_key',
            protocol: 'anthropic',
            mode: 'api_key',
            models: ['claude-opus-4-6'],
            hasApiKey: true,
            createdAt: '2026-03-18T00:00:00.000Z',
            updatedAt: '2026-03-18T00:00:00.000Z',
          },
        ],
      }),
    );
    await flushEffects();
    await flushEffects();

    expect(queryField<HTMLSelectElement>(container, 'select[aria-label="认证信息"]').value).toBe('');
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends accountRef=null when clearing an existing provider binding', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="认证信息"]'), '', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.accountRef).toBeNull();
  });

  it('sends accountRef=null when switching a bound member to antigravity', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Client"]'), 'antigravity', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gemini-bridge');
    await changeField(queryField(container, 'input[aria-label="CLI Command"]'), 'chat --mode agent');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.clientId).toBe('antigravity');
    expect(payload.accountRef).toBeNull();
    expect(payload.mcpSupport).toBe(true);
  });

  it('sends contextBudget=null when clearing existing runtime budget', async () => {
    const existingCat = {
      id: 'runtime-codex',
      name: 'runtime-codex',
      displayName: '运行时缅因猫',
      clientId: 'openai',
      accountRef: 'codex-oauth',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@runtime-codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-oauth',
            providers: [
              {
                id: 'codex-oauth',
                provider: 'codex-oauth',
                displayName: 'Codex (OAuth)',
                name: 'Codex (OAuth)',
                authType: 'oauth',
                protocol: 'openai',
                mode: 'subscription',
                models: ['gpt-5.4'],
                hasApiKey: false,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cats/runtime-codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-codex' } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Context Tokens"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Messages"]'), '');
    await changeField(queryField(container, 'input[aria-label="Max Content Length Per Msg"]'), '');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/runtime-codex' && init?.method === 'PATCH',
    );
    expect(patchCall).toBeTruthy();
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.contextBudget).toBeNull();
  });

  it('requires all runtime budget fields when any budget value is provided', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4-mini'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-spark' } }, 201));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    expect(container.textContent).toContain('4 项要么全部留空，要么全部填写');

    await changeField(queryField(container, 'input[aria-label="Name"]'), '火花猫');
    await changeField(queryField(container, 'input[aria-label="Avatar"]'), '/avatars/spark.png');
    await changeField(queryField(container, 'input[aria-label="Description"]'), '快速执行');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-spark, @火花猫');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();
    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4-mini');
    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '48000');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('上下文预算要么全部留空，要么 4 项都填写');
    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/cats', expect.objectContaining({ method: 'POST' }));
  });

  it('deletes an existing member only after confirmation', async () => {
    const existingCat: CatData = {
      id: 'runtime-antigravity',
      name: '运行时桥接猫',
      displayName: '运行时桥接猫',
      clientId: 'antigravity',
      defaultModel: 'gemini-bridge',
      commandArgs: ['chat', '--mode', 'agent'],
      color: { primary: '#0f766e', secondary: '#99f6e4' },
      mentionPatterns: ['@runtime-antigravity'],
      avatar: '/avatars/antigravity.png',
      roleDescription: '桥接通道',
      personality: '稳定',
    };
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/cats/runtime-antigravity') {
        return Promise.resolve(jsonResponse({ deleted: true }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    const deleteButton = queryField<HTMLButtonElement>(container, 'button[aria-label="删除成员"]');
    mockConfirm.mockResolvedValueOnce(false);

    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      '/api/cats/runtime-antigravity',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(onSaved).toHaveBeenCalledTimes(0);

    mockConfirm.mockResolvedValueOnce(true);
    await act(async () => {
      deleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/cats/runtime-antigravity',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('prompts before closing when there are unsaved edits', async () => {
    const onClose = vi.fn();
    mockApiFetch.mockResolvedValue(
      jsonResponse({
        projectPath: '/tmp/project',
        activeProfileId: null,
        providers: [],
      }),
    );

    mockConfirm.mockResolvedValue(false);
    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose, onSaved: vi.fn() }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '临时名字');

    const cancelButton = container.querySelector('button[aria-label="关闭成员配置"]');
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(mockConfirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    mockConfirm.mockResolvedValue(true);
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(onClose).toHaveBeenCalledTimes(1);
    mockConfirm.mockResolvedValue(true);
  });

  it('shows delete action for all members', async () => {
    const existingCat: CatData = {
      id: 'codex',
      name: '缅因猫',
      displayName: '缅因猫',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      personality: 'rigorous',
    };

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    expect(container.querySelector('button[aria-label="删除成员"]')).not.toBeNull();
  });

  it('uses the designed member detail modal shell', async () => {
    const existingCat: CatData = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '砚砚',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      personality: 'rigorous',
    };

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    const modal = queryField<HTMLElement>(container, '[role="dialog"][aria-labelledby="member-editor-title"]');
    expect(modal.className).toContain('member-editor-modal');
    expect(modal.className).toContain('max-w-[720px]');
    expect(modal.className).toContain('rounded-[28px]');
    expect(container.querySelector('#member-editor-title')?.textContent).toContain('成员配置 / 预览与编辑');
    expect(container.querySelector('button[aria-label="关闭成员配置"]')?.className).toContain('h-8 w-8');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '取消')).toBe(
      false,
    );
    expect(container.querySelector('h4')?.className).toContain('text-base');
    expectTextOrder(container.textContent ?? '', [
      '名称',
      '昵称',
      '显示后缀',
      '角色描述',
      '擅长领域',
      '性格特征',
      'Avatar',
      'Background Color',
      '注意事项',
      'Strengths',
      '▸ Voice Config',
    ]);
    expect(container.textContent).toContain('运行时持久化');
  });

  it('lets users switch avatars from preset options', async () => {
    const existingCat: CatData = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '砚砚',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      personality: 'rigorous',
    };

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: { cli: {}, codexExecution: {} } }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    const kimiPreset = queryField<HTMLButtonElement>(container, 'button[aria-label="选择预设头像 Slock Yellow Cat"]');
    await act(async () => {
      kimiPreset.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(queryField<HTMLInputElement>(container, 'input[aria-label="Avatar"]').value).toBe(
      '/avatars/slock/slock-yellow-cat.png',
    );
    expect(kimiPreset.getAttribute('aria-pressed')).toBe('true');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const patchCall = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    const payload = JSON.parse(String(patchCall?.[1]?.body));
    expect(payload.avatar).toBe('/avatars/slock/slock-yellow-cat.png');
  });

  it('uses the designed add member template shell', async () => {
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/accounts') {
        return Promise.resolve(jsonResponse({ projectPath: '/tmp/project', activeProfileId: null, providers: [] }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(
          jsonResponse({
            templates: [
              {
                id: 'codex',
                name: '砚砚',
                nickname: '砚砚',
                avatar: '/avatars/codex.png',
                color: { primary: '#5E8B60', secondary: '#DDEDDC' },
                roleDescription: '代码审查专家',
                personality: '严谨认真',
                teamStrengths: 'Review、找 bug、coding 落地',
              },
            ],
          }),
        );
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved: vi.fn() }));
    });
    await flushEffects();

    expect(container.querySelector('#member-editor-title')?.textContent).toContain('添加成员');
    expect(container.textContent).toContain('成员模板');
    expect(container.textContent).toContain('从内置成员模板开始，选择后自动填充身份、模型与运行时默认值。');
    expectTextOrder(container.textContent ?? '', ['成员模板', '自定义', '砚砚', '身份信息']);
  });

  it('loads runtime controls for an existing member and saves strategy separately', async () => {
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '砚砚',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex', '@缅因猫'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      personality: 'rigorous',
      teamStrengths: '代码审查、找 bug',
      caution: null,
      strengths: ['security', 'testing'],
      sessionChain: true,
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData & {
      contextBudget: {
        maxPromptTokens: number;
        maxContextTokens: number;
        maxMessages: number;
        maxContentLengthPerMsg: number;
      };
    };

    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              coCreator: {
                name: 'Co-worker',
                aliases: ['共创伙伴'],
                mentionPatterns: ['@co-worker', '@owner'],
              },
              cats: {},
              perCatBudgets: {},
              a2a: { enabled: true, maxDepth: 2 },
              memory: { enabled: true, maxKeysPerThread: 50 },
              hindsight: {
                enabled: true,
                baseUrl: 'http://localhost:18888',
                sharedBank: 'cat-cafe-shared',
              },
              governance: { degradationEnabled: true, doneTimeoutMs: 300000, heartbeatIntervalMs: 30000 },
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                model: 'gpt-5.4',
                authMode: 'oauth',
                passModelArg: true,
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(
          jsonResponse({
            catId: 'codex',
            effective: {
              strategy: 'handoff',
              thresholds: { warn: 0.55, action: 0.8 },
            },
            source: 'runtime_override',
          }),
        );
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(container.textContent).toContain('昵称');
    expect(container.textContent).toContain('显示后缀');
    expect(container.textContent).toContain('擅长领域');
    expect(container.textContent).toContain('注意事项');
    expect(container.textContent).toContain('Strengths');
    expect(container.textContent).toContain('▸ Voice Config');
    expect(container.textContent).toContain('别名与 @ 路由');
    expect(container.textContent).toContain('认证与模型');
    expect(container.textContent).toContain('Session Chain');
    expect(container.textContent).toContain('── Codex 专属 (仅 Client=Codex 时显示) ──');
    expect(container.textContent).toContain('Codex Sandbox (Codex)');
    expect(container.textContent).toContain('Codex Approval (Codex)');
    expect(container.textContent).toContain('Codex Auth Mode (Codex)');
    expect(container.textContent).not.toContain('这 3 项是全局运行参数（非成员级）');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(false);
    expect(container.textContent).toContain('运行时持久化');
    expect(container.textContent).toContain('保存');
    expect(container.textContent).toContain('删除成员');
    expect(container.textContent).not.toContain('账号与运行方式');
    expect(container.textContent).not.toContain('Primary');
    expect(container.textContent).not.toContain('Secondary');
    expect(container.textContent).not.toContain('Display Name');

    await changeField(queryField(container, 'input[aria-label="Max Prompt Tokens"]'), '48000');
    await changeField(queryField(container, 'input[aria-label="Variant Label"]'), 'GPT-5.5');
    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '砚砚升级版');
    await changeField(queryField(container, 'input[aria-label="Team Strengths"]'), '代码审查、找 bug、深度思考');
    await changeField(queryField(container, 'input[aria-label="Strengths"]'), 'security, testing, debugging');
    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'never', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Auth Mode"]'), 'api_key', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();
    const catPayload = JSON.parse(String(catPatch?.[1]?.body));
    expect(catPayload.contextBudget.maxPromptTokens).toBe(48000);
    expect(catPayload.variantLabel).toBe('GPT-5.5');
    expect(catPayload.nickname).toBe('砚砚升级版');
    expect(catPayload.teamStrengths).toBe('代码审查、找 bug、深度思考');
    expect(catPayload.strengths).toEqual(['security', 'testing', 'debugging']);
    expect(catPayload.sessionChain).toBe(true);

    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeTruthy();
    const strategyPayload = JSON.parse(String(strategyPatch?.[1]?.body));
    expect(strategyPayload.strategy).toBe('handoff');
    expect(strategyPayload.thresholds.warn).toBe(0.55);

    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(3);
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('cli.codexSandboxMode');
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('danger-full-access');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('cli.codexApprovalPolicy');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('never');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('codex.execution.authMode');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('api_key');
  });

  it('does not write session-strategy override when strategy fields are unchanged', async () => {
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex', '@缅因猫'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
      sessionChain: true,
      contextBudget: {
        maxPromptTokens: 32000,
        maxContextTokens: 24000,
        maxMessages: 40,
        maxContentLengthPerMsg: 8000,
      },
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'breed',
                hasOverride: false,
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: { codexSandboxMode: 'workspace-write', codexApprovalPolicy: 'on-request' },
              codexExecution: { authMode: 'oauth' },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(
        React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved: vi.fn() }),
      );
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '砚砚');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();
    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeFalsy();
  });

  it('hides session strategy controls and skips invalid strategy validation when Session Chain is disabled', async () => {
    const existingCat = {
      id: 'opencode',
      name: 'opencode',
      displayName: '金渐层',
      clientId: 'opencode',
      accountRef: 'opencode',
      defaultModel: 'anthropic/claude-opus-4-6',
      color: { primary: '#C8A951', secondary: '#F5EDDA' },
      mentionPatterns: ['@opencode'],
      avatar: '/avatars/opencode.png',
      roleDescription: 'coding',
      sessionChain: false,
    } as CatData;
    const onSaved = vi.fn(() => Promise.resolve());

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'opencode',
            providers: [],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'opencode',
                displayName: '金渐层',
                provider: 'opencode',
                effective: {
                  strategy: 'handoff',
                  thresholds: { warn: 0.85, action: 0.75 },
                },
                source: 'provider',
                hasOverride: false,
                hybridCapable: false,
                sessionChainEnabled: false,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/cats/opencode' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'opencode' } }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Session Chain 未开启');
    expect(container.textContent).toContain('策略不会生效');
    expect(container.querySelector('select[aria-label="Session Strategy"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Session Warn Threshold"]')).toBeNull();
    expect(container.querySelector('input[aria-label="Session Action Threshold"]')).toBeNull();

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/opencode' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();
    const strategyPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/config/session-strategy/opencode' && init?.method === 'PATCH',
    );
    expect(strategyPatch).toBeFalsy();
    expect(container.textContent).not.toContain('Warn Threshold 必须小于 Action Threshold');
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows Codex-only runtime controls for any Client=Codex and lets alias chips be removed', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'danger-full-access',
                codexApprovalPolicy: 'never',
              },
              codexExecution: {
                authMode: 'api_key',
              },
            },
          }),
        );
      }
      if (path === '/api/cats') {
        return Promise.resolve(jsonResponse({ cat: { id: 'runtime-reviewer' } }, 201));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Name"]'), '运行时审查猫');
    await changeField(queryField(container, 'input[aria-label="Description"]'), 'review');
    await changeField(queryField(container, 'textarea[aria-label="Aliases"]'), '@runtime-reviewer, @第二别名');
    await changeField(queryField(container, 'select[aria-label="Client"]'), 'openai', 'change');
    await flushEffects();

    expect(container.textContent).toContain('Codex Sandbox (Codex)');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').value).toBe(
      'danger-full-access',
    );
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').value).toBe('never');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').value).toBe('api_key');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(false);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(false);

    const removeAliasButton = queryField<HTMLButtonElement>(container, 'button[aria-label="移除 @第二别名"]');
    await act(async () => {
      removeAliasButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await changeField(queryField(container, 'select[aria-label="认证信息"]'), 'codex-sponsor', 'change');
    await changeField(queryField(container, 'input[aria-label="Model"]'), 'gpt-5.4');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'workspace-write', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'on-request', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Auth Mode"]'), 'oauth', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const postCall = mockApiFetch.mock.calls.find(([path]) => path === '/api/cats');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.[1]?.body));
    expect(payload.mentionPatterns).toEqual(['@runtime-reviewer']);
    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(3);
    expect(String(codexConfigPatches[0]?.[1]?.body)).toContain('cli.codexSandboxMode');
    expect(String(codexConfigPatches[1]?.[1]?.body)).toContain('cli.codexApprovalPolicy');
    expect(String(codexConfigPatches[2]?.[1]?.body)).toContain('codex.execution.authMode');
  });

  it('surfaces an error when a Codex runtime PATCH fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: 'Codex PATCH failed' }, 500));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('disables Codex-only fields and skips Codex PATCHes when baseline loading fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(new Response('{}', { status: 503 }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    expect(container.textContent).toContain('Codex 运行参数加载失败 (503)');
    expect(container.textContent).toContain('Codex 配置基线未加载成功');
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Sandbox"]').disabled).toBe(true);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Approval"]').disabled).toBe(true);
    expect(queryField<HTMLSelectElement>(container, 'select[aria-label^="Codex Auth Mode"]').disabled).toBe(true);

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatch = mockApiFetch.mock.calls.find(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatch).toBeTruthy();

    const codexConfigPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(codexConfigPatches).toHaveLength(0);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('rolls back the cat PATCH when a Codex runtime PATCH fails after the member save succeeds', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(jsonResponse({ cats: [] }));
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: 'Codex PATCH failed' }, 500));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const catPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatches).toHaveLength(2);

    const firstPayload = JSON.parse(String(catPatches[0]?.[1]?.body));
    expect(firstPayload.nickname).toBe('新昵称');

    const rollbackPayload = JSON.parse(String(catPatches[1]?.[1]?.body));
    expect(rollbackPayload.nickname).toBe('旧昵称');
    expect(rollbackPayload.defaultModel).toBe('gpt-5.4');
    expect(rollbackPayload.accountRef).toBe('codex-sponsor');
    expect(container.textContent).toContain('Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rolls back prior strategy and config mutations when a later Codex config PATCH fails', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    let configPatchCount = 0;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ cat: { id: 'codex' } }));
      }
      if (path === '/api/config' && init?.method === 'PATCH') {
        configPatchCount += 1;
        if (configPatchCount === 2) {
          return Promise.resolve(jsonResponse({ error: 'Second Codex PATCH failed' }, 500));
        }
        return Promise.resolve(jsonResponse({ config: {} }));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'input[aria-label="Nickname"]'), '新昵称');
    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55');
    await changeField(queryField(container, 'select[aria-label^="Codex Sandbox"]'), 'danger-full-access', 'change');
    await changeField(queryField(container, 'select[aria-label^="Codex Approval"]'), 'never', 'change');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const strategyPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatches).toHaveLength(2);
    expect(JSON.parse(String(strategyPatches[0]?.[1]?.body)).strategy).toBe('handoff');
    const strategyRollbackPayload = JSON.parse(String(strategyPatches[1]?.[1]?.body));
    expect(strategyRollbackPayload.strategy).toBe('compress');
    expect(strategyRollbackPayload.thresholds.warn).toBe(0.6);

    const configPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config' && init?.method === 'PATCH',
    );
    expect(configPatches.length).toBeGreaterThanOrEqual(3);
    expect(
      configPatches.some(
        ([, init]) =>
          String(init?.body).includes('cli.codexSandboxMode') && String(init?.body).includes('workspace-write'),
      ),
    ).toBe(true);

    const catPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/cats/codex' && init?.method === 'PATCH',
    );
    expect(catPatches).toHaveLength(2);
    const rollbackPayload = JSON.parse(String(catPatches[1]?.[1]?.body));
    expect(rollbackPayload.nickname).toBe('旧昵称');
    expect(container.textContent).toContain('Second Codex PATCH failed');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('rolls back already-applied strategy mutations when later save requests throw', async () => {
    const onSaved = vi.fn(() => Promise.resolve());
    const existingCat = {
      id: 'codex',
      name: 'codex',
      displayName: '缅因猫',
      nickname: '旧昵称',
      clientId: 'openai',
      accountRef: 'codex-sponsor',
      defaultModel: 'gpt-5.4',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex'],
      avatar: '/avatars/codex.png',
      roleDescription: 'review',
    } as CatData;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/accounts') {
        return Promise.resolve(
          jsonResponse({
            projectPath: '/tmp/project',
            activeProfileId: 'codex-sponsor',
            providers: [
              {
                id: 'codex-sponsor',
                provider: 'codex-sponsor',
                displayName: 'Codex Sponsor',
                name: 'Codex Sponsor',
                authType: 'api_key',
                protocol: 'openai',
                mode: 'api_key',
                models: ['gpt-5.4'],
                hasApiKey: true,
                createdAt: '2026-03-18T00:00:00.000Z',
                updatedAt: '2026-03-18T00:00:00.000Z',
              },
            ],
          }),
        );
      }
      if (path === '/api/config/session-strategy') {
        return Promise.resolve(
          jsonResponse({
            cats: [
              {
                catId: 'codex',
                displayName: '缅因猫',
                provider: 'openai',
                effective: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                source: 'runtime_override',
                hasOverride: true,
                override: {
                  strategy: 'compress',
                  thresholds: { warn: 0.6, action: 0.8 },
                },
                hybridCapable: false,
                sessionChainEnabled: true,
              },
            ],
          }),
        );
      }
      if (path === '/api/config' && !init?.method) {
        return Promise.resolve(
          jsonResponse({
            config: {
              cli: {
                codexSandboxMode: 'workspace-write',
                codexApprovalPolicy: 'on-request',
              },
              codexExecution: {
                authMode: 'oauth',
              },
            },
          }),
        );
      }
      if (path === '/api/config/session-strategy/codex' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (path === '/api/cats/codex' && init?.method === 'PATCH') {
        return Promise.reject(new Error('network dropped during cat save'));
      }
      if (path === '/api/cat-templates') {
        return Promise.resolve(jsonResponse({ templates: [] }));
      }
      throw new Error(`Unexpected apiFetch path: ${path}`);
    });

    await act(async () => {
      root.render(React.createElement(HubCatEditor, { open: true, cat: existingCat, onClose: vi.fn(), onSaved }));
    });
    await flushEffects();

    await changeField(queryField(container, 'select[aria-label="Session Strategy"]'), 'handoff', 'change');
    await changeField(queryField(container, 'input[aria-label="Session Warn Threshold"]'), '0.55');

    const saveButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '保存');
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushEffects();

    const strategyPatches = mockApiFetch.mock.calls.filter(
      ([path, init]) => path === '/api/config/session-strategy/codex' && init?.method === 'PATCH',
    );
    expect(strategyPatches).toHaveLength(2);
    expect(JSON.parse(String(strategyPatches[0]?.[1]?.body)).strategy).toBe('handoff');
    expect(JSON.parse(String(strategyPatches[1]?.[1]?.body)).strategy).toBe('compress');
    expect(container.textContent).toContain('network dropped during cat save');
    expect(onSaved).not.toHaveBeenCalled();
  });
});
