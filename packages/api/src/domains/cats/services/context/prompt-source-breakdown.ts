import { estimateTokens } from '../../../../utils/token-counter.js';
import type { PromptSource, PromptSourceBreakdown, PromptSourceBreakdownItem } from '../types.js';

const SOURCE_ORDER: readonly PromptSource[] = ['history', 'project', 'skill', 'rules', 'memory'];

const SECTION_HEADINGS: Record<Exclude<PromptSource, 'history' | 'rules'>, readonly RegExp[]> = {
  memory: [/^##\s+跨 Session 记忆（持久化）/m, /^##\s+公共踩坑记录（LESSONS\.md，低优先级）/m],
  project: [/^##\s+项目简介与进度（只读参考）/m],
  skill: [/^##\s+Skill Router\b/m, /^⚡\s+Signal-triggered action\s+→\s+load skill:/m],
};

function findHeadingPositions(text: string): number[] {
  const positions: number[] = [];
  const headingRe = /^##\s+/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(text))) {
    positions.push(match.index);
  }
  return positions.sort((a, b) => a - b);
}

function nextHeadingAfter(headings: readonly number[], start: number, textLength: number): number {
  return headings.find((index) => index > start) ?? textLength;
}

function collectSectionRanges(text: string, headingPatterns: readonly RegExp[]): Array<{ start: number; end: number }> {
  const headings = findHeadingPositions(text);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const pattern of headingPatterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const start = match.index;
    ranges.push({ start, end: nextHeadingAfter(headings, start, text.length) });
  }
  return ranges;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (!last || range.start > last.end) {
      merged.push({ ...range });
    } else {
      last.end = Math.max(last.end, range.end);
    }
  }
  return merged;
}

function rangeText(text: string, ranges: readonly { start: number; end: number }[]): string {
  return ranges.map((range) => text.slice(range.start, range.end)).join('\n');
}

function subtractRanges(text: string, ranges: readonly { start: number; end: number }[]): string {
  if (ranges.length === 0) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join('\n');
}

function makeItem(source: PromptSource, text: string): PromptSourceBreakdownItem | null {
  const chars = text.length;
  if (chars <= 0) return null;
  return { source, chars, estimatedTokens: estimateTokens(text) };
}

export function estimatePromptSourceBreakdown(input: {
  systemPrompt?: string;
  userPrompt?: string;
}): PromptSourceBreakdown | undefined {
  const systemPrompt = input.systemPrompt ?? '';
  const userPrompt = input.userPrompt ?? '';
  if (!systemPrompt.trim() && !userPrompt.trim()) return undefined;

  const memoryRanges = collectSectionRanges(systemPrompt, SECTION_HEADINGS.memory);
  const projectRanges = collectSectionRanges(systemPrompt, SECTION_HEADINGS.project);
  const skillRanges = collectSectionRanges(systemPrompt, SECTION_HEADINGS.skill);
  const reservedSystemRanges = mergeRanges([...memoryRanges, ...projectRanges, ...skillRanges]);

  const bySource = new Map<PromptSource, string>();
  bySource.set('history', userPrompt);
  bySource.set('memory', rangeText(systemPrompt, mergeRanges(memoryRanges)));
  bySource.set('project', rangeText(systemPrompt, mergeRanges(projectRanges)));
  bySource.set('skill', rangeText(systemPrompt, mergeRanges(skillRanges)));
  bySource.set('rules', subtractRanges(systemPrompt, reservedSystemRanges));

  const sources = SOURCE_ORDER.map((source) => makeItem(source, bySource.get(source) ?? '')).filter(
    (item): item is PromptSourceBreakdownItem => item != null,
  );
  const totalEstimatedTokens = sources.reduce((sum, source) => sum + source.estimatedTokens, 0);
  return totalEstimatedTokens > 0 ? { totalEstimatedTokens, sources } : undefined;
}
