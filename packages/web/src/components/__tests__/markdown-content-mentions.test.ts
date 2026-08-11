import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import { refreshMentionData, resetMentionDataForTest } from '@/lib/mention-highlight';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(content: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
}

describe('MarkdownContent mention highlighting', () => {
  beforeEach(() => {
    resetMentionDataForTest();
    refreshMentionData([
      {
        id: 'codex',
        displayName: '缅因猫',
        color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
        mentionPatterns: ['@砚砚', '@codex'],
        clientId: 'openai',
        defaultModel: 'gpt-5.5',
        avatar: '',
        roleDescription: '',
        personality: '',
      },
      {
        id: 'opus',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['@宪宪', '@opus'],
        clientId: 'anthropic',
        defaultModel: 'claude-opus-4-6',
        avatar: '',
        roleDescription: '',
        personality: '',
      },
      {
        id: 'gemini',
        displayName: '暹罗猫',
        color: { primary: '#5B9BD5', secondary: '#E6F2FF' },
        mentionPatterns: ['@siamese', '@gemini'],
        clientId: 'google',
        defaultModel: 'gemini-2.5-pro',
        avatar: '',
        roleDescription: '',
        personality: '',
      },
    ]);
  });

  it('highlights nickname and english-alias mentions with cat colors', () => {
    const html = render('@砚砚 请看下，@宪宪 也看下，@siamese 收尾');
    // Dynamic colors now use inline style with hex values (not Tailwind classes)
    expect(html).toContain('bg-[var(--cafe-accent)]/15');
    expect(html.match(/text-\[var\(--cafe-accent\)\]/g)).toHaveLength(3);
    expect(html).not.toContain('color:#');
  });

  it('带点号的猫名完整高亮，不在点处截断（cursor-gpt-5.6-sol-max）', () => {
    const html = render('返修完成后由 @cursor-gpt-5.6-sol-max 复核放行');
    // 完整 handle 必须整体落在同一个高亮 span 内
    expect(html).toContain('@cursor-gpt-5.6-sol-max</span>');
    // 不得出现「高亮 @cursor-gpt-5 + 裸文本 .6-sol-max」的截断形态
    expect(html).not.toContain('@cursor-gpt-5</span>');
  });

  it('句末的点仍是边界，不被吞进 mention（@opus. / @opus.中文）', () => {
    const htmlEnd = render('交给 @opus. 明天继续');
    expect(htmlEnd).toContain('@opus</span>');
    expect(htmlEnd).not.toContain('@opus.</span>');
    const htmlCjk = render('交给 @opus.然后收尾');
    expect(htmlCjk).toContain('@opus</span>');
  });
});
