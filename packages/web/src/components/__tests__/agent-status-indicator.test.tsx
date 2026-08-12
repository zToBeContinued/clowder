import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { AgentStatusIndicator, getAgentStatusLabel } from '../AgentStatusIndicator';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

const TEST_CAT: CatData = {
  id: 'gpt52',
  displayName: '缅因猫',
  color: { primary: '#4CAF50', secondary: '#C8E6C9' },
  mentionPatterns: ['@gpt52'],
  clientId: 'openai',
  defaultModel: 'gpt-5.2',
  avatar: 'cat',
  roleDescription: 'test',
  personality: 'test',
};

function getCatById(catId: string): CatData | undefined {
  return catId === TEST_CAT.id ? TEST_CAT : undefined;
}

describe('AgentStatusIndicator', () => {
  it('renders nothing when no agent is active', () => {
    const html = renderToStaticMarkup(
      <AgentStatusIndicator
        threadId="thread-1"
        activeInvocations={{}}
        catStatuses={{}}
        catInvocations={{}}
        getCatById={getCatById}
      />,
    );

    expect(html).toBe('');
  });

  it('renders active agent status from thread-scoped invocation data', () => {
    const html = renderToStaticMarkup(
      <AgentStatusIndicator
        threadId="thread-1"
        activeInvocations={{
          'inv-1': { catId: 'gpt52', mode: 'execute', startedAt: Date.now() - 5000 },
        }}
        catStatuses={{ gpt52: 'streaming' }}
        catInvocations={{}}
        getCatById={getCatById}
      />,
    );

    expect(html).not.toContain('AGENT');
    expect(html).toContain('缅因猫');
    expect(html).toContain('正在生成');
  });

  it('uses phase to show tool execution state', () => {
    expect(getAgentStatusLabel('streaming', 'tool_calling')).toBe('正在执行工具');
  });

  it('shows deliveryOnly degradation from the live invocation context', () => {
    const html = renderToStaticMarkup(
      <AgentStatusIndicator
        threadId="thread-1"
        activeInvocations={{
          'inv-delivery-only': {
            catId: 'gpt52',
            mode: 'execute',
            startedAt: Date.now() - 1000,
            contextBudget: {
              surface: 'thread',
              threadId: 'thread-1',
              toolPolicy: 'standard',
              toolPolicySource: 'agent-default',
              mode: 'serial',
              estimatedTokens: 1200,
              historyMessages: 4,
              loadedBlocks: ['history'],
              skippedBlocks: [],
              governanceTier: 'core',
              governanceEstimatedTokens: 100,
              governanceSourceInjected: false,
              usesFullHistory: true,
              maxPromptTokens: 10000,
              maxContextTokens: 12000,
              deliveryOnlyMode: 'degraded',
              deliveryOnlyDegradedIssue: 'missing_summary',
            },
          },
        }}
        catStatuses={{ gpt52: 'streaming' }}
        catInvocations={{}}
        getCatById={getCatById}
      />,
    );

    expect(html).toContain('⚠ deliveryOnly · missing_summary');
  });

  it('shows current activity (latest tool call) next to the status label', () => {
    const html = renderToStaticMarkup(
      <AgentStatusIndicator
        threadId="thread-1"
        activeInvocations={{
          'inv-1': { catId: 'gpt52', mode: 'execute', startedAt: Date.now() - 5000 },
        }}
        catStatuses={{ gpt52: 'streaming' }}
        catInvocations={{
          gpt52: {
            currentActivity: { kind: 'tool', label: 'shell · pnpm --filter web test', at: Date.now() },
          },
        }}
        getCatById={getCatById}
      />,
    );

    expect(html).toContain('shell · pnpm --filter web test');
  });

  it('ignores stale cat status when invocation slot is not present', () => {
    const html = renderToStaticMarkup(
      <AgentStatusIndicator
        threadId="thread-1"
        activeInvocations={{}}
        catStatuses={{ gpt52: 'pending' }}
        catInvocations={{ gpt52: { startedAt: Date.now() - 1000 } }}
        getCatById={getCatById}
      />,
    );

    expect(html).toBe('');
  });
});
