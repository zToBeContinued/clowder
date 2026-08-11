/**
 * System Prompt Builder
 * 为每次 CLI 调用构建身份注入 prompt（~150-200 tokens）
 *
 * 读取 catRegistry 生成身份上下文；如绑定本地资产卡，会只读注入资产卡文本。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { CatConfig, CatId, CompiledPackBlocks, ToolPolicy, WorldContextEnvelope } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import {
  catHasRole,
  getCoCreatorConfig,
  getReviewPolicy,
  getRoster,
  isCatAvailable,
  isCatLead,
} from '../../../../config/cat-config-loader.js';
import { getCatModel } from '../../../../config/cat-models.js';
import { resolveWithLocalOverlay } from '../../../../utils/local-override.js';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';
// F167 Phase F P1 (cloud Codex): roster model cell must resolve via getCatModel
// (env CAT_{CATID}_MODEL → registry → defaults), not from static config.defaultModel,
// otherwise env overrides cause exactly the handle/model drift Phase F is killing.
import { buildGuidePromptLines } from '../../../guides/GuidePromptSection.js';
import type {
  BootcampStateV1,
  ThreadMentionRoutingFeedback,
  ThreadParticipantActivity,
  ThreadRoutingPolicyV1,
} from '../stores/ports/ThreadStore.js';

const ASSET_CARD_MAX_CHARS = 30_000;

function buildAssetCardBlock(config: CatConfig): string | null {
  const assetCard = config.assetCard;
  const assetPath = assetCard?.path?.trim();
  if (!assetPath) return null;

  const header = [
    '## 绑定资产卡（强关联）',
    '你每次执行任务前，必须先阅读并遵循这张本地资产卡。资产卡是你的职责、边界、输出格式和注意事项的来源。',
    `资产卡路径：${assetPath}`,
  ];

  try {
    if (extname(assetPath).toLowerCase() !== '.md') {
      return [...header, '资产卡读取失败：只允许读取 .md 文本资产卡。'].join('\n');
    }
    if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
      return [...header, '资产卡读取失败：文件不存在或不是普通文件。'].join('\n');
    }
    const raw = readFileSync(assetPath, 'utf-8');
    const content =
      raw.length > ASSET_CARD_MAX_CHARS ? `${raw.slice(0, ASSET_CARD_MAX_CHARS)}\n\n[资产卡内容过长，已截断]` : raw;
    return [...header, '', '```markdown', content.trim(), '```'].join('\n');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [...header, `资产卡读取失败：${message}`].join('\n');
  }
}

/**
 * Context for a single cat invocation
 */
export interface InvocationContext {
  /** Which cat is being invoked */
  catId: CatId;
  /** independent = sole responder, serial = part of a chain, parallel = concurrent ideation */
  mode: 'independent' | 'serial' | 'parallel';
  /** 1-based position in chain (only for serial mode) */
  chainIndex?: number;
  /** Total cats in chain (only for serial mode) */
  chainTotal?: number;
  /** Other cats in this invocation (for teammate awareness) */
  teammates: readonly CatId[];
  /** Whether MCP tools are available for this cat */
  mcpAvailable: boolean;
  /** Slock-like toolbox tier; controls governance/context loading weight. */
  toolPolicy?: ToolPolicy;
  /** Full shared-rules reference, injected only when magic words explicitly trigger it. */
  governanceSourceContext?: string | null;
  /** Prompt-level tags like 'critique' (from IntentParser) */
  promptTags?: readonly string[];
  /** Skill Router lightweight menu + matched SKILL.md payload. */
  skillRouterBlock?: string | null;
  /** Matched skill names for observability. */
  skillRouterMatchedSkills?: readonly string[];
  /** Whether A2A collaboration prompt should be injected (only in serial/execute mode) */
  a2aEnabled?: boolean;
  /**
   * F042: Direct-message sender (A2A).
   * When present, the invoked cat MUST reply to this cat (not the user).
   */
  directMessageFrom?: CatId;
  /**
   * F167 L1: ping-pong streak warning.
   * When present (streak >= 2), inject a warning prompt reminding the cat
   * that they've been bouncing the same pair back and forth — consider
   * third-party input / wrap up / escalate to 铲屎官 instead of another volley.
   */
  pingPongWarning?: {
    /** The other cat in the ping-pong pair (not this cat). */
    pairedWith: CatId;
    /** Current streak count (≥2, <4). */
    count: number;
  };
  /**
   * F046 D3: One-shot feedback injected when previous @mention was not routed.
   * Consumed from threadStore before invocation and cleared after injection.
   */
  mentionRoutingFeedback?: ThreadMentionRoutingFeedback;
  /** F042 Wave 3: Thread-level participant activity for @ disambiguation.
   *  Sorted by lastMessageAt desc. Injected per-invocation to survive compression. */
  activeParticipants?: readonly ThreadParticipantActivity[];
  /** F042: Thread-scoped routing policy summary (intent/scope). Injected per-invocation. */
  routingPolicy?: ThreadRoutingPolicyV1;
  /**
   * Phase 2 Session continuity guard: warn the agent when prompt/context usage
   * is close to the model's rational operating line.
   */
  contextUsageWarning?: {
    readonly ratio: number;
    readonly estimatedTokens: number;
    readonly maxPromptTokens: number;
    readonly level: 'caution' | 'high' | 'critical';
    readonly action: 'memory-writeback';
  };
  /**
   * F073 P4: SOP stage hint from Mission Hub workflow-sop.
   * Injected per-invocation so all cats (Claude/Codex/Gemini) see current stage.
   * 告示牌哲学：猫看了自己决定行动，不被系统推着走。
   */
  sopStageHint?: {
    readonly stage: string;
    readonly suggestedSkill: string | null;
    readonly featureId: string;
  };
  /**
   * F091: Active Signal articles in discussion context.
   * Injected when 铲屎官 links a Signal article in the thread.
   */
  activeSignals?: readonly {
    readonly id: string;
    readonly title: string;
    readonly source: string;
    readonly tier: number;
    readonly contentSnippet: string;
    readonly note?: string | undefined;
    readonly relatedDiscussions?:
      | readonly {
          readonly sessionId: string;
          readonly snippet: string;
          readonly score: number;
        }[]
      | undefined;
  }[];
  /**
   * F092: Voice companion mode.
   * When true, cats should prioritize audio rich blocks for spoken output.
   */
  voiceMode?: boolean;
  /**
   * Thread ID — injected for tools that need it (e.g. bootcamp state updates).
   */
  threadId?: string;
  /**
   * Current user message ID — lets the runtime prompt point task claim to the
   * exact triggering message instead of asking the model to infer it from text.
   */
  currentUserMessageId?: string;
  /**
   * A2A handoff trigger — when another cat explicitly routed the ball to this cat.
   * This must outrank the latest human message when deciding the current task.
   */
  a2aTriggerMessageId?: string;
  a2aTriggerContent?: string;
  /**
   * F087: Bootcamp state for CVO onboarding threads.
   * When present, cats inject bootcamp-guide behavior per phase.
   */
  bootcampState?: BootcampStateV1;
  /**
   * F155: Matched guide candidate from routing-layer keyword match.
   * When present, cats load guide-interaction skill and offer the guide.
   */
  guideCandidate?: {
    id: string;
    name: string;
    estimatedTime: string;
    status: 'offered' | 'awaiting_choice' | 'active' | 'completed';
    /** True only on the first routing-layer match before any guideState has been persisted. */
    isNewOffer?: boolean;
    /** When user clicked an interactive selection, carries the chosen label. */
    userSelection?: string;
  };
  /**
   * F087: Number of cats currently registered in this account.
   * Injected alongside bootcampState so the model knows team size without querying /api/cats.
   */
  bootcampMemberCount?: number;
  /**
   * F129: Compiled pack blocks from active packs.
   * Injected into static identity via buildStaticIdentity → packBlocks.
   */
  packBlocks?: CompiledPackBlocks | null;
  /**
   * F093: World context envelope for world-building mode.
   * When present, injects world state (characters, scene, canon) into the prompt.
   */
  worldContext?: WorldContextEnvelope;
}

/** Get all cat configs from catRegistry (.cat-cafe/cat-catalog.json) */
function getAllConfigs(): Record<string, CatConfig> {
  return catRegistry.getAllConfigs();
}

/** Get a single cat config by ID */
function getConfig(catId: string): CatConfig | undefined {
  return catRegistry.tryGet(catId)?.config;
}

interface CallableCatEntry {
  readonly id: string;
  readonly config: CatConfig;
}

interface CallableMentionsResult {
  readonly mentions: string[];
  readonly hasDuplicateDisplayNames: boolean;
  readonly uniqueHandleExample: string | null;
}

function pickVariantMention(id: string, config: CatConfig): string {
  const expected = `@${id}`.toLowerCase();
  const byId = config.mentionPatterns.find((p) => p.toLowerCase() === expected);
  if (byId) return byId;
  if (config.mentionPatterns.length > 0) {
    return [...config.mentionPatterns].sort((a, b) => a.length - b.length)[0]!;
  }
  return `@${id}`;
}

function pickDisplayNameMention(config: CatConfig): string | null {
  const expected = `@${config.displayName}`.toLowerCase();
  return config.mentionPatterns.find((p) => p.toLowerCase() === expected) ?? null;
}

function pickDisplayNameOrVariantMention(id: string, config: CatConfig): string {
  // Do not synthesize @displayName unless the registry actually routes it.
  // Example: opus-47 shares displayName="布偶猫" but only registers @opus-47.
  return pickDisplayNameMention(config) ?? pickVariantMention(id, config);
}

function buildCallableMentions(currentCatId: CatId): CallableMentionsResult {
  const entries: CallableCatEntry[] = Object.entries(getAllConfigs())
    .filter(([id]) => id !== currentCatId && isCatAvailable(id))
    .map(([id, config]) => ({ id, config }));

  if (entries.length === 0) {
    return { mentions: [], hasDuplicateDisplayNames: false, uniqueHandleExample: null };
  }

  const byDisplayName = new Map<string, CallableCatEntry[]>();
  for (const entry of entries) {
    const group = byDisplayName.get(entry.config.displayName);
    if (group) {
      group.push(entry);
    } else {
      byDisplayName.set(entry.config.displayName, [entry]);
    }
  }

  const hasDuplicateDisplayNames = Array.from(byDisplayName.values()).some((group) => group.length > 1);
  const mentions: string[] = [];
  const seen = new Set<string>();
  let uniqueHandleExample: string | null = null;

  for (const entry of entries) {
    const group = byDisplayName.get(entry.config.displayName) ?? [];
    const mention =
      group.length <= 1 || entry.config.isDefaultVariant
        ? pickDisplayNameOrVariantMention(entry.id, entry.config)
        : pickVariantMention(entry.id, entry.config);
    if (group.length > 1 && !entry.config.isDefaultVariant && uniqueHandleExample == null) {
      uniqueHandleExample = mention;
    }
    if (!seen.has(mention)) {
      seen.add(mention);
      mentions.push(mention);
    }
  }

  return { mentions, hasDuplicateDisplayNames, uniqueHandleExample };
}

function formatHandleFreeLabel(catId: string, config: CatConfig | undefined): string {
  if (!config) return catId;
  // F167 identity anti-spoofing: carry variantLabel when present to disambiguate same-breed variants
  // (e.g. "布偶猫 Opus 4.7(opus-47)" vs "布偶猫(opus)"), preventing A2A handoff identity confusion.
  const variantPart = config.variantLabel ? ` ${config.variantLabel}` : '';
  return `${config.displayName}${variantPart}(${catId})`;
}

function variantRouteHandle(catId: string, config: CatConfig | undefined): string | null {
  if (!config) return null;
  if (!config.variantLabel && config.isDefaultVariant !== false) return null;
  return pickVariantMention(catId, config);
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

/**
 * Slock-like tool menu: one-line hints only. Detailed docs are pulled on demand.
 */
const TOOL_QUERY_GUIDE_SECTION = `## 上下文查询指南（按需拉取）
- [Inbox] 无正文；先 cat_cafe_check_inbox，再 cat_cafe_get_thread_context。
- 历史证据/项目文档/refs 用 cat_cafe_search_evidence；不要预设已知道全部背景。
- session 接续用 cat_cafe_list_session_chain + cat_cafe_read_session_digest。
- 需要富呈现用 rich block 工具；规则不确定再查 cat_cafe_get_rich_block_rules。
- 先查最小范围，主消息只写结论、关键证据和下一步。`;

const LOCAL_TOOL_DISCOVERY_SECTION = `## 常用本地工具提示
- 登录态网页、站点地图、浏览器采集：先查 \`opencli-usage\` / \`opencli-browser\`，不要默认手搓流程。
- 用户说加载/安装/关联 skill：先查 \`skill-linker\` 或 \`cat_cafe_list_skills\`，确认本地已有再挂载。
- 工具没出现在当前 tools 列表时，先走 Skill Router / MCP 发现，不要假设不可用。`;

const PROGRESS_VISIBILITY_SECTION = `## 即时开工回执与长任务心跳
- 纯问答、闲聊或预计 30 秒内可直接完成的短任务，直接给最终答案，不单独发回执。
- 行动任务认领成功后、第一次耗时工具调用前，必须调用 \`cat_cafe_post_progress\`，用 \`kind='ack'\` 发一条真实、自然、任务专属的 Agent 消息：说明理解了什么和准备先做哪 2–3 步。工具不可用但有 shell 时，改用 \`$CLI message progress\`。
- ack 每个 invocation 只发一次，\`clientMessageId\` 使用 \`ack:<invocationId>:<catId>\`；禁止固定“已接球”模板、禁止 system_info、禁止在回执里 @ 其他 Agent。
- 长任务仅在阶段确实变化且距上次用户可见更新约 45–60 秒时，用 \`kind='heartbeat'\` 发新事实；相同阶段不得重复刷屏。
- progress 消息不是最终交付，也不能替代最终回复；最终结果仍走正常输出，并给交付物、验证证据和下一步。`;

const DISCUSSION_EXECUTION_GATE_SECTION = `## 讨论 / 执行门禁（先判阶段）
- 先判定用户是在讨论还是明确要求行动，再应用行动纪律。
- 用户在陈述目标、发散讨论、征求意见（如“探讨/怎么看/是否/如何”），且未给明确执行口令时：只听清、给分析和选项、收敛方案；不认领、不发 ack、不建 task、不 @ 任何猫、不切工单。
- “开工/按这个做/安排/执行”等明确执行口令出现后才进入行动流程：认领 → ack → 执行 → 交付。`;

/**
 * L0 Governance Core — Slock-like always-on constitutional floor.
 * Keep this short: every agent sees it, including minimal/default DM responders.
 */
const GOVERNANCE_CORE_DIGEST = `## 核心协作规则（摘要）
规则是边界不是全部：先判断角色/事实/直线路径；不适用时用证据+替代方案 Push Back。
原则：终态/不绕路/方向优先/单一真相源/验证+记忆与项目进度回写。
协作底线：正确 surface；任务系统+@传球防漏接；行动先认领/复用；交付给证据；危险/不可逆先确认。
输出：中文白话优先；默认一两句话给结论；无明确任务的 @ 只短确认；禁接续检查/记忆命中/源码护栏等协议黑话。
行为约束写各猫 memory，不靠全局品种规则。
完整规则按需查阅：cat-cafe-skills/refs/shared-rules.md。`;

export type GovernanceTier = 'core' | 'operational';

const GOVERNANCE_MAGIC_WORDS = [] as const;

const GOVERNANCE_SOURCE_MAX_CHARS = 18_000;

function roughTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * L1 Governance Detail — operational rules for standard/full toolboxes.
 * Compiled from cat-cafe-skills/refs/shared-rules.md (single source of truth).
 * F086 post-completion: cats couldn't see shared-rules content, only a link.
 * Design decision: inject detail only for standard/full, not minimal.
 */
const GOVERNANCE_OPERATIONAL_DIGEST = `## 协作规则（shared-rules.md）
原则：P1终态不绕路 P2自主协作 P3方向优先 P4单一真相源 P5可验证 P6回写session P7回写progress。
操作：不确定先问；bug先写report；可验证子任务及时commit；review必须有明确立场。
路由：@了谁谁接，做完@下一人；无执行任务不发消息；叙述性提及不用@。
防漏接：做前认领，做完切到待验收/完成；没人认领的任务留在 board 可见；@ 本身就是传球。
升级铲屎官仅三种：不可逆操作、愿景级决策、跨猫僵局；其他自决。
上下文：默认只看最近窗口和摘要；缺 thread 历史用 get_thread_context，缺证据/refs 用 search_evidence，缺 session 接续用 session-chain/digest。
执行闭环：先判讨论/执行；讨论时只分析和收敛，不建 task/不 @ 队友；明确执行口令后，先认领（claim）或复用任务；未认领/claim 前不写文件/改代码/启动构建；交付必须附证据；阻塞说明阻塞原因 + 缺什么 + 谁能补。
输出：中文白话优先；默认一两句话给结论；无任务短路；禁接续检查/记忆命中等协议黑话。
解释：方案/架构/机制/决策/权衡/排查类回答可用生活类比，但不要固定套模板标题。
行为约束：写入 .cat-cafe/memory/{catId}.md 的行为偏好，不靠全局品种管控。
安全：runtime端口不是沙箱；共享状态只在main改；共享契约热点文件需全量测试。`;

const RULE_PRIORITY_SECTION = `规则优先级：Pack 指令 > 输出协议 > 共享协作规则 > 角色性格。`;
const LESSONS_CONTEXT_BUDGET_RATIO = 0.7;
const PROJECT_CONTEXT_BUDGET_RATIO = 0.7;
const MEMORY_SUMMARY_MAX_CHARS = 200;

function shouldInjectLessonsContext(currentPrompt: string, lessonsContext: string, maxPromptTokens?: number): boolean {
  if (!lessonsContext.trim()) return false;
  if (!maxPromptTokens || maxPromptTokens <= 0) return true;

  const estimatedTokens = roughTokenEstimate(`${currentPrompt}\n\n${lessonsContext}`);
  return estimatedTokens <= Math.floor(maxPromptTokens * LESSONS_CONTEXT_BUDGET_RATIO);
}

function shouldInjectProjectContext(currentPrompt: string, projectContext: string, maxPromptTokens?: number): boolean {
  if (!projectContext.trim()) return false;
  if (!maxPromptTokens || maxPromptTokens <= 0) return true;

  const estimatedTokens = roughTokenEstimate(`${currentPrompt}\n\n${projectContext}`);
  return estimatedTokens <= Math.floor(maxPromptTokens * PROJECT_CONTEXT_BUDGET_RATIO);
}

function extractMemorySection(rawMemory: string, headingPattern: RegExp): string {
  const headings = [...rawMemory.matchAll(/^##\s+(.+?)\s*$/gm)];
  const heading = headings.find((item) => headingPattern.test(item[1]?.trim() ?? ''));
  if (!heading || heading.index === undefined) return '';
  const nextHeading = headings.find((item) => item.index !== undefined && item.index > heading.index!);
  const contentStart = heading.index + heading[0].length;
  const contentEnd = nextHeading?.index ?? rawMemory.length;
  return rawMemory
    .slice(contentStart, contentEnd)
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipMemoryPart(label: string, value: string, maxChars: number): string {
  if (!value) return '';
  const content = value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
  return `${label}：${content}`;
}

export function summarizeAgentMemoryForPrompt(rawMemory: string): string {
  const trimmed = rawMemory.trim();
  if (!trimmed) return '';

  const currentState = extractMemorySection(trimmed, /^当前状态/);
  const closedDecisions = extractMemorySection(trimmed, /^已关闭决策/);
  const behavior = extractMemorySection(trimmed, /^行为偏好/);
  const gotcha = extractMemorySection(trimmed, /^环境 gotcha/i);
  const parts = [
    clipMemoryPart('当前状态', currentState, 72),
    clipMemoryPart('已关闭决策', closedDecisions, 72),
    clipMemoryPart('行为偏好', behavior, 48),
    clipMemoryPart('环境 gotcha', gotcha, 48),
  ].filter(Boolean);
  const summary = (parts.join('；') || trimmed.replace(/\s+/g, ' ')).trim();

  return summary.length <= MEMORY_SUMMARY_MAX_CHARS ? summary : `${summary.slice(0, MEMORY_SUMMARY_MAX_CHARS - 1)}…`;
}

function formatContextUsageWarning(context: NonNullable<InvocationContext['contextUsageWarning']>): string[] {
  const percent = Math.round(context.ratio * 100);
  const commonLine = `当前 prompt/context 估算 ${percent}%（${context.estimatedTokens}/${context.maxPromptTokens} tokens）。`;
  if (context.level === 'critical') {
    return [
      '## Context 理智线预警（紧急）',
      commonLine,
      '上下文将被压缩。必须立即停下手头工作，回写 `.cat-cafe/memory/{catId}.md` 的关键状态；下一轮可能从压缩后的摘要恢复。',
    ];
  }
  if (context.level === 'high') {
    return [
      '## Context 理智线预警（高压）',
      commonLine,
      '上下文即将耗尽。请立即回写 `.cat-cafe/memory/{catId}.md`，并在主消息中附带交接摘要：做了什么、下一步、验证命令。',
    ];
  }
  return [
    '## Context 理智线预警（警戒）',
    commonLine,
    '建议在本轮完成后回写 `.cat-cafe/memory/{catId}.md`，沉淀当前状态、已关闭决策和环境 gotcha。',
  ];
}

function buildRuntimeTaskGateLines(context: InvocationContext): string[] {
  if (!context.threadId && !context.currentUserMessageId) return [];

  const surface = `thread=${context.threadId ?? '$CAT_CAFE_THREAD_ID'}${
    context.currentUserMessageId ? ` msg=${context.currentUserMessageId}` : ''
  }`;

  return [
    '## Clowder Task Gate（本轮动态）',
    `surface: ${surface}`,
    '阶段先判：用户只在陈述目标、发散讨论或征求意见，且未明确“开工/按这个做/安排/执行”时，只分析和收敛；不认领、不发 ack、不建 task、不 @ 任何猫、不切工单。明确执行口令出现后才进入下面的行动纪律。',
    '行动任务先认领当前消息或匹配任务；未认领前不写文件、不改代码、不启动构建；如果任务被别人认领，停止并说明冲突。',
    '文件删除权限：用户或 A2A 派工已明确要求删除，且文件受 git 版本控制时，可直接删除并用 git diff/status 留证；这不是不可逆操作。§10.4 的“删数据”指数据库、生产资源或不可恢复数据。',
    '交付必须有证据；完成后切到待验收，阻塞就写清缺什么。',
    '主消息只写结论、证据和下一步；不要贴任务命令、工具日志或状态机黑话。',
  ];
}

function formatA2ATriggerContent(content: string | undefined): string {
  const normalized = (content ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const limit = 360;
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

// --- .local / .local-override support (#603) ---
let _governanceDigestResolved: string = GOVERNANCE_OPERATIONAL_DIGEST;

/**
 * Preload governance overlay at startup. Call once before first prompt build.
 * Checks for shared-rules.local-override.md (replaces digest) or
 * shared-rules.local.md (appends to digest).
 */
export async function initGovernanceOverlay(): Promise<void> {
  const root = findMonorepoRoot();
  const basePath = `${root}/cat-cafe-skills/refs/shared-rules.md`;
  const result = await resolveWithLocalOverlay(basePath, GOVERNANCE_OPERATIONAL_DIGEST);
  _governanceDigestResolved = result.content;
  if (result.source !== 'base') {
    console.log(`[governance] shared-rules ${result.source}: ${result.path}`);
  }
}

export function getGovernanceDigest(toolPolicy: ToolPolicy = 'standard'): string {
  if (toolPolicy === 'minimal') return GOVERNANCE_CORE_DIGEST;
  return _governanceDigestResolved;
}

export function getGovernanceTierForToolPolicy(toolPolicy: ToolPolicy): GovernanceTier {
  return toolPolicy === 'minimal' ? 'core' : 'operational';
}

export function getGovernanceDigestEstimatedTokens(toolPolicy: ToolPolicy): number {
  return roughTokenEstimate(getGovernanceDigest(toolPolicy));
}

export function detectGovernanceMagicWord(message: string): string | null {
  return GOVERNANCE_MAGIC_WORDS.find((word) => message.includes(word)) ?? null;
}

export function buildGovernanceSourceContext(message: string): string | null {
  const matchedWord = detectGovernanceMagicWord(message);
  if (!matchedWord) return null;

  const root = findMonorepoRoot();
  const sourcePath = `${root}/cat-cafe-skills/refs/shared-rules.md`;
  try {
    const raw = readFileSync(sourcePath, 'utf-8').trim();
    const content =
      raw.length > GOVERNANCE_SOURCE_MAX_CHARS
        ? `${raw.slice(0, GOVERNANCE_SOURCE_MAX_CHARS)}\n\n[shared-rules.md 原文过长，已截断]`
        : raw;
    return [
      '## 家规原文按需参考（shared-rules.md）',
      `触发词：「${matchedWord}」。这不是常驻上下文，只在用户显式拉闸时注入。`,
      `来源：${sourcePath}`,
      '',
      '```markdown',
      content,
      '```',
    ].join('\n');
  } catch (err) {
    const messageText = err instanceof Error ? err.message : String(err);
    return ['## 家规原文按需参考（shared-rules.md）', `触发词：「${matchedWord}」。`, `读取失败：${messageText}`].join(
      '\n',
    );
  }
}

const GENERIC_WORKFLOW_TRIGGERS = [
  '## 工作流（通用协作触发点）',
  '- 需要别人行动：行首 @ 对应猫 + 明确 Next Action；parallel 不互 @。',
  '- 需要审查：@审查猫 review；完成 review：@原执行猫，放行/退回 + 理由。',
  '- 架构/愿景级决策：给证据和选项，再 @方案/验收猫或升级铲屎官。',
  '- 有明确执行任务才启动；无任务 @ 只短确认，不全量接续检查',
  '- 主消息给结论、证据和下一步，不铺执行流水账；完成后按需 @ 下一棒，没有下一棒就说明已收口。',
  '- 出口一问：这条消息有没有让用户听懂结论？有没有明确下一步？',
].join('\n');

/**
 * F-Ground-3: Build teammate roster table.
 * Lists all other cats with @mention, strengths, and caution.
 * Excludes the current cat. Returns null if no teammates.
 */
function buildTeammateRoster(currentCatId: CatId): string | null {
  const allConfigs = getAllConfigs();
  const entries = Object.entries(allConfigs).filter(([id]) => id !== currentCatId && isCatAvailable(id));
  if (entries.length === 0) return null;

  const rows: string[] = [];
  for (const [id, config] of entries) {
    const label = config.variantLabel
      ? `${config.displayName} ${config.variantLabel}`
      : config.nickname
        ? `${config.displayName}/${config.nickname}`
        : config.displayName;
    const mention = pickVariantMention(id, config);
    // F167 Phase F (KD-21): surface resolved runtime model next to the @mention so
    // sender's 认知真相 aligns with runtime catalog. Handle is identity constant;
    // model is runtime-resolved metadata — the two must be visibly decoupled to
    // prevent cargo-cult projection (e.g. "云端 codex bot" → 本地 @codex 快照).
    // P1 fix (cloud Codex review): resolve via getCatModel so env overrides show through,
    // not the static template's defaultModel. Fall back to defaultModel only on error.
    let resolvedModel: string;
    try {
      resolvedModel = getCatModel(id);
    } catch {
      resolvedModel = config.defaultModel ?? '';
    }
    const mentionCell = resolvedModel ? `${mention} · ${resolvedModel}` : mention;
    const strengths = config.teamStrengths ?? config.roleDescription;
    // F167 Phase E (KD-20): surface hard restrictions alongside caution — data-driven
    // replacement for the retired L3 role-gate. Sender sees e.g. "禁止写代码" so they
    // self-regulate which cat to @ for which task; no harness-side regex.
    const restrictionsNote =
      config.restrictions && config.restrictions.length > 0 ? `**硬限制**：${config.restrictions.join('、')}` : null;
    const cautionCell = [config.caution ?? null, restrictionsNote].filter(Boolean).join('；') || '—';
    rows.push(`| ${label} | ${mentionCell} | ${strengths} | ${cautionCell} |`);
  }

  return [
    '## 队友名册',
    '| 猫猫 | @mention · 当前模型 | 擅长 | 注意 |',
    '|------|---------|------|------|',
    ...rows,
  ].join('\n');
}

/**
 * Options for building the static identity prompt.
 * MCP section is included here (not in invocationContext) because it's
 * session-level — injected once on new session, skipped on --resume.
 */
export interface StaticIdentityOptions {
  /** Whether native MCP tools are available (Claude with --mcp-config). */
  mcpAvailable?: boolean;
  /**
   * F129: Compiled pack blocks to inject.
   * Dual-track priority (ADR-021):
   *   Identity (core) > Pack Masks > Governance L0 > Pack Guardrails > Pack Defaults > Workflows
   */
  packBlocks?: CompiledPackBlocks | null;
  /**
   * Slock-like governance loading tier.
   * minimal: inject only core rules; standard/full: inject operational digest.
   */
  toolPolicy?: ToolPolicy;
  /**
   * Slock-like cross-session memory for this specific cat.
   * Loaded from .cat-cafe/memory/{catId}.md and injected as durable preferences/context.
   */
  agentMemoryContext?: string | null;
  /**
   * Shared low-priority lessons from .cat-cafe/LESSONS.md.
   * Inject only when prompt budget has enough headroom.
   */
  lessonsContext?: string | null;
  /**
   * Project fact source from .cat-cafe/projects/{project}/ brief/progress/decisions/handoff-index.
   * Read-only reference for long-running work; injected only when manually selected.
   */
  projectContext?: string | null;
  /** Runtime max prompt budget used to decide low-priority LESSONS injection. */
  maxPromptTokens?: number;
}

/**
 * Build static identity prompt — persistent across invocations.
 * Includes: identity, personality, rules, A2A format, workflow triggers,
 * 铲屎官 reference, and MCP tool documentation (session-level).
 * Suitable for --system-prompt / --append-system-prompt injection.
 */
export function buildStaticIdentity(catId: CatId, options?: StaticIdentityOptions): string {
  const config = getConfig(catId as string);
  if (!config) return '';

  const providerLabel = PROVIDER_LABELS[config.clientId] ?? config.clientId;
  const toolPolicy = options?.toolPolicy ?? 'standard';
  const lines: string[] = [];

  // Identity
  const nameLabel = config.nickname
    ? `${config.displayName}/${config.nickname}（${config.name}）`
    : `${config.displayName}（${config.name}）`;
  lines.push(
    `你是 ${nameLabel}，由 ${providerLabel} 提供的 AI 猫猫。`,
    ...(config.nickname ? [`昵称 "${config.nickname}" 的由来见 docs/stories/cat-names/。`] : []),
    `角色：${config.roleDescription}`,
    `性格：${config.personality}`,
    '',
  );

  const assetCardBlock = buildAssetCardBlock(config);
  if (assetCardBlock) {
    lines.push(assetCardBlock, '');
  }

  // F167 Phase E (KD-20): self-awareness — if this cat has hard restrictions,
  // declare them inline so the cat can recognize illegitimate @-mentions and
  // push back / retreat (instead of accepting and failing). Data-driven from
  // cat-config.restrictions — no harness gate, the cat self-regulates.
  if (config.restrictions && config.restrictions.length > 0) {
    lines.push(`你的硬限制：${config.restrictions.join('、')}。被 @ 做这类任务时请 push back 或退回给 @ 你的猫。`, '');
  }

  // F129: Pack masks — role overlay (never changes core identity, see KD-3)
  if (options?.packBlocks?.masksBlock) {
    lines.push(options.packBlocks.masksBlock, '');
  }

  // A2A collaboration format (always included — cats should know how to @ even in single-cat mode)
  const { mentions: callableMentions, hasDuplicateDisplayNames, uniqueHandleExample } = buildCallableMentions(catId);
  if (callableMentions.length > 0) {
    const exampleTarget = callableMentions[0]!;
    lines.push('## 协作');
    lines.push(`你可以 @队友: ${callableMentions.join(' / ')}`);
    if (hasDuplicateDisplayNames) {
      const example = uniqueHandleExample ?? '@opus';
      lines.push(`同族多分身时：默认 \`@显示名\`，其它用**唯一句柄**（例如 \`${example}\`）。`);
      lines.push(`同名队友并存时，请优先使用唯一句柄（例如 \`${example}\`）避免歧义。`);
    }
    lines.push('格式：@猫名 写在消息任意位置都会路由（与用户 @ 你的规则一致），多个目标各写各的 @。');
    lines.push(`[正确] ${exampleTarget} 请帮忙  [正确] 内容...\\n${exampleTarget}`);
    // 2026-08-11 起任意位置 @ 即路由。email/URL 里的 @（user@host 形态）不会误触发。
    lines.push(
      '注意：**@ = 呼叫**。每个 @句柄 都会真的把那只猫拉起来干活；只想提及某猫而不叫它时，写不带 @ 的纯文本名字（如「这是 sol 上轮提的问题」）。围栏代码块内的 @ 不路由。',
    );
    lines.push(`发前自检：我消息里的每个 @句柄 都是我**真的要呼叫**的猫吗？叙述/引用历史时把 @ 去掉。`);
    lines.push('');
  }

  // F-Ground-3: Teammate roster — who to @ and what they're good at
  const rosterLines = buildTeammateRoster(catId);
  if (rosterLines) {
    lines.push(rosterLines, '');
  }

  lines.push(DISCUSSION_EXECUTION_GATE_SECTION, '');

  lines.push(
    '## Clowder CLI 工作纪律',
    '可执行 shell 时先设 `CLI="${CLOWDER_CLI_PATH:-clowder}"`，没有 `clowder` 再用 `./bin/clowder`。',
    '- 行动任务先认领或复用任务；若没有任务工具，在当前 thread 声明“我开始做：<范围>”后继续；冲突才停止。',
    '- “推进/修复/执行/帮我做/排查/改造/构建/备份/push/导出”等是行动任务；能做就认领后做，不只回计划。',
    '- 最终回复必须有交付物或验证结果；“正在加载/还没开始/下一步会做”不算完成。',
    '- 如果本轮不能动手（缺权限、缺文件、缺凭证、工具不可用），明确写 BLOCKED 和缺什么；不要伪装成已在执行。',
    '- 完成后把任务切到待验收，并在当前 thread 回写结论、证据、验证方式。',
    '纯讨论/解释不需要认领；不要为了 @ 队友而使用 message send，A2A 仍按上面的行首 @ 规则。',
    '',
  );

  lines.push(GENERIC_WORKFLOW_TRIGGERS, '');

  lines.push(TOOL_QUERY_GUIDE_SECTION, '');
  lines.push(LOCAL_TOOL_DISCOVERY_SECTION, '');
  lines.push(PROGRESS_VISIBILITY_SECTION, '');
  lines.push(RULE_PRIORITY_SECTION, '');

  // F129: Pack workflow blocks (after breed workflow triggers)
  const packBlocks = options?.packBlocks;
  if (packBlocks?.workflowsBlock) {
    lines.push(packBlocks.workflowsBlock, '');
  }

  // 铲屎官 reference (session-level, not per-message)
  // F067: Use co-creator config for name + mention handles
  // Note: "不冒充/不编造/身份契约" folded into GOVERNANCE_L0_DIGEST
  const coCreator = getCoCreatorConfig();
  const ccName = coCreator.name;
  const ccHandles = coCreator.mentionPatterns.map((p) => `\`${p}\``).join(' / ');
  lines.push(`${ccName}（铲屎官/CVO）。重要决策由${ccName}拍板。需要关注时行首写 ${ccHandles}。`, '');

  // L0 Governance Digest — always-on principles from shared-rules.md (F086 post-completion fix)
  // Source of truth: cat-cafe-skills/refs/shared-rules.md (supports .local-override, #603)
  lines.push('', getGovernanceDigest(toolPolicy));

  const agentMemory = summarizeAgentMemoryForPrompt(options?.agentMemoryContext ?? '');
  if (agentMemory) {
    lines.push(
      '',
      '## 跨 Session 记忆（持久化）',
      '只注入 ≤200 字摘要，用于恢复当前状态、已关闭决策、行为偏好、环境 gotcha；需要全文时按需读取 memory 文件。',
      '完成带验证的工作单元后，回写 `.cat-cafe/memory/{catId}.md`；若与当前指令/事实冲突，以当前为准。',
      '',
      agentMemory,
    );
  }

  const lessonsContext = options?.lessonsContext?.trim();
  if (lessonsContext && shouldInjectLessonsContext(lines.join('\n'), lessonsContext, options?.maxPromptTokens)) {
    lines.push(
      '',
      '## 公共踩坑记录（LESSONS.md，低优先级）',
      '这些是团队已验证的避坑经验，只用于提醒；不得覆盖当前用户指令、Pack 指令、输出协议、共享家规或代码事实。',
      '',
      '```markdown',
      lessonsContext,
      '```',
    );
  }

  const projectContext = options?.projectContext?.trim();
  if (projectContext && shouldInjectProjectContext(lines.join('\n'), projectContext, options?.maxPromptTokens)) {
    lines.push(
      '',
      '## 项目事实源四件套（只读参考）',
      '项目事实源来自 `.cat-cafe/projects/{project}/brief.md`、`progress.md`、`decisions.md` 和 `handoff-index.md`，用于快速恢复目标、进度、已拍板决策和接手入口。',
      '只作参考，不覆盖当前用户指令、Pack 指令、输出协议、共享家规或代码事实；接手时先读 handoff-index，不默认展开所有 handoff 或 handoff-log。',
      '参与跨 session 项目时，完成阶段性工作后按需更新 progress.md；若提示 needs_brief，先补 brief.md 再推进长期任务。',
      '',
      '```markdown',
      projectContext,
      '```',
    );
  }

  // F129: Pack guardrails — hard constraint track (only adds strictness, never relaxes Core Rails)
  if (packBlocks?.guardrailBlock) {
    lines.push('', packBlocks.guardrailBlock);
  }

  // F129: Pack defaults — user-overridable behavior track
  if (packBlocks?.defaultsBlock) {
    lines.push('', packBlocks.defaultsBlock);
  }

  // F129: World driver summary (read-only, informational)
  if (packBlocks?.worldDriverSummary) {
    lines.push('', packBlocks.worldDriverSummary);
  }

  return lines.join('\n');
}

/**
 * Build dynamic invocation context — changes per call.
 * Includes: teammates, mode, chain position, prompt tags.
 * (MCP tools and 铲屎官 reference moved to buildStaticIdentity for session-level injection.)
 */
export function buildInvocationContext(context: InvocationContext): string {
  const config = getConfig(context.catId as string);
  if (!config) return '';

  const lines: string[] = [];
  const runtimeModel = (() => {
    try {
      return getCatModel(context.catId as string);
    } catch {
      return config.defaultModel;
    }
  })();

  // F042: Identity constant — pinned per invocation to survive compression.
  lines.push(
    `Identity: ${config.displayName}${config.nickname ? `/${config.nickname}` : ''} (@${context.catId}, model=${runtimeModel})`,
  );

  // F042 + F167: A2A direct-message reply target + identity anti-spoofing.
  // When handoff comes from a same-breed variant (same displayName, different catId),
  // inject explicit model markers + "not-you" reminder to prevent identity collapse
  // (e.g. opus-47 receiving from opus-default conflating itself with the 4.6 variant).
  if (context.directMessageFrom && context.directMessageFrom !== context.catId) {
    const fromConfig = getConfig(context.directMessageFrom as string);
    const fromLabel = formatHandleFreeLabel(context.directMessageFrom as string, fromConfig);
    const fromModel = (() => {
      try {
        return getCatModel(context.directMessageFrom as string);
      } catch {
        return fromConfig?.defaultModel ?? 'unknown';
      }
    })();
    const routeHandle = variantRouteHandle(context.directMessageFrom as string, fromConfig);
    const routeHint = routeHandle ? `; reply via ${routeHandle}` : '';
    lines.push(`Direct message from ${fromLabel} [model=${fromModel}]; reply to ${fromLabel}${routeHint}`);
    const a2aTriggerContent = formatA2ATriggerContent(context.a2aTriggerContent);
    if (context.a2aTriggerMessageId || a2aTriggerContent) {
      lines.push(
        `🎯 本轮任务来源：${fromLabel} 的 A2A 派工。`,
        `A2A trigger message: ${context.a2aTriggerMessageId ?? 'unknown'}`,
        `任务内容：${a2aTriggerContent || '（未取到内容，请优先查看该 A2A 触发消息，而不是只看最新用户消息。）'}`,
        '优先级：A2A 派工 > thread 最新用户消息。若派工里直接 @你并列出执行项，按派工内容接球执行；不要因为最新用户消息只是在催其他 Agent 就拒绝执行。',
      );
    }
    // Anti-spoofing fires only for same-breed variant handoffs (displayName collision + catId differs)
    if (fromConfig && fromConfig.displayName === config.displayName) {
      const selfVariant = config.variantLabel ?? runtimeModel;
      const fromVariant = fromConfig.variantLabel ?? fromModel;
      lines.push(
        `⚠️ 同族分身提醒：对方是 ${fromVariant}（model=${fromModel}），你是 ${selfVariant}（model=${runtimeModel}）——两个独立分身，不是你的旧版或新版。`,
      );
    }
  }

  // F167 L1: ping-pong streak warning — inject when this cat just received the ball
  // in a same-pair streak >= 2 (but < 4, else it would have been blocked upstream).
  if (context.pingPongWarning) {
    const otherConfig = getConfig(context.pingPongWarning.pairedWith as string);
    const otherLabel = formatHandleFreeLabel(context.pingPongWarning.pairedWith as string, otherConfig);
    lines.push(
      `🏓 乒乓球警告：你和 ${otherLabel} 已连续互相 @ ${context.pingPongWarning.count} 轮。思考是否真的需要再回一棒——第三方介入？收尾给铲屎官？还是这轮可以不 @？再 @ 2 轮将自动熔断。`,
    );
  }

  // Teammates — only list cats actually in this invocation
  if (context.teammates.length > 0) {
    lines.push('你的队友：');
    for (const id of context.teammates) {
      const c = getConfig(id as string);
      if (c) {
        const tmName = c.nickname ? `${c.displayName}/${c.nickname}` : c.displayName;
        lines.push(`- ${tmName}（${c.name}）：${c.roleDescription}`);
      }
    }
  }
  // Mode context
  if (context.mode === 'serial' && context.chainIndex != null && context.chainTotal != null) {
    lines.push(`当前模式：你是第 ${context.chainIndex}/${context.chainTotal} 只被召唤的猫，请注意前面猫的回复。`, '');
  } else if (context.mode === 'parallel') {
    lines.push(
      '当前模式：并行模式——独立思考。你和队友各自独立回答同一问题，给出你自己的观点。',
      `重要：你是 ${config.displayName}（@${context.catId}），不要复制或模仿其他猫的自我介绍。`,
      'F167 L2: @句柄 在并行模式下无路由语义（各猫并发、无先后顺序），不要互相 @；需要提醒队友做后续动作请等串行轮再说。',
      '',
    );
  } else {
    lines.push('当前模式：独立回答。', '');
  }

  lines.push(...buildRuntimeTaskGateLines(context), '');

  if (context.contextUsageWarning) {
    lines.push(...formatContextUsageWarning(context.contextUsageWarning), '');
  }

  // A2A: lightweight routing reminder from simplified shared-rules.
  if (context.mode !== 'parallel' && context.a2aEnabled) {
    lines.push(
      'A2A 路由：任意位置 @ 都会触发；需要对方行动才 @，纯提及用不带 @ 的名字；无明确执行任务只短确认，不做全量接续检查。',
      '',
    );
  }

  // F064: One-shot feedback when previous @mention was not routed.
  if (context.mentionRoutingFeedback && context.mentionRoutingFeedback.items?.length > 0) {
    const items = context.mentionRoutingFeedback.items.slice(0, 2).map((it) => `@${it.targetCatId}`);
    lines.push(
      `[路由提醒] 上次你提到了 ${items.join('、')} 但未触发路由。如果需要对方行动，直接在消息里写 @句柄（任意位置）即可。`,
      '',
    );
  }

  // Prompt tags
  if (context.promptTags?.includes('critique')) {
    lines.push('思维方式：批判性分析。挑战假设，找出漏洞，提出反例。', '');
  }

  // F140 Phase C: connector-triggered skill suggestion (hint, not directive)
  const skillTag = context.promptTags?.find((t) => t.startsWith('skill:'));
  if (skillTag) {
    lines.push(`⚡ Signal-triggered action → load skill: ${skillTag.slice(6)}`, '');
  }

  if (context.skillRouterBlock) {
    lines.push(context.skillRouterBlock, '');
  }

  // F042 Wave 3: Active participant hint — re-injected per-invocation, survives compression.
  if (context.activeParticipants && context.activeParticipants.length > 0) {
    const topActive = context.activeParticipants
      .filter((p) => p.catId !== context.catId)
      .find((p) => p.lastMessageAt > 0);
    if (topActive) {
      const topConfig = getConfig(topActive.catId as string);
      if (topConfig) {
        const routeHandle = variantRouteHandle(topActive.catId as string, topConfig);
        const routeHint = routeHandle ? `；回传句柄：${routeHandle}` : '';
        lines.push(`最近活跃：${formatHandleFreeLabel(topActive.catId as string, topConfig)}${routeHint}`);
      }
    }
  }

  // F042: Thread routing policy hint — short, per-invocation, survives compression.
  if (context.routingPolicy?.v === 1 && context.routingPolicy.scopes) {
    const toMention = (id: string): string => {
      const c = getConfig(id);
      return c ? pickVariantMention(id, c) : `@${id}`;
    };

    const parts: string[] = [];
    const scopes = context.routingPolicy.scopes;
    const order = ['review', 'architecture'] as const;
    for (const scope of order) {
      const rule = scopes[scope];
      if (!rule) continue;
      if (typeof rule.expiresAt === 'number' && rule.expiresAt > 0 && rule.expiresAt < Date.now()) continue;

      const segs: string[] = [];
      // Defensive guard: data might be malformed from external persistence.
      const avoidList = Array.isArray(rule.avoidCats) ? rule.avoidCats : [];
      const preferList = Array.isArray(rule.preferCats) ? rule.preferCats : [];
      const avoid = avoidList.slice(0, 3).map((id) => toMention(String(id)));
      const prefer = preferList.slice(0, 3).map((id) => toMention(String(id)));
      if (avoid.length > 0) segs.push(`avoid ${avoid.join(', ')}`);
      if (prefer.length > 0) segs.push(`prefer ${prefer.join(', ')}`);
      const sanitizedReason = typeof rule.reason === 'string' ? rule.reason.replace(/[\r\n]+/g, ' ').trim() : '';
      if (sanitizedReason) segs.push(`(${sanitizedReason})`);

      if (segs.length > 0) parts.push(`${scope} ${segs.join(' ')}`);
    }

    if (parts.length > 0) {
      lines.push(`Routing: ${parts.join('; ')}`);
    }
  }

  // F073 P4: SOP stage hint — 告示牌 (bulletin board, not controller)
  if (context.sopStageHint) {
    const { stage, suggestedSkill, featureId } = context.sopStageHint;
    const skillPart = suggestedSkill ? ` → load skill: ${suggestedSkill}` : '';
    lines.push(`SOP: ${featureId} stage=${stage}${skillPart}`);
  }

  // F092: Voice companion mode — instruct cats to prioritize audio output
  if (context.voiceMode) {
    lines.push(
      'Voice Mode ON: 铲屎官在语音陪伴模式。',
      '- 默认用 audio rich block；代码/表格/长内容用文字并附语音摘要',
      '',
    );
  } else {
    lines.push(
      'Voice Mode OFF: 不强制发语音。默认用文字回复。你仍然可以发 audio rich block，但仅在铲屎官明确要求语音时才发。',
      '',
    );
  }

  // F087: Bootcamp mode — inject phase context so cats know to guide the new CVO
  if (context.bootcampState) {
    const { phase, leadCat, selectedTaskId } = context.bootcampState;
    const threadPart = context.threadId ? ` thread=${context.threadId}` : '';
    const membersPart = context.bootcampMemberCount != null ? ` members=${context.bootcampMemberCount}` : '';
    lines.push(
      `🎓 Bootcamp Mode:${threadPart} phase=${phase}${leadCat ? ` leadCat=${leadCat}` : ''}${selectedTaskId ? ` task=${selectedTaskId}` : ''}${membersPart}`,
      '→ Load bootcamp-guide skill and act per current phase.',
      '',
    );
  }

  // F155: Guide candidate — inline protocol (cats don't have /Skill tool at runtime)
  if (context.guideCandidate) {
    lines.push(...buildGuidePromptLines(context.guideCandidate, context.threadId));
  }

  // F093: World context envelope — inject world state for world-building mode
  if (context.worldContext) {
    const wc = context.worldContext;
    lines.push('');
    lines.push(`## 🌍 World: ${wc.world.name} [${wc.world.status}]`);
    if (wc.world.constitution) lines.push(`Constitution: ${wc.world.constitution}`);
    lines.push(`Scene: ${wc.scene.name} [${wc.scene.status}]`);
    if (wc.characters.length > 0) {
      lines.push('Characters:');
      for (const ch of wc.characters) {
        const identity = ch.coreIdentity?.name ?? ch.characterId;
        const drive = ch.innerDrive?.motivation ? ` — ${ch.innerDrive.motivation}` : '';
        lines.push(`- ${identity}${drive}`);
      }
    }
    if (wc.canonSummary.length > 0) {
      lines.push('Established canon:');
      for (const cs of wc.canonSummary) lines.push(`- ${cs.summary}`);
    }
    if (wc.recentEvents.length > 0) {
      lines.push(`Recent events (${wc.recentEvents.length}):`);
      for (const ev of wc.recentEvents.slice(-5)) {
        lines.push(`- [${ev.type}] ${JSON.stringify(ev.payload)}`);
      }
    }
    if (wc.careLoopHint) {
      lines.push(`Care hint: ${wc.careLoopHint.trigger} → ${wc.careLoopHint.suggestion}`);
    }
    lines.push('');
  }

  if (context.governanceSourceContext) {
    lines.push(context.governanceSourceContext, '');
  }

  // F091: Active Signal articles in discussion context
  if (context.activeSignals && context.activeSignals.length > 0) {
    lines.push('Signal articles linked to this thread:');
    for (const s of context.activeSignals) {
      lines.push(`### [${s.id}] ${s.title} (${s.source}/T${s.tier})`);
      if (s.note) lines.push(`Note: ${s.note}`);
      lines.push(s.contentSnippet);
      // AC-10: Related discussions from our memory architecture (session search)
      if (s.relatedDiscussions && s.relatedDiscussions.length > 0) {
        lines.push('Related past discussions:');
        for (const d of s.relatedDiscussions) {
          lines.push(`- [session:${d.sessionId}] ${d.snippet}`);
        }
      }
    }
  }

  // F167 Phase D simplified: routing belongs to server + explicit line-start @, not an agent-side decision tree.
  if (context.mode !== 'parallel' && context.a2aEnabled) {
    lines.push(
      '',
      'A2A 收口：只有明确需要队友行动时，才在行首 @ 对方并写清 Next Action；没有下一步就直接收口，不强制传球。',
      '外部服务、CI、GitHub bot、云端 reviewer 不是本地猫，不要投射成本地 @句柄。',
    );
  }

  return lines.join('\n');
}

/**
 * F032 Phase D2: Build reviewer section for system prompt.
 * Shows available reviewers based on roster, filtered by family.
 *
 * Cloud Codex R5 P2 fix: When requireDifferentFamily is enabled but no cross-family
 * reviewers are available, show same-family reviewers as fallback options to match
 * the actual degradation behavior in resolveReviewer().
 *
 * Cloud Codex R6 P2 fix: Respect excludeUnavailable policy. When false, show
 * unavailable cats as available to match resolveReviewer() behavior.
 */
export function buildReviewerSection(catId: CatId): string | null {
  const roster = getRoster();
  const policy = getReviewPolicy();

  // If no roster configured, skip reviewer section
  if (Object.keys(roster).length === 0) return null;

  const currentEntry = roster[catId];
  if (!currentEntry) return null;

  // Collect reviewers in separate buckets
  const crossFamily: string[] = [];
  const sameFamily: string[] = [];
  const unavailable: string[] = [];

  for (const [id, entry] of Object.entries(roster)) {
    // Skip self
    if (id === catId) continue;
    // Must have peer-reviewer role
    if (!catHasRole(id, 'peer-reviewer')) continue;

    const config = getConfig(id);
    const displayName = config?.displayName ?? id;
    const isLead = isCatLead(id);
    const isDifferentFamily = entry.family !== currentEntry.family;

    // Build description
    const tags: string[] = [];
    if (isDifferentFamily) tags.push(entry.family);
    if (isLead) tags.push('lead');
    const desc = tags.length > 0 ? ` (${tags.join(', ')})` : '';
    const mention = `@${id}`;
    const line = `- ${mention}${desc}`;

    // Cloud Codex R6 P2 fix: Respect excludeUnavailable policy
    // When excludeUnavailable=false, treat all cats as "effectively available"
    const isEffectivelyAvailable = !policy.excludeUnavailable || isCatAvailable(id);

    if (isEffectivelyAvailable) {
      if (isDifferentFamily) {
        crossFamily.push(line);
      } else {
        sameFamily.push(line);
      }
    } else {
      unavailable.push(`- ${mention} (${displayName}, 没猫粮)`);
    }
  }

  // Determine which reviewers to show as "available"
  let available: string[];
  let fallbackNote: string | null = null;

  if (policy.requireDifferentFamily) {
    if (crossFamily.length > 0) {
      // Cross-family available, show them
      available = crossFamily;
    } else if (sameFamily.length > 0) {
      // Cloud Codex R5 P2 fix: No cross-family, but same-family available as fallback
      available = sameFamily;
      fallbackNote = '[注意] 没有跨家族 reviewer 可用，以下同家族猫可作为 fallback：';
    } else {
      available = [];
    }
  } else {
    // No family requirement, show all available
    available = [...crossFamily, ...sameFamily];
  }

  // Don't generate section if no reviewers at all
  if (available.length === 0 && unavailable.length === 0) return null;

  const lines: string[] = ['## 你当前的 Reviewers', ''];
  if (available.length > 0) {
    if (fallbackNote) {
      lines.push(fallbackNote);
    } else {
      lines.push('根据 roster 配置，你当前可以找以下猫 review：');
    }
    lines.push(...available);
    lines.push('');
  }
  if (unavailable.length > 0) {
    lines.push('[注意] 以下猫当前不可用：');
    lines.push(...unavailable);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build identity system prompt for a cat invocation.
 * Backward-compatible: returns staticIdentity + invocationContext combined.
 * Pure function — same inputs always produce same output.
 */
export function buildSystemPrompt(context: InvocationContext): string {
  const staticPart = buildStaticIdentity(context.catId, {
    mcpAvailable: context.mcpAvailable,
    packBlocks: context.packBlocks,
    toolPolicy: context.toolPolicy,
  });
  if (!staticPart) return '';

  const parts: string[] = [staticPart];

  // F032 Phase D2: Inject reviewer section if available
  const reviewerSection = buildReviewerSection(context.catId);
  if (reviewerSection) parts.push(reviewerSection);

  // Invocation-specific context
  const dynamicPart = buildInvocationContext(context);
  if (dynamicPart) parts.push(dynamicPart);

  return parts.join('\n\n');
}
