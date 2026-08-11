const OPENAI_CITATION_RE = /cite[^]*/g;
const BRACKET_CITATION_RE = /\[cite:[^\]]+\]/gi;
const COLON_CITATION_RE = /\bcite:turn\d+view\d+\b/gi;
const COMPACT_CITATION_RE = /\bciteturn\d+view\d+\b/gi;
const TEMP_PATH_RE = /\/tmp\/[^\s，。；;、)）\]}>"']+/g;

const INTERNAL_PROTOCOL_PATTERNS = [
  /\bTask\s+claim\b/i,
  /\$CLI\b/,
  /\binbox\b/i,
  /\brequiresTask\b/i,
  /\bin_review\b/i,
  /\bclowder\s+task\b/i,
  /\bclowder\s+message\b/i,
  /Shared-state\s+(?:preflight|files\s+committed)/i,
  /uncommitted\s+shared-state\s+files/i,
  /shared-rules\s*§14/i,
  /Please\s+commit\+push\s+before\s+continuing/i,
  /Exceeded\s+skills\s+context\s+budget/i,
  /model-visible\s+skills\s+list/i,
];

const INTERNAL_RUNTIME_JSON_TYPES = new Set([
  'handoff_draft_window',
  'session_handoff_write_failed',
  'session_seal_requested',
]);

const INTERNAL_PROGRESS_LINE_PATTERNS = [
  /接续检查/,
  /记忆命中/,
  /全量扫描/,
  /当前任务记忆/,
  /可用工具/,
  /我先取上下文/,
  /我先按.*(?:查|确认|读取).*上下文/,
  /我先.*消息锚点.*上下文/,
  /使用\s*Skill/i,
  /初步结果/,
  /并行拆分/,
  /子任务状态/,
  /对齐数量口径/,
  /按家规查/,
  /加载.*技能/,
  /Task\s+更新/i,
  /我开始做/,
  /证据不够细/,
  /真相源.*偏差/,
  /真相源确认/,
  /结构已明确/,
  /准备落盘/,
  /开始写文件/,
  /已落盘.*验证/,
  /补索引/,
  /收尾验证/,
  /回写记忆/,
  /切任务状态/,
  /我先独立看/,
  /证据命中/,
  /本地布局事实/,
  /本地页面.*(?:没|没有).*消息内容/,
  /我有.*事实/,
  /找到可用.*API/i,
  /我看完.*上下文/,
  /我再扩一圈/,
  /Exceeded\s+skills\s+context\s+budget/i,
  /model-visible\s+skills\s+list/i,
];

const USER_FACING_LINE_RE =
  /^(结论|建议|结果|交付|验证|验证证据|原因|下一步|需要确认|风险|修复|改动|已完成|可以|不建议|白话解释|总结|最终判断|核心判断)(?:\s|[：:]|$)/;

/**
 * kiro-cli 的 turn 包装标记。
 *
 * 现场（thread_ms16zvb8ex5mdwem，2026-07-29）：assistant 消息正文末尾追加了下一轮的完整
 * prompt —— kiro-cli 自己的 `--- CONTEXT ENTRY ---` 包装 + Clowder 的 mission pack 与身份块。
 * 硬证据是包装里的 `Current time` 比消息自己的 timestamp 晚 5-7 分钟：模型不可能预知未来的
 * 毫秒级时间，所以这不是续写，而是 kiro-cli 在复用的 ACP session 上把新一轮输入回显成了
 * text chunk，被 accumulateTextAggregate 纯 append 并进正文后落库。
 *
 * 这些标记在 Clowder 侧没有任何生成点（只存在于 kiro-cli 二进制里），所以一旦出现在
 * agent 正文就必然是回显泄漏，从出现处截断到末尾。
 */
const LEAKED_ENVELOPE_CUT_RE = /(?:^|\n)[ \t]*(?:user|assistant)?[ \t]*--- CONTEXT ENTRY BEGIN ---/;

/** 只有结构性配套标记同时出现才算泄漏，避免正文偶然提到单个词就被截断。 */
const LEAKED_ENVELOPE_CONFIRM_RE = /--- (?:CONTEXT ENTRY END|USER MESSAGE BEGIN) ---/;

/**
 * 定位 fenced code block 区间。
 *
 * 排查这类泄漏时，正文本身就会引用这些标记（通常放在围栏里）。围栏内必须原样保留，
 * 否则讨论该问题的回复会被自己的清洗规则截断。
 */
function findFencedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenceRe = /^[ \t]*(`{3,}|~{3,})[^\n]*$/gm;
  let openStart: number | null = null;
  let openChar = '';
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    const fenceChar = match[1]![0]!;
    if (openStart === null) {
      openStart = match.index;
      openChar = fenceChar;
    } else if (fenceChar === openChar) {
      ranges.push([openStart, match.index + match[0].length]);
      openStart = null;
    }
  }
  // 未闭合的围栏一直延伸到末尾，否则截断点会落进代码里。
  if (openStart !== null) ranges.push([openStart, text.length]);

  return ranges;
}

function stripLeakedPromptEnvelope(text: string): string {
  if (!LEAKED_ENVELOPE_CONFIRM_RE.test(text)) return text;

  const fenced = findFencedRanges(text);
  const isFenced = (index: number) => fenced.some(([start, end]) => index >= start && index < end);

  let searchFrom = 0;
  while (searchFrom < text.length) {
    const match = LEAKED_ENVELOPE_CUT_RE.exec(text.slice(searchFrom));
    if (!match) return text;

    const absolute = searchFrom + match.index;
    if (!isFenced(absolute)) return text.slice(0, absolute);
    searchFrom = absolute + match[0].length;
  }

  return text;
}

function stripInlineArtifacts(text: string): string {
  return text
    .replace(OPENAI_CITATION_RE, '')
    .replace(BRACKET_CITATION_RE, '')
    .replace(COLON_CITATION_RE, '')
    .replace(COMPACT_CITATION_RE, '')
    .replace(TEMP_PATH_RE, '');
}

function normalizeUserVisibleTerms(text: string): string {
  return text.replace(/费曼(?:版|解释)?/g, '白话解释');
}

function isInternalProtocolBlock(block: string): boolean {
  return INTERNAL_PROTOCOL_PATTERNS.some((pattern) => pattern.test(block));
}

function isInternalRuntimeJsonBlock(block: string): boolean {
  const trimmed = block.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;

  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    return typeof parsed?.type === 'string' && INTERNAL_RUNTIME_JSON_TYPES.has(parsed.type);
  } catch {
    return false;
  }
}

function normalizeSignalLine(line: string): string {
  return line
    .trim()
    .replace(/^[#>*\-\s\d.)（(]+/, '')
    .replace(/^(\*\*|__)+/, '')
    .replace(/(\*\*|__)+$/, '')
    .replace(/^[^\p{Letter}\p{Number}]+/u, '')
    .trim();
}

function isInternalProgressLine(line: string): boolean {
  const normalized = normalizeSignalLine(line);
  return INTERNAL_PROGRESS_LINE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isUserFacingLine(line: string): boolean {
  return USER_FACING_LINE_RE.test(normalizeSignalLine(line));
}

/**
 * Final user-visible agent output sanitizer.
 *
 * This runs in the write pipeline, not in prompts, so it removes leaked runtime
 * protocol/log artifacts without changing how the agent reasons or chooses tools.
 */
export function sanitizeAgentVisibleOutput(content: string): string {
  if (!content) return content;

  // 先切掉回显泄漏的下一轮 prompt：必须在按空行分块之前做，因为泄漏段本身跨多个块。
  const normalized = stripLeakedPromptEnvelope(content.replace(/\r\n/g, '\n'));
  const blocks = normalized.split(/\n{2,}/);
  const cleanedBlocks: string[] = [];
  let suppressNarrativeAfterProgress = false;

  for (const block of blocks) {
    if (!block.trim()) continue;
    if (isInternalRuntimeJsonBlock(block)) continue;
    if (isInternalProtocolBlock(block)) continue;

    const rawLines = block.split('\n').map((line) =>
      normalizeUserVisibleTerms(stripInlineArtifacts(line))
        .replace(/[ \t]{2,}/g, ' ')
        .trimEnd(),
    );
    const hasInternalProgress = rawLines.some(isInternalProgressLine);
    const hasUserFacingLine = rawLines.some(isUserFacingLine);

    if (hasInternalProgress && !hasUserFacingLine) {
      suppressNarrativeAfterProgress = true;
      continue;
    }
    if (suppressNarrativeAfterProgress && !hasUserFacingLine) continue;
    if (hasUserFacingLine) suppressNarrativeAfterProgress = false;

    const cleanedLines = rawLines
      .filter((line) => !isInternalProgressLine(line))
      .filter((line) => line.trim().length > 0);

    if (cleanedLines.length > 0) {
      cleanedBlocks.push(cleanedLines.join('\n'));
    }
  }

  return cleanedBlocks.join('\n\n').trim();
}

/**
 * Progress 通道（ack/heartbeat）专用轻量清洗。
 *
 * progress 的语义就是「我正在做什么」，而 INTERNAL_PROGRESS_LINE_PATTERNS
 * 那套内部独白启发式（为正文防泄漏设计，几乎全是中文短语：初步结果/
 * 我开始做/收尾验证…）在这里语义完全错位——猫用中文正常汇报进度必然
 * 命中，整块被吞，实测表现为「只有 ASCII 能过」。这里只做协议泄漏与
 * 引用伪影清理，不做任何叙事过滤。
 */
export function sanitizeAgentProgressOutput(content: string): string {
  if (!content) return content;

  const normalized = stripLeakedPromptEnvelope(content.replace(/\r\n/g, '\n'));
  const blocks = normalized.split(/\n{2,}/);
  const cleanedBlocks: string[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    if (isInternalRuntimeJsonBlock(block)) continue;
    if (isInternalProtocolBlock(block)) continue;

    const lines = block
      .split('\n')
      .map((line) =>
        stripInlineArtifacts(line)
          .replace(/[ \t]{2,}/g, ' ')
          .trimEnd(),
      )
      .filter((line) => line.trim().length > 0);
    if (lines.length > 0) cleanedBlocks.push(lines.join('\n'));
  }

  return cleanedBlocks.join('\n\n').trim();
}
