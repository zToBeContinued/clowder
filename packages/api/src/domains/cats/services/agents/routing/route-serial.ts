/**
 * Serial Route Strategy
 * Cats respond one by one, each seeing previous responses.
 *
 * A2A support: after each cat completes, its response is checked for @mentions.
 * If a mention is detected and depth allows, the mentioned cat is appended to the
 * worklist — extending the chain within the SAME function call. This preserves
 * previousResponses continuity and correct isFinal semantics (缅因猫 P1-1, P1-2).
 *
 * A2A only triggers here in routeSerial; routeParallel never chains (MVP safety boundary).
 */

import type { CatConfig, CatId, RichBlock } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import type { Span } from '@opentelemetry/api';
import { context, trace } from '@opentelemetry/api';
import { getConfigSessionStrategy, isSessionChainEnabled } from '../../../../../config/cat-config-loader.js';
import { getCatVoice } from '../../../../../config/cat-voices.js';
import {
  type ResolvedToolPolicy,
  resolveEffectiveToolPolicy,
  shouldLoadFullContext,
  shouldLoadStandardContext,
} from '../../../../../config/tool-policy.js';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import {
  AGENT_ID,
  ROUTE_HAS_A2A_HANDOFF,
  ROUTE_TOTAL_CATS_INVOKED,
  ROUTE_TOTAL_TOKENS,
} from '../../../../../infrastructure/telemetry/genai-semconv.js';
import {
  inlineActionChecked,
  inlineActionDetected,
  inlineActionFeedbackWriteFailed,
  inlineActionFeedbackWritten,
  inlineActionHintEmitFailed,
  inlineActionHintEmitted,
  lineStartDetected,
} from '../../../../../infrastructure/telemetry/instruments.js';
import { detectUserMention } from '../../../../../routes/user-mention.js';
import { estimateTokens } from '../../../../../utils/token-counter.js';
import {
  ackGuideCompletion,
  guideContextForCat,
  prepareGuideContext,
} from '../../../../guides/GuideRoutingInterceptor.js';
import { assembleContext } from '../../context/ContextAssembler.js';
import { resolveContextLayerPlan } from '../../context/ContextLayerRouter.js';
import { resolveSkillRouterContext } from '../../context/SkillRouter.js';
import {
  buildGovernanceSourceContext,
  buildInvocationContext,
  buildStaticIdentity,
  getGovernanceDigestEstimatedTokens,
  getGovernanceTierForToolPolicy,
  type InvocationContext,
} from '../../context/SystemPromptBuilder.js';
import { formatDegradationMessage } from '../../orchestration/DegradationPolicy.js';
import { AuditEventTypes, getEventAuditLog } from '../../orchestration/EventAuditLog.js';
import { buildSessionBootstrap } from '../../session/SessionBootstrap.js';
import {
  hydrateReplyPreview,
  isDelivered,
  type StoredMessage,
  type StoredToolEvent,
  type StreamMetadataAugmentInput,
  type ThreadAppendWatermark,
} from '../../stores/ports/MessageStore.js';
import type { Thread, ThreadRoutingPolicyV1 } from '../../stores/ports/ThreadStore.js';
import { getStreamingTtsRegistry, StreamingTtsChunker } from '../../tts/StreamingTtsChunker.js';
import { getVoiceBlockSynthesizer } from '../../tts/VoiceBlockSynthesizer.js';
import type { AgentMessage, AgentMessageType, MessageMetadata } from '../../types.js';
import { buildCapsuleFromRouteState } from '../invocation/CollaborationContinuityCapsule.js';
import { finalizeHistoryCriticalPublication } from '../invocation/HistoryCriticalSeal.js';
import { invokeSingleCat } from '../invocation/invoke-single-cat.js';
import {
  buildMcpCallbackInstructions,
  hasRuntimeNativeMcpBridge,
  needsMcpInjection,
} from '../invocation/McpPromptInjector.js';
import { getRichBlockBuffer } from '../invocation/RichBlockBuffer.js';
import { readAgentMemoryForPrompt } from '../memory/AgentMemoryStore.js';
import { readLessonsForPrompt } from '../memory/LessonStore.js';
import { readProjectProgressForPrompt } from '../memory/ProjectProgressStore.js';
import { resolveDefaultClaudeMcpServerPath } from '../providers/ClaudeAgentService.js';
import { detectInlineActionMentions, getMaxA2ADepth, parseA2AMentions } from '../routing/a2a-mentions.js';
import {
  isSubstantiveTool,
  registerWorklist,
  unregisterWorklist,
  updateStreakOnPush,
} from '../routing/WorklistRegistry.js';
import { accumulateTextAggregate } from '../text-aggregation.js';
import { sanitizeAgentVisibleOutput } from './agent-output-sanitizer.js';
import { extractContextEvalSignals } from './context-eval.js';
import { validateRoutingSyntax } from './final-routing-slot.js';
import { buildBriefingMessage } from './format-briefing.js';
import { extractRichFromText, isValidRichBlock } from './rich-block-extract.js';
import type {
  A2ARoutingBlockedReason,
  HistorySummaryObservation,
  RouteOptions,
  RouteStrategyDeps,
} from './route-helpers.js';
import {
  appendCompactBoundaryTaskEvent,
  assembleIncrementalContext,
  buildContextUsageWarning,
  buildHistoryCriticalSealIntent,
  buildHistoryGovernanceObservation,
  buildRuntimeContextBudgetSnapshot,
  createLeakedToolCallStreamStripper,
  detectContextDegradation,
  estimateFullHistoryTokens,
  formatA2ATriggerPrompt,
  formatFreshnessReviewPrompt,
  freshnessPersistenceEgress,
  getEffectiveRuntimeContextBudget,
  getService,
  getThreadBootcampMemberCount,
  isContentFreeInboxEnabled,
  isDeliveryOnlyEnabled,
  isHistoryGovernanceObserveEnabled,
  isUserFacingSystemInfoContent,
  parseCompactBoundarySystemInfo,
  persistA2ADeferredNotice,
  persistA2ARoutingBlockedNotice,
  persistSilentCompletionNotice,
  publishFreshnessDraft,
  readHistoryForGovernanceObservation,
  routeContentBlocksForCat,
  sanitizeInjectedContent,
  selectExplicitPromptMessage,
  toStoredToolEvent,
  upsertMaxBoundary,
} from './route-helpers.js';

import { appendThinkingChunk, renderThinkingChunks } from './thinking-chunks.js';

const log = createModuleLogger('route-serial');

/**
 * A serial chain promises that later cats can see earlier persisted replies.
 * Keep an explicit user minimal override intact, but prevent the short-message
 * auto downgrade from erasing that chain context. The caller still assembles
 * context through the normal persisted incremental/freshness path.
 */
export function resolveSerialChainToolPolicy(
  resolvedToolPolicy: ResolvedToolPolicy,
  worklistSize: number,
): ResolvedToolPolicy {
  if (
    worklistSize > 1 &&
    resolvedToolPolicy.toolPolicy === 'minimal' &&
    resolvedToolPolicy.source === 'agent-default'
  ) {
    return { toolPolicy: 'standard', source: 'agent-default' };
  }
  return resolvedToolPolicy;
}

async function synthesizePublishedVoiceBlocks(
  deps: RouteStrategyDeps,
  message: StoredMessage,
  blocks: RichBlock[],
  catId: CatId,
): Promise<RichBlock[]> {
  const voiceSynth = getVoiceBlockSynthesizer();
  if (!voiceSynth || !blocks.some((block) => block.kind === 'audio' && 'text' in block)) return blocks;
  try {
    const resolved = await voiceSynth.resolveVoiceBlocks(blocks, catId as string);
    await deps.messageStore.updateExtra(message.id, {
      ...(message.extra ?? {}),
      rich: { v: 1, blocks: resolved },
    });
    return resolved;
  } catch (err) {
    log.error({ catId: catId as string, err }, 'Published voice block synthesis failed');
    return blocks;
  }
}
const routeSerialTracer = trace.getTracer('cat-cafe-api', '0.1.0');

function collectStructuredTargetCatsFromInput(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];

  const parsed = input as { targetCats?: unknown; targets?: unknown };
  const values = Array.isArray(parsed.targetCats)
    ? parsed.targetCats
    : Array.isArray(parsed.targets)
      ? parsed.targets
      : [];
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function isPostMessageToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  if (toolName.endsWith('cat_cafe_post_message')) return true;
  return toolName === 'mcp:cat-cafe/post_message' || toolName === 'cat_cafe_post_message';
}

function isFreshnessReviewToolName(toolName: string | undefined): boolean {
  if (!toolName) return false;
  if (toolName.endsWith('cat_cafe_review_held_message')) return true;
  return toolName === 'mcp:cat-cafe/review_held_message' || toolName === 'cat_cafe_review_held_message';
}

function isCallbackDeliveryToolName(toolName: string | undefined): boolean {
  return isPostMessageToolName(toolName) || isFreshnessReviewToolName(toolName);
}

type CallbackDisposition = 'none' | 'published' | 'held' | 'discarded';

type CallbackPostResult = {
  confirmed: boolean;
  disposition: CallbackDisposition;
  replayed?: true;
  messageId?: string;
  threadId?: string;
  holdId?: string;
};

function collectCallbackPostResultCandidates(content: string): string[] {
  const candidates = new Set<string>();
  const trimmed = content.trim();
  if (trimmed) candidates.add(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) candidates.add(candidate);
  }
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart > 0) candidates.add(trimmed.slice(jsonStart));
  return [...candidates];
}

function callbackPostResultFromPayload(parsed: {
  status?: unknown;
  disposition?: unknown;
  messageId?: unknown;
  threadId?: unknown;
  holdId?: unknown;
}): CallbackPostResult | null {
  let disposition: CallbackDisposition = 'none';
  if (parsed.disposition === 'published' || parsed.status === 'ok' || parsed.status === 'duplicate') {
    disposition = 'published';
  } else if (
    parsed.disposition === 'held' ||
    parsed.status === 'freshness_held' ||
    parsed.status === 'freshness_needs_attention' ||
    parsed.status === 'freshness_exhausted'
  ) {
    disposition = 'held';
  } else if (parsed.disposition === 'discarded' || parsed.status === 'freshness_discarded') {
    disposition = 'discarded';
  }
  if (disposition === 'none' && parsed.status === undefined) return null;
  return {
    confirmed: disposition !== 'none',
    disposition,
    ...(parsed.status === 'duplicate' ? { replayed: true as const } : {}),
    ...(typeof parsed.messageId === 'string' && parsed.messageId.length > 0 ? { messageId: parsed.messageId } : {}),
    ...(typeof parsed.threadId === 'string' && parsed.threadId.length > 0 ? { threadId: parsed.threadId } : {}),
    ...(typeof parsed.holdId === 'string' && parsed.holdId.length > 0 ? { holdId: parsed.holdId } : {}),
  };
}

function parseCallbackPostResult(content: string | undefined): CallbackPostResult {
  if (!content) return { confirmed: false, disposition: 'none' };
  for (const candidate of collectCallbackPostResultCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as {
        status?: unknown;
        disposition?: unknown;
        messageId?: unknown;
        threadId?: unknown;
        holdId?: unknown;
      };
      const result = callbackPostResultFromPayload(parsed);
      if (result) return result;
    } catch {
      // Try the next candidate shape.
    }
  }

  return {
    confirmed: /"status"\s*:\s*"(ok|duplicate)"/.test(content),
    disposition: /"status"\s*:\s*"(ok|duplicate)"/.test(content) ? 'published' : 'none',
    ...(/"status"\s*:\s*"duplicate"/.test(content) ? { replayed: true as const } : {}),
  };
}

function inferToolResultName(msg: AgentMessage): string | undefined {
  if (msg.toolName) return msg.toolName;
  const firstLine = msg.content?.trimStart().split('\n', 1)[0]?.trim();
  if (!firstLine) return undefined;
  const mcpLabel = firstLine.match(/^(mcp:[^\s]+)\s+\(/);
  if (mcpLabel?.[1]) return mcpLabel[1];
  if (firstLine.startsWith('command: ')) return 'command_execution';
  return undefined;
}

function toolNamesMatch(a: string, b: string): boolean {
  return (
    a === b ||
    (isPostMessageToolName(a) && isPostMessageToolName(b)) ||
    (isFreshnessReviewToolName(a) && isFreshnessReviewToolName(b))
  );
}

function consumePendingToolResult(
  pendingToolResults: string[],
  msg: AgentMessage,
  hasConfirmingContent: boolean,
  hasCallbackPostEvidence: boolean,
): string | undefined {
  const resultToolName = inferToolResultName(msg);
  if (resultToolName) {
    const pendingIndex = pendingToolResults.findIndex((name) => toolNamesMatch(name, resultToolName));
    if (pendingIndex === -1) return undefined;
    pendingToolResults.splice(pendingIndex, 1);
    return resultToolName;
  }

  const firstPending = pendingToolResults[0];
  if (!firstPending) return undefined;

  if (!isCallbackDeliveryToolName(firstPending)) {
    return pendingToolResults.shift();
  }

  if (hasConfirmingContent && hasCallbackPostEvidence) {
    return pendingToolResults.shift();
  }

  if (hasConfirmingContent && pendingToolResults.length === 1) {
    return pendingToolResults.shift();
  }

  return undefined;
}

function hasStreamMetadataPatch(patch: StreamMetadataAugmentInput): boolean {
  return Boolean(
    patch.thinking || patch.metadata || patch.toolEvents?.length || patch.replyTo || patch.mentionsUser || patch.extra,
  );
}

export async function* routeSerial(
  deps: RouteStrategyDeps,
  targetCats: CatId[],
  message: string,
  userId: string,
  threadId: string,
  options: RouteOptions = {},
): AsyncIterable<AgentMessage> {
  const {
    contentBlocks,
    uploadDir,
    signal,
    promptTags,
    contextHistory,
    history,
    currentUserMessageId,
    modeSystemPrompt,
    modeSystemPromptByCat,
    queueHasQueuedMessages,
    hasQueuedOrActiveAgentForCat,
    enqueueA2ATargets,
  } = options;
  const freshnessReview = options.persistenceContext?.freshnessReview;
  if (freshnessReview) {
    message = formatFreshnessReviewPrompt(freshnessReview);
  }
  const previousResponses: { catId: CatId; content: string }[] = [];
  const thinkingMode = options.thinkingMode ?? 'play';
  // P2-3 fix: also consider default MCP server path (ClaudeAgentService has fallback resolution)
  const mcpServerPath = process.env.CAT_CAFE_MCP_SERVER_PATH || resolveDefaultClaudeMcpServerPath();
  const incrementalMode = Boolean(currentUserMessageId && deps.deliveryCursorStore);

  // Worklist pattern: starts with targetCats, may grow via A2A mentions
  // F27: Register worklist so callback A2A can push targets here
  // F108: Key by parentInvocationId for concurrent isolation
  const worklist = [...targetCats];
  const maxDepth = options.maxA2ADepth ?? getMaxA2ADepth();
  const a2aRoutingMode =
    options.a2aRoutingMode ?? (process.env.CAT_CAFE_A2A_ROUTING_MODE === 'slock' ? 'slock' : 'legacy');
  const enableHiddenTextScanA2A = a2aRoutingMode !== 'slock';
  const worklistEntry = registerWorklist(threadId, worklist, maxDepth, options.parentInvocationId);
  if (targetCats.length === 1 && options.directMessageFrom) {
    const targetCat = targetCats[0]!;
    worklistEntry.a2aFrom.set(targetCat, options.directMessageFrom);
    if (options.a2aTriggerMessageId) worklistEntry.a2aTriggerMessageId.set(targetCat, options.a2aTriggerMessageId);
  }

  let index = 0;
  // done-guarantee: Track whether we yielded a done(isFinal=true) so the finally block can
  // synthesize one if the loop exits early (e.g. signal.aborted break at top of while).
  let yieldedFinalDone = false;
  // F27: Track how many worklist entries have had a2a_handoff emitted
  let handoffEmitted = targetCats.length; // Original targets don't get handoff events
  const activeTrackedA2ASlots = new Set<CatId>();
  const freshnessBaselineByCat = new Map<CatId, ThreadAppendWatermark>();
  if (deps.freshnessGate) {
    await Promise.all(
      Object.keys(deps.services).map(async (rawCatId) => {
        const catId = rawCatId as CatId;
        const baseline = await deps.messageStore.captureFreshnessWatermark(threadId, { kind: 'cat', catId });
        freshnessBaselineByCat.set(catId, baseline);
      }),
    );
  }
  // F042 Wave 3: Fetch thread participant activity once before loop (threadId doesn't change).
  let activeParticipants: { catId: CatId; lastMessageAt: number; messageCount: number }[] = [];
  if (deps.invocationDeps.threadStore) {
    try {
      activeParticipants = await deps.invocationDeps.threadStore.getParticipantsWithActivity(threadId);
    } catch {
      /* best-effort: activity fetch failure does not block invocation */
    }
  }
  // F042: Fetch thread routingPolicy once before loop (threadId doesn't change).
  let routingPolicy: ThreadRoutingPolicyV1 | undefined;
  // F073 P4: SOP stage hint from workflow-sop (告示牌 — info only, cats decide actions)
  let sopStageHint: { stage: string; suggestedSkill: string | null; featureId: string } | undefined;
  // F092: Voice companion mode
  let voiceMode: boolean | undefined;
  // F087: Bootcamp state for CVO onboarding
  let bootcampState: InvocationContext['bootcampState'];
  const targetCatIds = new Set<string>(targetCats);
  // Thread read: shared across routingPolicy, voiceMode, bootcamp, SOP, and guide interceptor
  let routeThread: Thread | null = null;
  if (deps.invocationDeps.threadStore) {
    try {
      routeThread = (await deps.invocationDeps.threadStore.get(threadId)) ?? null;
      routingPolicy = routeThread?.routingPolicy;
      voiceMode = routeThread?.voiceMode;
      bootcampState = routeThread?.bootcampState;
      // F073 P4: Read workflow-sop if thread is linked to a backlog item
      if (routeThread?.backlogItemId && deps.invocationDeps.workflowSopStore) {
        try {
          const sop = await deps.invocationDeps.workflowSopStore.get(routeThread.backlogItemId);
          if (sop) {
            sopStageHint = {
              stage: sop.stage,
              suggestedSkill: sop.nextSkill,
              featureId: sop.featureId,
            };
          }
        } catch {
          /* best-effort: SOP hint failure does not block invocation */
        }
      }
    } catch {
      /* best-effort */
    }
  }
  const bootcampMemberCount = getThreadBootcampMemberCount(routeThread);
  const historyGovernanceObserveEnabled = isHistoryGovernanceObserveEnabled();
  const historyGovernanceHistory = historyGovernanceObserveEnabled
    ? await readHistoryForGovernanceObservation(deps, threadId, userId, history)
    : undefined;

  // F153: Trace propagation — track per-invocation spans and route-level token totals
  const catInvocationSpans = new Map<number, Span>();
  const mentionParentSpan = new Map<number, Span>();
  const pendingDispatchSpans: { span: Span; lastChildIndex: number }[] = [];
  let routeTotalTokens = 0;

  // F155: Guide interceptor — resume existing guide state only
  const guideCtx = await prepareGuideContext({
    thread: routeThread,
    guideSessionStore: deps.invocationDeps.guideSessionStore,
    targetCats,
    message,
    userId,
    threadId,
    log,
    dismissTracker: deps.invocationDeps.dismissTracker,
  });

  try {
    while (index < worklist.length) {
      if (signal?.aborted) break;
      const catId = worklist[index]!;
      // F148 OQ-2: briefing→invocation link + context eval
      let briefingMessageId: string | undefined;
      let briefingCoverageMap: import('./context-transport.js').CoverageMap | undefined;

      // Only pass images/uploads for the first cat (user's original target)
      const isOriginalTarget = index < targetCats.length;
      const targetContentBlocks = isOriginalTarget ? routeContentBlocksForCat(catId, contentBlocks) : undefined;
      const targetUploadDir = targetContentBlocks ? uploadDir : undefined;

      let prompt = message;
      if (!incrementalMode && previousResponses.length > 0) {
        const contextParts = previousResponses.map((r) => `[${r.catId} responded: ${r.content}]`);
        prompt = `${message}\n\n${contextParts.join('\n')}`;
      }

      // Build identity: static goes in -p content (+ systemPrompt as defense-in-depth), dynamic in -p only
      const catConfig: CatConfig | undefined = catRegistry.tryGet(catId as string)?.config;
      const resolvedToolPolicy = resolveSerialChainToolPolicy(
        resolveEffectiveToolPolicy(catConfig, message),
        worklist.length,
      );
      const loadStandardContext = shouldLoadStandardContext(resolvedToolPolicy.toolPolicy);
      const loadFullContext = shouldLoadFullContext(resolvedToolPolicy.toolPolicy);
      const governanceTier = getGovernanceTierForToolPolicy(resolvedToolPolicy.toolPolicy);
      const governanceSourceContext = buildGovernanceSourceContext(message);
      const governanceEstimatedTokens =
        getGovernanceDigestEstimatedTokens(resolvedToolPolicy.toolPolicy) +
        (governanceSourceContext ? Math.ceil(governanceSourceContext.length / 4) : 0);
      const effectiveContextBudget = getEffectiveRuntimeContextBudget(catId, resolvedToolPolicy.toolPolicy, {
        isDM: routeThread?.isDM,
        title: routeThread?.title,
      });
      const historyObservation = buildHistoryGovernanceObservation({
        enabled: historyGovernanceObserveEnabled,
        historyFullTokens: estimateFullHistoryTokens(historyGovernanceHistory?.messages),
        maxPromptTokens: effectiveContextBudget.maxPromptTokens,
        degraded: historyGovernanceHistory?.degraded,
      });
      const teammates = [...new Set(worklist.filter((id) => id !== catId))];
      const directMessageFrom = worklistEntry.a2aFrom.get(catId);
      // F167 L1: ping-pong warning — inject when this cat just received the ball
      // in a same-pair streak >= 2 (streak=4 already blocked upstream, so max is 3 here).
      const pingPongWarning =
        worklistEntry.streakPair && worklistEntry.streakPair.to === catId && worklistEntry.streakPair.count >= 2
          ? {
              pairedWith: worklistEntry.streakPair.from,
              count: worklistEntry.streakPair.count,
            }
          : undefined;
      const a2aTriggerMessageId = worklistEntry.a2aTriggerMessageId.get(catId);
      const contentFreeInboxEnabled = isContentFreeInboxEnabled(threadId);
      // F004 Phase 2: deliveryOnly is deliberately limited to a truly independent
      // single-target invocation. Once a serial A2A chain exists, every remaining
      // hop keeps the normal bounded history window.
      const deliveryOnlyEnabled = worklist.length === 1 && isDeliveryOnlyEnabled(threadId);
      const streamReplyTo = a2aTriggerMessageId ?? options.replyToMessageId;
      const streamReplyPreview = streamReplyTo
        ? await hydrateReplyPreview(deps.messageStore, streamReplyTo)
        : undefined;
      const a2aTriggerMessage = a2aTriggerMessageId ? await deps.messageStore.getById(a2aTriggerMessageId) : null;
      const a2aTriggerContent =
        a2aTriggerMessage &&
        a2aTriggerMessage.threadId === threadId &&
        !a2aTriggerMessage.deletedAt &&
        isDelivered(a2aTriggerMessage)
          ? a2aTriggerMessage.content
          : undefined;
      let mentionRoutingFeedback = null;
      if (deps.invocationDeps.threadStore) {
        try {
          mentionRoutingFeedback = await deps.invocationDeps.threadStore.consumeMentionRoutingFeedback(threadId, catId);
        } catch (feedbackErr) {
          log.warn({ catId: catId as string, err: feedbackErr }, 'consumeMentionRoutingFeedback failed');
        }
      }
      // MCP write callbacks remain per-message; static identity only carries a short pull-context guide.
      const mcpAvailable =
        (catConfig?.mcpSupport ?? false) && !!mcpServerPath && hasRuntimeNativeMcpBridge(catConfig?.clientId);
      // F129: Load active pack blocks (best-effort, failure does not block invocation)
      let packBlocks: import('@cat-cafe/shared').CompiledPackBlocks | null = null;
      if (loadStandardContext && deps.packStore) {
        const { getActivePackBlocks } = await import('../../../../packs/getActivePackBlocks.js');
        packBlocks = await getActivePackBlocks(deps.packStore);
      }
      // 记忆按项目分区：外部项目 thread 注入「该项目分片 + 全局」，避免多项目并行串味
      const memoryProjectPath =
        routeThread?.projectPath &&
        routeThread.projectPath !== 'default' &&
        !routeThread.projectPath.startsWith('games/')
          ? routeThread.projectPath
          : undefined;
      const agentMemoryContext = await readAgentMemoryForPrompt(catId as string, memoryProjectPath);
      const lessonsContext = loadStandardContext ? await readLessonsForPrompt() : null;
      const contextLayerPlan = resolveContextLayerPlan({
        message,
        toolPolicy: resolvedToolPolicy.toolPolicy,
        loadStandardContext,
      });
      const projectContext = contextLayerPlan.l2ProjectContext ? await readProjectProgressForPrompt() : null;
      const staticIdentity = buildStaticIdentity(catId, {
        mcpAvailable,
        packBlocks,
        toolPolicy: resolvedToolPolicy.toolPolicy,
        agentMemoryContext,
        lessonsContext,
        projectContext,
        maxPromptTokens: effectiveContextBudget.maxPromptTokens,
      });
      // F041: inject HTTP callback only when MCP is NOT actually available (fallback)
      const mcpInstructions = needsMcpInjection(mcpAvailable, catConfig?.clientId)
        ? buildMcpCallbackInstructions({
            currentCatId: catId as string,
            teammates: teammates.map((id) => id as string),
          })
        : '';
      // F091: Inject linked signal articles into context
      let activeSignals:
        | readonly {
            id: string;
            title: string;
            source: string;
            tier: number;
            contentSnippet: string;
            note?: string | undefined;
            relatedDiscussions?: readonly { sessionId: string; snippet: string; score: number }[] | undefined;
          }[]
        | undefined;
      if (loadFullContext && deps.invocationDeps.signalArticleLookup) {
        try {
          const signals = await deps.invocationDeps.signalArticleLookup(threadId);
          if (signals.length > 0) activeSignals = signals;
        } catch {
          /* best-effort: signal lookup failure does not block invocation */
        }
      }

      // F093: Resolve world context for thread (fail-open)
      let worldContext: import('@cat-cafe/shared').WorldContextEnvelope | undefined;
      if (loadStandardContext && deps.worldStore && deps.worldContextProvider) {
        try {
          const activeWorld = await deps.worldStore.getWorldForThread(threadId);
          if (activeWorld) {
            const scenes = await deps.worldStore.getScenesByWorld(activeWorld.worldId);
            const activeScene = scenes.find((s) => s.status === 'active');
            if (activeScene) {
              const envelope = await deps.worldContextProvider.assemble(activeWorld.worldId, activeScene.sceneId);
              if (envelope) worldContext = envelope;
            }
          }
        } catch {
          /* fail-open: world context lookup failure does not block invocation */
        }
      }

      const invocationMode = worklist.length > 1 ? 'serial' : 'independent';
      const a2aEnabled = worklistEntry.a2aCount < maxDepth;
      const skillRouterContext = resolveSkillRouterContext(message);
      const invocationContextInput: InvocationContext = {
        catId,
        mode: invocationMode,
        chainIndex: index + 1,
        chainTotal: worklist.length,
        teammates,
        mcpAvailable,
        toolPolicy: resolvedToolPolicy.toolPolicy,
        ...(governanceSourceContext ? { governanceSourceContext } : {}),
        ...(promptTags && promptTags.length > 0 ? { promptTags } : {}),
        ...(skillRouterContext ? { skillRouterBlock: skillRouterContext.promptBlock } : {}),
        ...(skillRouterContext?.matchedSkillNames.length
          ? { skillRouterMatchedSkills: skillRouterContext.matchedSkillNames }
          : {}),
        a2aEnabled,
        ...(currentUserMessageId ? { currentUserMessageId } : {}),
        ...(directMessageFrom ? { directMessageFrom } : {}),
        ...(directMessageFrom && a2aTriggerMessageId ? { a2aTriggerMessageId } : {}),
        ...(directMessageFrom &&
        a2aTriggerMessageId &&
        streamReplyPreview?.content &&
        !contentFreeInboxEnabled &&
        !deliveryOnlyEnabled
          ? { a2aTriggerContent: streamReplyPreview.content }
          : {}),
        ...(pingPongWarning ? { pingPongWarning } : {}),
        ...(mentionRoutingFeedback ? { mentionRoutingFeedback } : {}),
        ...(activeParticipants.length > 0 ? { activeParticipants } : {}),
        ...(routingPolicy ? { routingPolicy } : {}),
        ...(loadFullContext && sopStageHint ? { sopStageHint } : {}),
        ...(activeSignals ? { activeSignals } : {}),
        ...(voiceMode ? { voiceMode } : {}),
        ...(bootcampState ? { bootcampState, bootcampMemberCount } : {}),
        ...guideContextForCat(guideCtx, catId, targetCatIds, threadId),
        ...(worldContext ? { worldContext } : {}),
        threadId,
      };
      let invocationContext = buildInvocationContext(invocationContextInput);
      const continuityCapsule = buildCapsuleFromRouteState({
        threadId,
        catId: catId as string,
        ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
        mode: invocationMode,
        chainIndex: index + 1,
        chainTotal: worklist.length,
        ...(directMessageFrom ? { directMessageFrom: directMessageFrom as string } : {}),
        ...(streamReplyTo ? { a2aTriggerMessageId: streamReplyTo } : {}),
        a2aEnabled,
        a2aDepth: worklistEntry.a2aCount,
        maxA2ADepth: maxDepth,
      });

      // F24 Phase E: Bootstrap context for Session #2+
      let bootstrapContext = '';
      if (
        loadStandardContext &&
        isSessionChainEnabled(catId) &&
        deps.invocationDeps.sessionChainStore &&
        deps.invocationDeps.transcriptReader
      ) {
        try {
          const bootstrapDepth = getConfigSessionStrategy(catId)?.handoff?.bootstrapDepth;
          const bootstrap = await buildSessionBootstrap(
            {
              sessionChainStore: deps.invocationDeps.sessionChainStore,
              transcriptReader: deps.invocationDeps.transcriptReader,
              ...(deps.invocationDeps.taskStore ? { taskStore: deps.invocationDeps.taskStore } : {}),
              ...(deps.invocationDeps.threadStore ? { threadStore: deps.invocationDeps.threadStore } : {}),
              ...(bootstrapDepth ? { bootstrapDepth } : {}),
            },
            catId,
            threadId,
            userId,
          );
          if (bootstrap) {
            bootstrapContext = bootstrap.text;
          }
        } catch {
          // Best-effort: bootstrap failure doesn't block invocation
        }
      }

      let deliveryBoundaryId: string | undefined;
      let includedHistoryCount = 0;
      let historySummary: HistorySummaryObservation | undefined;
      let runtimeHistoryObservation = historyObservation;
      let runtimeHistoryGovernanceDegraded: boolean | undefined;
      let deliveryOnlyObservation: import('./route-helpers.js').DeliveryOnlyContextObservation | undefined;
      if (incrementalMode) {
        // Serial incremental mode depends on AgentRouter having appended current user message first.
        // We still explicitly include `message` when that message is not present in unseen rows.

        // A+ fix: calculate effective context budget by deducting ALL system parts from maxPromptTokens.
        // Without this, context (up to maxContextTokens=160k) + system parts (~15-20k) can exceed maxPromptTokens.
        const catModePromptForBudget = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const incSystemTokens = estimateTokens(
          [staticIdentity, invocationContext, catModePromptForBudget, bootstrapContext, mcpInstructions]
            .filter(Boolean)
            .join('\n'),
        );
        const explicitMessageForBudget =
          (contentFreeInboxEnabled || deliveryOnlyEnabled) && directMessageFrom && a2aTriggerMessageId
            ? formatA2ATriggerPrompt(deliveryOnlyEnabled ? message : a2aTriggerContent, a2aTriggerMessageId)
            : message;
        const incMessageTokens = estimateTokens(explicitMessageForBudget);
        const effectiveMaxContextTokens = Math.min(
          Math.max(0, effectiveContextBudget.maxPromptTokens - incSystemTokens - incMessageTokens - 200),
          effectiveContextBudget.maxContextTokens,
        );

        const inc = await assembleIncrementalContext(
          deps,
          userId,
          threadId,
          catId,
          currentUserMessageId,
          thinkingMode,
          {
            effectiveMaxContextTokens,
            contextBudget: effectiveContextBudget,
            canonicalFeatureId: loadFullContext ? sopStageHint?.featureId : undefined,
            threadTitle: routeThread?.title ?? undefined,
            contentFreeInboxEnabled,
            deliveryOnlyEnabled,
            ...(deliveryOnlyEnabled ? { deliveryOnlyTriggerContent: message } : {}),
            ...(a2aTriggerMessageId ? { a2aTriggerMessageId } : {}),
            ...(historyObservation ? { historyObservation } : {}),
          },
        );
        deliveryBoundaryId = inc.boundaryId;
        includedHistoryCount =
          inc.historySummary?.mode === 'summary-active'
            ? (inc.includedHistoryCount ?? 0)
            : inc.contextText
              ? (history?.length ?? 0)
              : 0;
        historySummary = inc.historySummary;
        deliveryOnlyObservation = inc.deliveryOnly;
        runtimeHistoryGovernanceDegraded = Boolean(
          historyObservation?.historyGovernanceDegraded || inc.historyGovernanceDegraded,
        );
        if (inc.historyGovernanceDegraded && historyObservation) {
          runtimeHistoryObservation = { ...historyObservation, historyGovernanceDegraded: true };
        }
        if (inc.degradation) {
          yield {
            type: 'system_info' as AgentMessageType,
            catId,
            content: inc.degradation,
            timestamp: Date.now(),
          } as AgentMessage;
        }

        // F148 Phase E: Auto-insert context briefing when smart window triggered (AC-E1)
        if (inc.coverageMap) {
          const briefingInput = buildBriefingMessage(inc.coverageMap, threadId, inc.briefingContext);
          try {
            const stored = await deps.messageStore.append(briefingInput);
            briefingMessageId = stored.id;
            briefingCoverageMap = inc.coverageMap;
            // P1-3: Include full stored message in payload so frontend can addMessage directly
            yield {
              type: 'system_info' as AgentMessageType,
              catId,
              content: JSON.stringify({
                type: 'context_briefing',
                messageId: stored.id,
                storedMessage: {
                  id: stored.id,
                  content: stored.content,
                  origin: stored.origin,
                  timestamp: stored.timestamp,
                  extra: stored.extra,
                },
              }),
              timestamp: stored.timestamp,
            } as AgentMessage;
          } catch {
            // fail-open: briefing is non-critical UI enhancement
          }
        }

        const catModePrompt = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const contextUsageWarning = buildContextUsageWarning({
          estimatedTokens: estimateTokens(
            [
              staticIdentity,
              invocationContext,
              catModePrompt,
              bootstrapContext,
              mcpInstructions,
              inc.contextText,
              explicitMessageForBudget,
            ]
              .filter(Boolean)
              .join('\n\n'),
          ),
          maxPromptTokens: effectiveContextBudget.maxPromptTokens,
        });
        if (contextUsageWarning) {
          invocationContext = buildInvocationContext({ ...invocationContextInput, contextUsageWarning });
        }

        const parts = [invocationContext, catModePrompt, bootstrapContext, mcpInstructions].filter(Boolean);
        if (inc.contextText) parts.push(inc.contextText);
        // F35 fix: only inject raw message when it was genuinely absent from unseen rows.
        // Defensive guard: if the current message ID is already present anywhere in
        // the assembled context text, do not append the raw message again.
        const explicitMessage = selectExplicitPromptMessage(inc, currentUserMessageId, message, {
          ...(directMessageFrom ? { directMessageFrom } : {}),
          ...(a2aTriggerMessageId ? { triggerMessageId: a2aTriggerMessageId } : {}),
          ...(a2aTriggerContent ? { triggerContent: a2aTriggerContent } : {}),
        });
        if (explicitMessage) parts.push(explicitMessage);
        prompt = parts.join('\n\n---\n\n');
      } else {
        // Per-cat context budget (Phase 4.0): assemble context with cat-specific limits
        let catContextHistory = loadStandardContext ? contextHistory : undefined; // fallback to legacy pre-assembled
        if (loadStandardContext && history && history.length > 0 && !contextHistory) {
          // F8: token-based budget — estimate non-context tokens, remainder goes to context
          // A+ fix: include catModePrompt + bootstrapContext in system parts estimate (P2-1)
          const catModePromptLegacyForBudget = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
          const systemPartsTokens = estimateTokens(
            [staticIdentity, invocationContext, catModePromptLegacyForBudget, bootstrapContext, mcpInstructions]
              .filter(Boolean)
              .join('\n'),
          );
          const promptTokens = estimateTokens(prompt);
          const budgetForContext = Math.max(
            0,
            effectiveContextBudget.maxPromptTokens - systemPartsTokens - promptTokens - 200,
          );
          const { contextText, messageCount } = assembleContext(history, {
            maxMessages: effectiveContextBudget.maxMessages,
            maxContentLength: effectiveContextBudget.maxContentLengthPerMsg,
            maxTotalTokens: Math.min(budgetForContext, effectiveContextBudget.maxContextTokens),
          });
          catContextHistory = contextText || undefined;
          includedHistoryCount = messageCount;

          // Degradation check: notify user if context was truncated (count budget or char budget)
          const degradation = detectContextDegradation(history.length, messageCount, effectiveContextBudget);
          if (degradation?.degraded) {
            yield {
              type: 'system_info' as AgentMessageType,
              catId,
              content: formatDegradationMessage(degradation),
              timestamp: Date.now(),
            } as AgentMessage;
          }
        } else if (catContextHistory) {
          includedHistoryCount = history?.length ?? 0;
        }

        const catModePromptLegacy = modeSystemPromptByCat?.[catId as string] ?? modeSystemPrompt;
        const contextUsageWarning = buildContextUsageWarning({
          estimatedTokens: estimateTokens(
            [
              staticIdentity,
              invocationContext,
              catModePromptLegacy,
              bootstrapContext,
              mcpInstructions,
              catContextHistory,
              prompt,
            ]
              .filter(Boolean)
              .join('\n\n'),
          ),
          maxPromptTokens: effectiveContextBudget.maxPromptTokens,
        });
        if (contextUsageWarning) {
          invocationContext = buildInvocationContext({ ...invocationContextInput, contextUsageWarning });
        }

        if (invocationContext || catModePromptLegacy || mcpInstructions || bootstrapContext) {
          const parts = [invocationContext, catModePromptLegacy, bootstrapContext, mcpInstructions].filter(Boolean);
          if (catContextHistory) parts.push(catContextHistory);
          prompt = `${parts.join('\n\n---\n\n')}\n\n---\n\n${prompt}`;
        } else if (catContextHistory) {
          prompt = `${catContextHistory}\n\n---\n\n${prompt}`;
        }
      }
      const runtimeContextBudget = buildRuntimeContextBudgetSnapshot({
        threadId,
        toolPolicy: resolvedToolPolicy.toolPolicy,
        toolPolicySource: resolvedToolPolicy.source,
        mode: 'serial',
        prompt,
        staticIdentity,
        historyCount: history?.length ?? 0,
        includedHistoryCount,
        loadStandardContext,
        loadFullContext,
        hasPackBlocks: Boolean(packBlocks),
        hasWorldContext: Boolean(worldContext),
        hasSessionBootstrap: Boolean(bootstrapContext),
        hasSignalArticles: Boolean(activeSignals?.length),
        hasAlwaysOnDocs: false,
        hasSopHint: Boolean(loadFullContext && sopStageHint),
        hasGuideContext: Boolean(loadFullContext && guideCtx),
        hasMcpInstructions: Boolean(mcpInstructions),
        hasAgentMemory: Boolean(agentMemoryContext),
        hasLessonsContext: Boolean(lessonsContext && staticIdentity.includes('公共踩坑记录（LESSONS.md，低优先级）')),
        hasProjectContext: Boolean(projectContext && staticIdentity.includes('项目进度（只读参考）')),
        projectContextDeferred: contextLayerPlan.projectContextDeferred,
        ...(skillRouterContext ? { skillRouterMatchedSkills: skillRouterContext.matchedSkillNames } : {}),
        governanceTier,
        governanceEstimatedTokens,
        hasGovernanceSourceContext: Boolean(governanceSourceContext),
        catBudget: effectiveContextBudget,
        ...(runtimeHistoryObservation ? { historyObservation: runtimeHistoryObservation } : {}),
        ...(historySummary ? { historySummary } : {}),
        ...(runtimeHistoryGovernanceDegraded !== undefined
          ? { historyGovernanceDegraded: runtimeHistoryGovernanceDegraded }
          : {}),
        ...(deliveryOnlyObservation ? { deliveryOnly: deliveryOnlyObservation } : {}),
      });
      const historyCriticalSealIntent = buildHistoryCriticalSealIntent({
        ...(runtimeHistoryObservation ? { historyObservation: runtimeHistoryObservation } : {}),
        ...(historySummary ? { historySummary } : {}),
        ...(runtimeHistoryGovernanceDegraded !== undefined
          ? { historyGovernanceDegraded: runtimeHistoryGovernanceDegraded }
          : {}),
        toolPolicy: resolvedToolPolicy.toolPolicy,
      });

      let textContent = '';
      const thinkingChunks: string[] = [];
      let firstMetadata: MessageMetadata | undefined;
      let doneMsg: AgentMessage | undefined;
      let hadError = false;
      /** F155: tracks whether cat produced user-visible output (for guide completion ack). */
      let catProducedOutput = false;
      let sawUserFacingSystemInfo = false;
      // #267: track errors that happened BEFORE abort — only these are real provider failures
      let hadProviderError = false;
      // Collect error text separately for system-message persistence (F5 reload)
      let collectedErrorText = '';
      let collectedErrorMetadata: MessageMetadata | undefined;
      let collectedErrorCode: string | undefined;
      const collectedToolEvents: StoredToolEvent[] = [];
      // F148 OQ-2: Collect tool names for context eval signals
      const collectedToolNames: string[] = [];
      // #573: Track confirmed cat_cafe_post_message callback persistence
      let callbackDisposition: CallbackDisposition = 'none';
      let callbackPostMessageId: string | undefined;
      let callbackHoldId: string | undefined;
      let callbackReplayed = false;
      let awaitingCallbackResult = false;
      const pendingToolResults: string[] = [];
      const pendingCallbackExposureEvents: AgentMessage[] = [];
      // Full ordinary tool payloads are private until the final publication verdict.
      const pendingFreshnessToolExposureEvents: AgentMessage[] = [];
      // Hints and routing feedback derived from the draft are private too. In
      // protected routes they may become user-visible only after publication.
      const pendingPublishedRoutingEffects: Array<() => Promise<void>> = [];
      const runOrDeferPublishedRoutingEffect = async (effect: () => Promise<void>): Promise<void> => {
        if (deps.freshnessGate) {
          pendingPublishedRoutingEffects.push(effect);
          return;
        }
        await effect();
      };
      const structuredTargetCats = new Set<string>();
      // F060: Collect rich blocks emitted inline via system_info (not MCP buffer)
      const streamRichBlocks: import('@cat-cafe/shared').RichBlock[] = [];
      const compactBoundarySignals: Array<{ timestamp?: number; preTokens?: number }> = [];
      // F22 R2 P1-1: Capture own invocationId from stream (not getLatestId)
      let ownInvocationId: string | undefined;
      // F111 Phase B: Streaming TTS chunker for real-time voice (voiceMode only)
      let voiceChunker: StreamingTtsChunker | undefined;

      // #80: Draft flush state — periodic persistence for F5 recovery
      let lastFlushTime = Date.now();
      let lastFlushLen = 0;
      let lastFlushToolLen = 0;
      const FLUSH_INTERVAL_MS = 2000;
      const FLUSH_CHAR_DELTA = 2000;
      const noop = () => {};

      // Issue #83: Independent keepalive timer — touch draft every 60s during long tool calls.
      // Stream events alone can't keep draft alive when tools execute silently for >300s.
      const KEEPALIVE_INTERVAL_MS = 60_000;
      let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

      // Always pass isLastCat:false — we set isFinal AFTER A2A detection
      log.debug(
        { catId: catId as string, threadId, promptLength: prompt.length, index, worklistSize: worklist.length },
        'Invoking cat via invokeSingleCat',
      );
      const leakedPayloadStripper = createLeakedToolCallStreamStripper();
      const invocationStartedAt = Date.now();
      const invocationSpanRef: { current?: Span } = {};
      try {
        for await (const msg of invokeSingleCat(deps.invocationDeps, {
          catId,
          service: getService(deps.services, catId),
          prompt,
          userId,
          threadId,
          ...(freshnessBaselineByCat.get(catId) ? { freshnessBaseline: freshnessBaselineByCat.get(catId)! } : {}),
          ...(currentUserMessageId ? { currentUserMessageId } : {}),
          ...(targetContentBlocks ? { contentBlocks: targetContentBlocks } : {}),
          ...(targetUploadDir ? { uploadDir: targetUploadDir } : {}),
          ...(signal ? { signal } : {}),
          ...(staticIdentity ? { systemPrompt: staticIdentity } : {}),
          ...(options.parentInvocationId ? { parentInvocationId: options.parentInvocationId } : {}),
          continuityCapsule,
          // F121: Pass A2A trigger message ID for auto-replyTo threading
          ...(a2aTriggerMessageId ? { a2aTriggerMessageId } : {}),
          ...((mentionParentSpan.get(index) ?? options.routeSpan)
            ? { routeSpan: mentionParentSpan.get(index) ?? options.routeSpan }
            : {}),
          invocationSpanRef,
          isLastCat: false,
          toolPolicy: resolvedToolPolicy.toolPolicy,
          toolPolicySource: resolvedToolPolicy.source,
          contextBudget: runtimeContextBudget,
          ...(historyCriticalSealIntent ? { deferMemoryWriteback: true } : {}),
        })) {
          // F39 bugfix: stop yielding after cancel (pipe buffer may still drain)
          if (signal?.aborted) break;

          const effectiveMsgs: AgentMessage[] = [];
          if (msg.type === 'text' && msg.content) {
            effectiveMsgs.push({ ...msg, content: leakedPayloadStripper.push(msg.content) });
          } else if (msg.type === 'done') {
            const flushedText = leakedPayloadStripper.flush();
            if (flushedText) {
              effectiveMsgs.push({
                type: 'text',
                catId,
                content: flushedText,
                timestamp: msg.timestamp,
              });
            }
            effectiveMsgs.push(msg);
          } else {
            effectiveMsgs.push(msg);
          }

          for (const effectiveMsg of effectiveMsgs) {
            let suppressCallbackExposureEvent = false;
            let releaseCallbackExposureEvents: AgentMessage[] | undefined;
            // F22 R2 P1-1: Capture invocationId from the initial system_info.
            // Keep forwarding this boundary event so frontend can reset stale task progress.
            if (effectiveMsg.type === 'system_info' && effectiveMsg.content && !ownInvocationId) {
              try {
                const parsed = JSON.parse(effectiveMsg.content);
                if (parsed.type === 'invocation_created') {
                  ownInvocationId = parsed.invocationId;
                  // F111 Phase B: Start streaming TTS when we have an invocationId
                  if (voiceMode && deps.socketManager && !deps.freshnessGate) {
                    const ttsRegistry = getStreamingTtsRegistry();
                    if (ttsRegistry) {
                      voiceChunker = new StreamingTtsChunker({
                        catId: catId as string,
                        invocationId: ownInvocationId!,
                        threadId,
                        voiceConfig: getCatVoice(catId as string),
                        broadcaster: deps.socketManager,
                        ttsRegistry,
                        signal,
                      });
                    }
                  }
                  // Issue #83: Start keepalive timer once we have an invocationId.
                  // This ensures draft TTL is renewed even during long silent tool calls.
                  if (deps.draftStore && !keepaliveTimer) {
                    const keepInvId = ownInvocationId!;
                    keepaliveTimer = setInterval(() => {
                      deps.draftStore!.touch(userId, threadId, keepInvId)?.catch?.(noop);
                    }, KEEPALIVE_INTERVAL_MS);
                  }
                }
              } catch {
                /* ignore parse errors */
              }
            }

            if (effectiveMsg.type === 'text' && effectiveMsg.content) {
              textContent = accumulateTextAggregate(
                textContent,
                effectiveMsg.content,
                (effectiveMsg as { textMode?: 'append' | 'replace' }).textMode,
              );
              voiceChunker?.feed(effectiveMsg.content);
            }
            // F045: Accumulate thinking blocks for persistence (F5 recovery)
            if (effectiveMsg.type === 'system_info' && effectiveMsg.content) {
              if (isUserFacingSystemInfoContent(effectiveMsg.content)) {
                sawUserFacingSystemInfo = true;
              }
              try {
                const parsed = JSON.parse(effectiveMsg.content);
                if (parsed.type === 'thinking' && typeof parsed.text === 'string') {
                  thinkingChunks.splice(0, thinkingChunks.length, ...appendThinkingChunk(thinkingChunks, parsed.text));
                }
                // F060: Collect inline rich_block for persistence (P1 fix)
                if (parsed.type === 'rich_block' && parsed.block && isValidRichBlock(parsed.block)) {
                  streamRichBlocks.push(parsed.block);
                }
                // F153: Accumulate invocation tokens for route aggregate
                if (parsed.type === 'invocation_usage' && parsed.usage) {
                  routeTotalTokens += (parsed.usage.inputTokens ?? 0) + (parsed.usage.outputTokens ?? 0);
                }
              } catch {
                /* ignore parse errors */
              }
              const compactBoundary = parseCompactBoundarySystemInfo(effectiveMsg.content);
              if (compactBoundary) {
                compactBoundarySignals.push({
                  timestamp: effectiveMsg.timestamp,
                  ...(compactBoundary.preTokens !== undefined ? { preTokens: compactBoundary.preTokens } : {}),
                });
              }
            }
            // Accumulate tool events for persistence (before draft flush so current event is available)
            const toolEvt = toStoredToolEvent(effectiveMsg);
            if (toolEvt) {
              collectedToolEvents.push(toolEvt);
            }

            if (effectiveMsg.type === 'tool_use') {
              for (const target of collectStructuredTargetCatsFromInput(effectiveMsg.toolInput)) {
                structuredTargetCats.add(target);
              }
            }

            // F148 OQ-2: Collect tool names for context eval
            if (effectiveMsg.type === 'tool_use' && effectiveMsg.toolName) {
              collectedToolNames.push(effectiveMsg.toolName);
              pendingToolResults.push(effectiveMsg.toolName);
              if (isCallbackDeliveryToolName(effectiveMsg.toolName)) {
                awaitingCallbackResult = true;
                pendingCallbackExposureEvents.push(effectiveMsg);
                suppressCallbackExposureEvent = true;
              }
            }
            // #573: Confirm callback persistence via tool_result success
            if (effectiveMsg.type === 'tool_result') {
              const callbackResult = parseCallbackPostResult(effectiveMsg.content);
              const completedToolName = consumePendingToolResult(
                pendingToolResults,
                effectiveMsg,
                callbackResult.confirmed,
                Boolean(
                  (callbackResult.messageId && callbackResult.threadId) ||
                    (callbackResult.holdId && callbackResult.threadId),
                ),
              );
              if (completedToolName && isCallbackDeliveryToolName(completedToolName)) {
                pendingCallbackExposureEvents.push(effectiveMsg);
                suppressCallbackExposureEvent = true;
                if (callbackResult.confirmed) {
                  if (callbackResult.disposition === 'published' && !callbackResult.replayed) {
                    releaseCallbackExposureEvents = pendingCallbackExposureEvents.splice(0);
                  } else {
                    pendingCallbackExposureEvents.length = 0;
                    // A held/discarded callback closes the prior publication
                    // epoch. None of its tool detail may attach to a later
                    // replacement or stdout publication.
                    pendingFreshnessToolExposureEvents.length = 0;
                    collectedToolEvents.length = 0;
                  }
                }
              }
              if (
                awaitingCallbackResult &&
                completedToolName &&
                isCallbackDeliveryToolName(completedToolName) &&
                callbackResult.confirmed
              ) {
                callbackDisposition = callbackResult.disposition;
                callbackReplayed = callbackResult.replayed === true;
                awaitingCallbackResult = false;
                if (callbackResult.messageId) callbackPostMessageId = callbackResult.messageId;
                if (callbackResult.holdId) callbackHoldId = callbackResult.holdId;
              }
            }

            // F150: Fire-and-forget tool usage counter
            if (effectiveMsg.type === 'tool_use' && deps.toolUsageCounter && effectiveMsg.catId) {
              deps.toolUsageCounter.recordToolUse(
                effectiveMsg.catId as string,
                effectiveMsg.toolName ?? 'unknown',
                effectiveMsg.toolInput as Record<string, unknown> | undefined,
              );
            }

            // #80: Draft flush — fire-and-forget periodic persistence for F5 recovery
            if (deps.draftStore && ownInvocationId) {
              const now = Date.now();
              const charDelta = textContent.length - lastFlushLen;
              const isReplaceText = (effectiveMsg as { textMode?: 'append' | 'replace' }).textMode === 'replace';
              const neverFlushed = lastFlushLen === 0 && lastFlushToolLen === 0;
              if (
                effectiveMsg.type === 'text' &&
                charDelta !== 0 &&
                (neverFlushed ||
                  isReplaceText ||
                  now - lastFlushTime >= FLUSH_INTERVAL_MS ||
                  charDelta >= FLUSH_CHAR_DELTA)
              ) {
                deps.draftStore
                  .upsert({
                    userId,
                    threadId,
                    invocationId: ownInvocationId,
                    catId,
                    content: textContent,
                    ...(deps.freshnessGate ? { exposure: 'private' as const } : {}),
                    ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
                    ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
                    updatedAt: now,
                  })
                  ?.catch?.(noop);
                lastFlushTime = now;
                lastFlushLen = textContent.length;
                lastFlushToolLen = collectedToolEvents.length;
              } else if (
                (effectiveMsg.type === 'tool_use' || effectiveMsg.type === 'tool_result') &&
                // Cloud R7 P1: bypass interval for the very first flush — tool-first invocations
                // must create a draft immediately, not wait 2s for the interval gate.
                (neverFlushed || now - lastFlushTime >= FLUSH_INTERVAL_MS)
              ) {
                // Heartbeat for non-text events: keep draft alive during long tool calls.
                // Cloud R6 P1: upsert when there's unsaved text OR new tool events —
                // tool-first invocations (no text yet) must still create a draft record.
                if (textContent.length > lastFlushLen || collectedToolEvents.length > lastFlushToolLen) {
                  deps.draftStore
                    .upsert({
                      userId,
                      threadId,
                      invocationId: ownInvocationId,
                      catId,
                      content: textContent,
                      ...(deps.freshnessGate ? { exposure: 'private' as const } : {}),
                      ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
                      ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
                      updatedAt: now,
                    })
                    ?.catch?.(noop);
                  lastFlushLen = textContent.length;
                  lastFlushToolLen = collectedToolEvents.length;
                } else {
                  deps.draftStore.touch(userId, threadId, ownInvocationId)?.catch?.(noop);
                }
                lastFlushTime = now;
              }
            }

            if (effectiveMsg.type === 'error') {
              hadError = true;
              // #267: errors before abort are real provider failures; errors after abort are cleanup
              if (!signal?.aborted) hadProviderError = true;
              if (effectiveMsg.error) {
                collectedErrorText += `${collectedErrorText ? '\n' : ''}${effectiveMsg.error}`;
              }
              if (effectiveMsg.metadata) collectedErrorMetadata = effectiveMsg.metadata;
              if (effectiveMsg.errorCode) collectedErrorCode = effectiveMsg.errorCode;
            }
            if (effectiveMsg.type === 'text' && effectiveMsg.content?.trim() && hadProviderError) {
              // A later same-cat answer proves the preceding provider/tool error was recoverable.
              hadError = false;
              hadProviderError = false;
              collectedErrorText = '';
              collectedErrorMetadata = undefined;
              collectedErrorCode = undefined;
            }
            if (effectiveMsg.metadata && !firstMetadata) {
              firstMetadata = effectiveMsg.metadata;
            }
            if (effectiveMsg.type === 'done') {
              doneMsg = effectiveMsg; // Buffer — yield after A2A detection
            } else {
              if (releaseCallbackExposureEvents) {
                const releasable = [
                  ...pendingFreshnessToolExposureEvents.splice(0),
                  ...releaseCallbackExposureEvents,
                ].sort((left, right) => left.timestamp - right.timestamp);
                for (const event of releasable) yield event;
              }
              if (suppressCallbackExposureEvent) continue;
              if (effectiveMsg.type === 'text' && !effectiveMsg.content) {
                continue;
              }
              if (deps.freshnessGate && (effectiveMsg.type === 'tool_use' || effectiveMsg.type === 'tool_result')) {
                pendingFreshnessToolExposureEvents.push(effectiveMsg);
                continue;
              }
              if (deps.freshnessGate && effectiveMsg.type === 'text') {
                continue;
              }
              if (deps.freshnessGate && effectiveMsg.type === 'system_info' && effectiveMsg.content) {
                try {
                  if (JSON.parse(effectiveMsg.content).type === 'rich_block') continue;
                } catch {
                  /* non-JSON system_info remains realtime */
                }
              }
              // Tag CLI stdout text with origin: 'stream' (thinking/internal)
              yield effectiveMsg.type === 'text'
                ? {
                    ...effectiveMsg,
                    origin: 'stream' as const,
                    ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
                    ...(streamReplyPreview ? { replyPreview: streamReplyPreview } : {}),
                  }
                : effectiveMsg;
            }
          }
        }
      } finally {
        // Issue #83: Stop keepalive timer on normal completion, cancel, and thrown provider errors.
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = undefined;
        }
      }

      // F111 Phase B: Flush remaining buffered text and send voice_stream_end
      let voiceTotalChunks = 0;
      if (voiceChunker) {
        try {
          voiceTotalChunks = await voiceChunker.flush();
        } catch (err) {
          log.error({ err }, 'Voice chunker flush failed');
        }
        if (deps.socketManager && voiceChunker.hasStarted()) {
          const aborted = signal?.aborted ?? false;
          deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'voice_stream_end', {
            type: 'voice_stream_end',
            catId: catId as string,
            invocationId: ownInvocationId ?? '',
            threadId,
            totalChunks: aborted ? -1 : voiceTotalChunks,
          });
        }
        voiceChunker = undefined;
      }

      let a2aMentions: CatId[] = [];
      let freshnessEgressDisposition: 'published' | 'held' | 'discarded' | undefined;
      let freshnessEgressHoldId: string | undefined;
      let freshnessHoldStatus: 'held' | 'needs_attention' | undefined;
      let freshnessEgressReplayed = false;
      let releaseBufferedText = false;

      const finalizePublishedHistoryCriticalSeal = async function* (
        publishedMessageId: string | undefined,
        fallbackAssistantText = '',
        requirePersistedContent = false,
      ): AsyncGenerator<AgentMessage> {
        if (!historyCriticalSealIntent || !publishedMessageId || freshnessEgressReplayed) return;
        if (freshnessEgressDisposition === 'held' || freshnessEgressDisposition === 'discarded') return;
        let assistantText = fallbackAssistantText;
        try {
          const publishedMessage = await deps.messageStore.getById(publishedMessageId);
          if (requirePersistedContent && !publishedMessage) {
            log.error(
              { threadId, catId: catId as string, invocationId: ownInvocationId, publishedMessageId },
              'history-critical callback message reload returned no canonical content; deferring seal',
            );
            return;
          }
          assistantText = publishedMessage?.content ?? fallbackAssistantText;
        } catch (err) {
          if (requirePersistedContent) {
            log.error(
              { threadId, catId: catId as string, invocationId: ownInvocationId, publishedMessageId, err },
              'history-critical callback message reload failed; deferring seal',
            );
            return;
          }
          log.warn(
            { threadId, catId: catId as string, invocationId: ownInvocationId, publishedMessageId, err },
            'history-critical published message reload failed; using route output fallback',
          );
        }
        try {
          const sealInfo = await finalizeHistoryCriticalPublication({
            deps: deps.invocationDeps,
            intent: historyCriticalSealIntent,
            userId,
            catId,
            threadId,
            ...(ownInvocationId ? { invocationId: ownInvocationId } : {}),
            ...(currentUserMessageId ? { currentUserMessageId } : {}),
            assistantText,
            ...(routeThread?.projectPath ? { projectPath: routeThread.projectPath } : {}),
            continuityCapsule,
          });
          if (sealInfo) yield sealInfo;
        } catch (err) {
          log.error(
            { threadId, catId: catId as string, invocationId: ownInvocationId, err },
            'history-critical post-publication seal failed',
          );
        }
      };

      // F22: Consume MCP-buffered rich blocks BEFORE the text/empty branch —
      // blocks must be persisted even when the cat emits no text (cloud Codex P1).
      const bufferedBlocks = getRichBlockBuffer().consume(threadId, catId as string, ownInvocationId);

      // F061: Detect @co-creator mentions in agent response for browser notification
      let mentionsUser = false;

      if (textContent) {
        catProducedOutput = true;
        const sanitized = sanitizeInjectedContent(textContent);

        // F22: Extract cc_rich blocks from text (Route B fallback for non-MCP cats)
        const { cleanText, blocks: textBlocks } = extractRichFromText(sanitized);
        const storedContent = sanitizeAgentVisibleOutput(cleanText);
        let allRichBlocks = [...bufferedBlocks, ...textBlocks, ...streamRichBlocks];

        // F34-b: Resolve voice blocks (audio with text, no url) — Route B path.
        // Route A blocks were already resolved in the callback handler.
        // F111: When voiceMode is active, skip full synthesis so audio blocks
        // arrive at the frontend with text but no url — the frontend will use
        // /api/tts/stream for chunked streaming playback (<2s first-audio).
        if (!voiceMode && !deps.freshnessGate) {
          const voiceSynth = getVoiceBlockSynthesizer();
          if (voiceSynth && allRichBlocks.some((b) => b.kind === 'audio' && 'text' in b)) {
            try {
              allRichBlocks = await voiceSynth.resolveVoiceBlocks(allRichBlocks, catId as string);
            } catch (err) {
              log.error({ catId: catId as string, err }, 'Voice block synthesis failed');
            }
          }
        }

        // A2A mention detection (缅因猫 P1-3: only after full text accumulated)
        // Line-start @mention = always actionable in legacy mode.
        // Slock-style mode keeps syntax diagnostics but does not extend the hidden worklist.
        const detectedA2AMentions = parseA2AMentions(storedContent, catId);
        a2aMentions = enableHiddenTextScanA2A ? detectedA2AMentions : [];

        // clowder-ai#489: baseline counter — line-start mentions
        if (detectedA2AMentions.length > 0) {
          lineStartDetected.add(detectedA2AMentions.length, { 'agent.id': catId as string });
          if (!enableHiddenTextScanA2A) {
            log.info(
              { threadId, catId: catId as string, detectedA2AMentions },
              'A2A final-text scan detected mention but hidden worklist routing is disabled',
            );
          }
        }

        // F167 Phase H AC-H3/H5 (KD-24): final routing slot validator.
        // Mechanical slot check with zero intent classifier. Runs BEFORE #417
        // inline-mention-hint and AC-C7 verdict warn; hit suppresses the system_info
        // emit on both (but keeps setMentionRoutingFeedback for next-turn correction).
        const phaseHRosterHandles: string[] = [];
        {
          const allCfg = catRegistry.getAllConfigs();
          for (const cfg of Object.values(allCfg) as CatConfig[]) {
            for (const pattern of cfg.mentionPatterns) phaseHRosterHandles.push(pattern);
          }
        }
        const phaseHResult = validateRoutingSyntax({
          text: storedContent,
          lineStartMentions: detectedA2AMentions,
          toolNames: collectedToolNames,
          structuredTargetCats: [...structuredTargetCats],
          rosterHandles: phaseHRosterHandles,
        });
        const phaseHHit = phaseHResult.kind === 'invalid_route_syntax';
        if (phaseHHit && phaseHResult.kind === 'invalid_route_syntax') {
          await runOrDeferPublishedRoutingEffect(async () => {
            try {
              const inlineList = phaseHResult.inlineMentions.map((h) => `@${h}`).join(' ');
              const hintSource = {
                connector: 'routing-syntax-hint',
                label: '路由语法提醒',
                icon: '⚠️',
                meta: { presentation: 'system_notice', noticeTone: 'warning' },
              };
              const stored = await deps.messageStore.append({
                userId: 'system',
                catId: null,
                threadId,
                content: `[路由语法]: ${inlineList} 未能路由 — 请确认句柄拼写正确且该猫可用；只想提及而不路由时，用不带 @ 的纯文本名字。`,
                mentions: [],
                timestamp: Date.now(),
                source: hintSource,
              });
              if (deps.socketManager) {
                deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
                  threadId,
                  message: {
                    id: stored.id,
                    type: 'connector',
                    content: stored.content,
                    source: hintSource,
                    timestamp: stored.timestamp,
                  },
                });
              }
            } catch {
              /* non-blocking hint */
            }
          });
        }

        // #417 / F064 AC-B3: Write-side feedback for explicit inline action-like @mentions.
        if (deps.invocationDeps.threadStore) {
          const inlineHits = detectInlineActionMentions(storedContent, catId, a2aMentions);
          const agentAttr = { 'agent.id': catId as string };
          inlineActionChecked.add(1, agentAttr);
          if (inlineHits.length > 0) inlineActionDetected.add(inlineHits.length, agentAttr);

          if (inlineHits.length > 0) {
            await runOrDeferPublishedRoutingEffect(async () => {
              try {
                await deps.invocationDeps.threadStore?.setMentionRoutingFeedback(threadId, catId, {
                  sourceTimestamp: Date.now(),
                  items: inlineHits.map((m) => ({ targetCatId: m.catId, reason: 'inline_action' as const })),
                });
                inlineActionFeedbackWritten.add(1, agentAttr);
                log.info(
                  { catId: catId as string, threadId, targets: inlineHits.map((h) => h.catId) },
                  'Inline action @mention detected — wrote routing feedback',
                );
              } catch {
                inlineActionFeedbackWriteFailed.add(1, agentAttr);
              }
              // #1062: User-visible system message when chain would break
              // (inline action detected but no line-start @ = no routing will happen)
              // F167 Phase H AC-H5: suppress this legacy hint when Phase H already emitted
              // routing-syntax-hint for the same turn (dedupe, single authoritative message).
              if (a2aMentions.length === 0 && !phaseHHit) {
                try {
                  const targets = inlineHits.map((h) => `@${h.catId}`).join(', ');
                  const hintSource = {
                    connector: 'inline-mention-hint',
                    label: '路由提示',
                    icon: '💡',
                    meta: { presentation: 'system_notice', noticeTone: 'info' },
                  };
                  const stored = await deps.messageStore.append({
                    userId: 'system',
                    catId: null,
                    threadId,
                    content: `想交接给 ${targets}？把它单独放到新起一行开头，才能触发交接。`,
                    mentions: [],
                    timestamp: Date.now(),
                    source: hintSource,
                  });
                  inlineActionHintEmitted.add(1, agentAttr);
                  // Broadcast so frontend sees it in real-time (same pattern as vote result)
                  if (deps.socketManager) {
                    deps.socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
                      threadId,
                      message: {
                        id: stored.id,
                        type: 'connector',
                        content: stored.content,
                        source: hintSource,
                        timestamp: stored.timestamp,
                      },
                    });
                  }
                } catch {
                  inlineActionHintEmitFailed.add(1, agentAttr);
                }
              }
            });
          }
        }

        const storedTimestamp = invocationStartedAt;

        // F061: Detect @co-creator mentions in agent response for browser notification
        mentionsUser = storedContent ? detectUserMention(storedContent) : false;

        // #573: skip stream store only when callback confirmed persistence (not just invocation)
        const callbackAlreadyStored = callbackDisposition !== 'none';

        // Store with actual mentions — degrade on failure to ensure done reaches frontend
        // (缅因猫 review P1-2: Redis failure must not block done yield)
        let storedMsgId: string | undefined;
        try {
          // #573: persist with the OUTER cat-cafe parentInvocationId (set by QueueProcessor)
          const persistedInvocationId = options.parentInvocationId ?? ownInvocationId;
          if (!callbackAlreadyStored) {
            const outboundDraft = {
              userId,
              catId,
              content: storedContent,
              messageClass: 'substantive' as const,
              mentions: a2aMentions,
              origin: 'stream',
              timestamp: storedTimestamp,
              threadId,
              ...(mentionsUser ? { mentionsUser } : {}),
              ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
              ...(firstMetadata ? { metadata: firstMetadata } : {}),
              ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
              ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
              extra: {
                ...(allRichBlocks.length > 0 ? { rich: { v: 1 as const, blocks: allRichBlocks } } : {}),
                ...(persistedInvocationId ? { stream: { invocationId: persistedInvocationId } } : {}),
                ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
                ...(options.responsePresentation === 'silent_receipt' ? { scheduler: { hiddenReceipt: true } } : {}),
              },
            } as const;
            if (deps.freshnessGate) {
              const baseline = freshnessBaselineByCat.get(catId);
              if (!baseline) throw new Error(`Missing freshness baseline for ${catId as string}`);
              const result = await publishFreshnessDraft({
                deps,
                ...(freshnessReview ? { review: freshnessReview } : {}),
                successorInvocationId: ownInvocationId,
                invocationId: ownInvocationId ?? persistedInvocationId ?? `route-${catId as string}`,
                submissionKey: `stream:${persistedInvocationId ?? ownInvocationId ?? catId}`,
                userId,
                catId,
                threadId,
                baselineWatermark: baseline,
                draft: outboundDraft,
              });
              const egressRecord = freshnessPersistenceEgress(result);
              if (result.outcome === 'published') {
                storedMsgId = result.message.id;
                freshnessEgressDisposition = 'published';
                freshnessEgressReplayed = result.replayed === true;
                releaseBufferedText = !freshnessEgressReplayed;
                if (freshnessEgressReplayed) a2aMentions = [];
                if (!freshnessEgressReplayed && !voiceMode) {
                  allRichBlocks = await synthesizePublishedVoiceBlocks(deps, result.message, allRichBlocks, catId);
                }
                if (options.persistenceContext) {
                  options.persistenceContext.egressByCat ??= {};
                  options.persistenceContext.egressByCat[catId as string] = egressRecord;
                }
              } else if (result.outcome === 'discarded') {
                freshnessEgressDisposition = 'discarded';
                freshnessEgressHoldId = result.hold.id;
                a2aMentions = [];
                if (options.persistenceContext) {
                  options.persistenceContext.egressByCat ??= {};
                  options.persistenceContext.egressByCat[catId as string] = egressRecord;
                }
              } else {
                freshnessEgressDisposition = 'held';
                freshnessEgressHoldId = result.hold.id;
                freshnessHoldStatus = egressRecord.holdStatus;
                a2aMentions = [];
                if (options.persistenceContext) {
                  options.persistenceContext.egressByCat ??= {};
                  options.persistenceContext.egressByCat[catId as string] = egressRecord;
                }
              }
            } else {
              const storedMsg = await deps.messageStore.append(outboundDraft);
              storedMsgId = storedMsg.id;
            }
            // F088-P3: Stash rich blocks for outbound delivery only after publication.
            if (
              options.persistenceContext &&
              allRichBlocks.length > 0 &&
              !freshnessEgressReplayed &&
              freshnessEgressDisposition !== 'held' &&
              freshnessEgressDisposition !== 'discarded'
            ) {
              options.persistenceContext.richBlocks = allRichBlocks;
            }
          } else {
            freshnessEgressDisposition = callbackDisposition === 'none' ? undefined : callbackDisposition;
            freshnessEgressReplayed = callbackReplayed;
            freshnessEgressHoldId = callbackHoldId;
            if (callbackDisposition === 'held' || callbackDisposition === 'discarded' || callbackReplayed) {
              a2aMentions = [];
            }
            if (options.persistenceContext && callbackDisposition !== 'none') {
              options.persistenceContext.egressByCat ??= {};
              options.persistenceContext.egressByCat[catId as string] = {
                disposition: callbackDisposition,
                ...(callbackPostMessageId ? { messageId: callbackPostMessageId } : {}),
                ...(callbackHoldId ? { holdId: callbackHoldId } : {}),
                ...(callbackReplayed ? { replayed: true } : {}),
              };
            }
            log.info(
              { threadId, catId: catId as string, callbackMessageId: callbackPostMessageId },
              'Stream store skipped — cat_cafe_post_message callback already persisted',
            );
            if (callbackPostMessageId && !callbackReplayed) {
              const metadataPatch: StreamMetadataAugmentInput = {
                ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
                ...(firstMetadata ? { metadata: firstMetadata } : {}),
                ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
                ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
                ...(mentionsUser ? { mentionsUser } : {}),
              };
              const extraParts = {
                ...(allRichBlocks.length > 0 ? { rich: { v: 1 as const, blocks: allRichBlocks } } : {}),
                ...(persistedInvocationId ? { stream: { invocationId: persistedInvocationId } } : {}),
                ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
              };
              if (Object.keys(extraParts).length > 0) metadataPatch.extra = extraParts;

              if (hasStreamMetadataPatch(metadataPatch)) {
                try {
                  const augmented = await deps.messageStore.augmentStreamMetadata(callbackPostMessageId, metadataPatch);
                  if (!augmented) {
                    log.warn(
                      { threadId, catId: catId as string, callbackMessageId: callbackPostMessageId },
                      'Callback message metadata augment skipped: message not found',
                    );
                  }
                } catch (augmentErr) {
                  log.warn(
                    { threadId, catId: catId as string, callbackMessageId: callbackPostMessageId, err: augmentErr },
                    'Callback message metadata augment failed; continuing without duplicate stream append',
                  );
                }
              }
            }
          }
          // #80: Clean up draft after message is persisted (either via append or callback)
          if (deps.draftStore && ownInvocationId) {
            deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
          }
          // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
          if (deps.invocationDeps.threadStore) {
            try {
              await deps.invocationDeps.threadStore.updateParticipantActivity(
                threadId,
                catId,
                // #267: only errors before abort are provider failures
                !hadProviderError,
              );
            } catch (activityErr) {
              log.warn({ catId: catId as string, err: activityErr }, 'updateParticipantActivity failed');
            }
          }
        } catch (err) {
          log.error({ catId: catId as string, err }, 'messageStore.append failed, degrading');
          if (options.persistenceContext) {
            options.persistenceContext.failed = true;
            options.persistenceContext.errors.push({
              catId: catId as string,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (deps.freshnessGate && freshnessEgressDisposition === 'published' && !freshnessEgressReplayed) {
          for (const effect of pendingPublishedRoutingEffects.splice(0)) await effect();
        } else if (deps.freshnessGate) {
          pendingPublishedRoutingEffects.length = 0;
        }

        yield* finalizePublishedHistoryCriticalSeal(
          storedMsgId ?? callbackPostMessageId,
          storedContent,
          Boolean(callbackPostMessageId && !storedMsgId),
        );

        if (
          !incrementalMode &&
          thinkingMode === 'debug' &&
          !freshnessEgressReplayed &&
          freshnessEgressDisposition !== 'held' &&
          freshnessEgressDisposition !== 'discarded'
        ) {
          previousResponses.push({ catId, content: storedContent });
        }

        if (
          deps.freshnessGate &&
          freshnessEgressDisposition === 'published' &&
          !freshnessEgressReplayed &&
          !releaseBufferedText &&
          pendingFreshnessToolExposureEvents.length > 0
        ) {
          for (const event of pendingFreshnessToolExposureEvents.splice(0).sort((a, b) => a.timestamp - b.timestamp)) {
            yield event;
          }
        }

        if (deps.freshnessGate && releaseBufferedText && !freshnessEgressReplayed && storedMsgId) {
          const releasableToolEvents = [
            ...pendingFreshnessToolExposureEvents.splice(0),
            ...pendingCallbackExposureEvents.splice(0),
          ].sort((left, right) => left.timestamp - right.timestamp);
          for (const event of releasableToolEvents) yield event;
          yield {
            type: 'text',
            catId,
            content: storedContent,
            textMode: 'replace',
            origin: 'stream',
            messageId: storedMsgId,
            ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
            ...(streamReplyPreview ? { replyPreview: streamReplyPreview } : {}),
            ...(options.responsePresentation === 'silent_receipt'
              ? { extra: { scheduler: { hiddenReceipt: true } } }
              : {}),
            timestamp: storedTimestamp,
          } as AgentMessage;
          for (const block of allRichBlocks) {
            yield {
              type: 'system_info',
              catId,
              content: JSON.stringify({ type: 'rich_block', block, messageId: storedMsgId }),
              invocationId: ownInvocationId,
              timestamp: storedTimestamp,
            } as AgentMessage;
          }
        } else if (deps.freshnessGate && freshnessEgressDisposition === 'held') {
          yield {
            type: 'system_info',
            catId,
            content: JSON.stringify({
              type: freshnessHoldStatus === 'needs_attention' ? 'freshness_needs_attention' : 'freshness_hold',
              disposition: 'held',
              holdId: freshnessEgressHoldId,
              message:
                freshnessHoldStatus === 'needs_attention'
                  ? '连续两次复核仍遇到新消息，旧稿继续保留，等待人工处理。'
                  : '收到新消息，旧稿已扣住并等待重新审阅。',
            }),
            invocationId: ownInvocationId,
            timestamp: Date.now(),
          } as AgentMessage;
        }

        if (invocationSpanRef.current) catInvocationSpans.set(index, invocationSpanRef.current);

        for (const compactBoundary of compactBoundarySignals) {
          await appendCompactBoundaryTaskEvent(deps, {
            threadId,
            currentUserMessageId,
            catId,
            invocationId: options.parentInvocationId ?? ownInvocationId,
            timestamp: compactBoundary.timestamp,
            ...(compactBoundary.preTokens !== undefined ? { preTokens: compactBoundary.preTokens } : {}),
          });
        }

        // A2A: extend worklist if mention found + depth allows + queue fairness gate
        // F27: dedup only against pending (not-yet-executed) tail — cats that already ran
        // can be re-enqueued for another round (e.g. A→B→A review ping-pong).
        let queuedMessagesPending = false;
        if (queueHasQueuedMessages) {
          try {
            queuedMessagesPending = queueHasQueuedMessages(threadId);
          } catch {
            queuedMessagesPending = false;
          }
        }
        const a2aBlockedNoticeKeys = new Set<string>();
        const emitA2ABlockedNotice = async (
          targets: readonly CatId[],
          reason: A2ARoutingBlockedReason,
        ): Promise<void> => {
          for (const targetCatId of targets) {
            const key = `${storedMsgId ?? 'unpersisted'}:${catId}:${targetCatId}:${reason}`;
            if (a2aBlockedNoticeKeys.has(key)) continue;
            a2aBlockedNoticeKeys.add(key);
            await persistA2ARoutingBlockedNotice(deps, {
              threadId,
              fromCatId: catId as string,
              targetCatId: targetCatId as string,
              reason,
              ...(storedMsgId ? { triggerMessageId: storedMsgId } : {}),
            });
          }
        };

        // Diagnostic: log when A2A text-scan gate blocks (previously silent)
        if (a2aMentions.length > 0) {
          if (queuedMessagesPending) {
            log.info(
              { threadId, catId, a2aMentions, a2aCount: worklistEntry.a2aCount },
              enqueueA2ATargets
                ? 'A2A text-scan deferred: user messages pending; admitting to durable queue'
                : 'A2A text-scan blocked: user messages pending in queue (fairness gate)',
            );
            if (!enqueueA2ATargets) {
              await emitA2ABlockedNotice(a2aMentions, 'queued_user_messages');
            }
          } else if (worklistEntry.a2aCount >= maxDepth) {
            log.info(
              { threadId, catId, a2aMentions, a2aCount: worklistEntry.a2aCount, maxDepth },
              'A2A text-scan blocked: depth limit reached',
            );
            await emitA2ABlockedNotice(a2aMentions, 'depth_limit');
          } else if (signal?.aborted) {
            log.info({ threadId, catId, a2aMentions }, 'A2A text-scan blocked: signal aborted');
            await emitA2ABlockedNotice(a2aMentions, 'aborted');
          }
        }

        if (
          a2aMentions.length > 0 &&
          worklistEntry.a2aCount < maxDepth &&
          !signal?.aborted &&
          (!queuedMessagesPending || Boolean(enqueueA2ATargets))
        ) {
          if (enqueueA2ATargets) {
            if (!storedMsgId) {
              await emitA2ABlockedNotice(a2aMentions, 'trigger_not_persisted');
            } else {
              const queueTargets: CatId[] = [];
              for (const nextCat of a2aMentions) {
                if (worklistEntry.a2aCount >= maxDepth) break;
                // Busy targets are admitted to the canonical durable queue. Exact
                // message idempotency prevents replays without dropping new mentions.
                const hadSubstantiveToolCall = collectedToolNames.some((n) => isSubstantiveTool(n));
                const streak = updateStreakOnPush(worklistEntry, catId, nextCat, {
                  hadSubstantiveToolCall,
                  outputLength: storedContent.length,
                });
                if (streak.blockPingPong) {
                  log.info(
                    { threadId, catId: nextCat, fromCat: catId, count: streak.count },
                    'F167 L1: A2A ping-pong terminated (streak >= 4)',
                  );
                  yield {
                    type: 'system_info' as AgentMessageType,
                    catId,
                    content: JSON.stringify({
                      type: 'a2a_pingpong_terminated',
                      fromCatId: catId,
                      targetCatId: nextCat,
                      pairCount: streak.count,
                    }),
                    timestamp: Date.now(),
                  } as AgentMessage;
                  await emitA2ABlockedNotice([nextCat], 'pingpong_terminated');
                  continue;
                }
                queueTargets.push(nextCat);
                worklistEntry.a2aCount++;
              }
              if (queueTargets.length > 0) {
                const enqueued = await enqueueA2ATargets({
                  threadId,
                  userId,
                  callerCatId: catId,
                  targetCats: queueTargets,
                  content: storedContent,
                  triggerMessageId: storedMsgId,
                  ...(currentUserMessageId ? { sourceUserMessageId: currentUserMessageId } : {}),
                  ...(queuedMessagesPending ? { waitedForQueuedUserMessages: true as const } : {}),
                  ...(deps.freshnessGate ? { freshnessProtected: true as const } : {}),
                });
                const enqueuedSet = new Set(enqueued.map((pendingCat) => pendingCat as string));
                const droppedTargets = queueTargets.filter((targetCat) => !enqueuedSet.has(targetCat as string));
                if (droppedTargets.length > 0) {
                  await emitA2ABlockedNotice(droppedTargets, 'enqueue_noop');
                }
                for (const pendingCat of enqueued) {
                  if (queuedMessagesPending) {
                    await persistA2ADeferredNotice(deps, {
                      threadId,
                      fromCatId: catId,
                      targetCatId: pendingCat,
                      triggerMessageId: storedMsgId,
                    }).catch((err) => {
                      log.warn(
                        { err, threadId, fromCatId: catId, targetCatId: pendingCat, triggerMessageId: storedMsgId },
                        'persist A2A deferred notice failed',
                      );
                    });
                  }
                  const nextConfig: CatConfig | undefined = catRegistry.tryGet(pendingCat as string)?.config;
                  yield {
                    type: 'a2a_handoff' as AgentMessageType,
                    catId,
                    content: `${catConfig?.displayName ?? catId} → ${nextConfig?.displayName ?? pendingCat}`,
                    timestamp: Date.now(),
                  } as AgentMessage;
                }
              }
            }
          } else {
            // F153: mention_dispatch span — tracks the causal link between mentioner and dispatched targets
            let dispatchSpan: Span | undefined;
            const pendingTail = worklist.slice(index + 1);
            const pendingOriginalTargets = targetCats.slice(index + 1);
            for (const nextCat of a2aMentions) {
              if (worklistEntry.a2aCount >= maxDepth) break;
              // A2A cross-path dedup: skip if this cat is actively processing via callback (InvocationQueue)
              if (hasQueuedOrActiveAgentForCat && hasQueuedOrActiveAgentForCat(threadId, nextCat)) {
                log.info(
                  { threadId, catId: nextCat, fromCat: catId },
                  'A2A text-scan dedup: cat actively processing in InvocationQueue, skipping',
                );
                await emitA2ABlockedNotice([nextCat], 'active_or_queued');
                continue;
              }
              if (pendingTail.includes(nextCat)) {
                // Keep original user-selected targets replying to user, not to another cat.
                if (!pendingOriginalTargets.includes(nextCat)) {
                  worklistEntry.a2aFrom.set(nextCat, catId);
                  // F121: response-text path — set trigger message for auto-replyTo
                  if (storedMsgId) worklistEntry.a2aTriggerMessageId.set(nextCat, storedMsgId);
                }
                continue;
              }
              // F167 L1 + Phase D: ping-pong streak check (canonical enqueue point).
              // callerActivity (substantive tool + output length) gates streak accumulation —
              // real work / long discussion no longer trips the breaker falsely.
              // streak=4+ (pure language inertia) → block enqueue + emit a2a_pingpong_terminated.
              const hadSubstantiveToolCall = collectedToolNames.some((n) => isSubstantiveTool(n));
              const streak = updateStreakOnPush(worklistEntry, catId, nextCat, {
                hadSubstantiveToolCall,
                outputLength: storedContent.length,
              });
              if (streak.blockPingPong) {
                log.info(
                  { threadId, catId: nextCat, fromCat: catId, count: streak.count },
                  'F167 L1: A2A ping-pong terminated (streak >= 4)',
                );
                yield {
                  type: 'system_info' as AgentMessageType,
                  catId,
                  content: JSON.stringify({
                    type: 'a2a_pingpong_terminated',
                    fromCatId: catId,
                    targetCatId: nextCat,
                    pairCount: streak.count,
                  }),
                  timestamp: Date.now(),
                } as AgentMessage;
                await emitA2ABlockedNotice([nextCat], 'pingpong_terminated');
                continue;
              }

              // F153: lazily create mention_dispatch span on first actual push
              if (!dispatchSpan) {
                const mentionerSpan = catInvocationSpans.get(index);
                if (mentionerSpan) {
                  const parentCtx = trace.setSpan(context.active(), mentionerSpan);
                  dispatchSpan = routeSerialTracer.startSpan(
                    'cat_cafe.mention_dispatch',
                    {
                      attributes: { [AGENT_ID]: catId as string, 'dispatch.target_count': a2aMentions.length },
                    },
                    parentCtx,
                  );
                }
              }

              worklist.push(nextCat);
              worklistEntry.a2aCount++;
              pendingTail.push(nextCat); // Keep dedup view in sync
              worklistEntry.a2aFrom.set(nextCat, catId);
              // F121: response-text path — set trigger message for auto-replyTo
              if (storedMsgId) worklistEntry.a2aTriggerMessageId.set(nextCat, storedMsgId);
              // F153: record mention parent span for dispatched target
              if (dispatchSpan) mentionParentSpan.set(worklist.length - 1, dispatchSpan);
            }
            // F153: end or defer dispatch span based on child execution
            if (dispatchSpan) {
              let maxChildIdx = -1;
              for (const [idx, s] of mentionParentSpan) {
                if (s === dispatchSpan && idx > maxChildIdx) maxChildIdx = idx;
              }
              if (maxChildIdx > index) {
                pendingDispatchSpans.push({ span: dispatchSpan, lastChildIndex: maxChildIdx });
              } else {
                dispatchSpan.end();
              }
            }
          }
        }

        // F27: Emit a2a_handoff for ALL new A2A targets (both response-text and callback-pushed).
        // We track which targets have already been announced to avoid duplicate handoff events.
        for (let wi = handoffEmitted; wi < worklist.length; wi++) {
          const pendingCat = worklist[wi]!;
          if (wi < targetCats.length) continue; // Skip original targets — not A2A

          // === A2A_HANDOFF 审计 (fire-and-forget, 缅因猫 review P2-3) ===
          const auditLog = getEventAuditLog();
          auditLog
            .append({
              type: AuditEventTypes.A2A_HANDOFF,
              threadId,
              data: {
                fromCat: catId,
                toCat: pendingCat,
                userId,
                a2aDepth: worklistEntry.a2aCount,
                maxDepth,
              },
            })
            .catch((err) => {
              log.warn({ threadId, fromCat: catId, toCat: pendingCat, err }, 'A2A_HANDOFF audit write failed');
            });

          const nextConfig: CatConfig | undefined = catRegistry.tryGet(pendingCat as string)?.config;
          if (options.invocationController && options.trackA2ASlot && !activeTrackedA2ASlots.has(pendingCat)) {
            options.trackA2ASlot(threadId, pendingCat, userId, options.invocationController);
            activeTrackedA2ASlots.add(pendingCat);
          }
          yield {
            type: 'a2a_handoff' as AgentMessageType,
            catId,
            content: `${catConfig?.displayName ?? catId} → ${nextConfig?.displayName ?? pendingCat}`,
            timestamp: Date.now(),
          } as AgentMessage;
        }
        handoffEmitted = worklist.length;
      } else if (!hadError) {
        // No text content and no error.
        // Persist assistant bubbles only when there is visible rich payload.
        // Tool-only/thinking-only/empty turns get a system notice instead of a blank bubble.
        let noTextBlocks = [...bufferedBlocks, ...streamRichBlocks];
        const hasRichBlocks = noTextBlocks.length > 0;
        const shouldPersistNoTextMessage = hasRichBlocks;
        const shouldPersistSilentNotice = !hasRichBlocks && !sawUserFacingSystemInfo;

        log.debug(
          {
            catId: catId as string,
            threadId,
            hasRichBlocks,
            sawUserFacingSystemInfo,
            toolCount: collectedToolEvents.length,
            shouldPersist: shouldPersistNoTextMessage,
            shouldPersistSilentNotice,
            thinkingLen: renderThinkingChunks(thinkingChunks).length,
          },
          'Cat produced no text — evaluating silent_completion',
        );
        // A synthetic silent-completion notice is runtime diagnostics, not a
        // cat-authored response and must not acknowledge a pending guide.
        if (shouldPersistNoTextMessage || sawUserFacingSystemInfo) {
          catProducedOutput = true;
        }

        if (shouldPersistNoTextMessage) {
          let storedRichMessageId: string | undefined;
          try {
            const persistedInvocationId = options.parentInvocationId ?? ownInvocationId;
            const outboundDraft = {
              userId,
              catId,
              content: '',
              messageClass: 'substantive' as const,
              mentions: [],
              origin: 'stream',
              timestamp: invocationStartedAt,
              threadId,
              ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
              ...(thinkingChunks.length > 0 ? { thinking: renderThinkingChunks(thinkingChunks) } : {}),
              ...(firstMetadata ? { metadata: firstMetadata } : {}),
              ...(collectedToolEvents.length > 0 ? { toolEvents: collectedToolEvents } : {}),
              extra: {
                ...(noTextBlocks.length > 0 ? { rich: { v: 1 as const, blocks: noTextBlocks } } : {}),
                ...(persistedInvocationId ? { stream: { invocationId: persistedInvocationId } } : {}),
                ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
              },
            } as const;

            if (deps.freshnessGate) {
              const baseline = freshnessBaselineByCat.get(catId);
              if (!baseline) throw new Error(`Missing freshness baseline for ${catId as string}`);
              const result = await publishFreshnessDraft({
                deps,
                ...(freshnessReview ? { review: freshnessReview } : {}),
                successorInvocationId: ownInvocationId,
                invocationId: ownInvocationId ?? persistedInvocationId ?? `route-${catId as string}`,
                submissionKey: `stream:${persistedInvocationId ?? ownInvocationId ?? catId}`,
                userId,
                catId,
                threadId,
                baselineWatermark: baseline,
                draft: outboundDraft,
              });
              const egressRecord = freshnessPersistenceEgress(result);
              if (result.outcome === 'published') {
                storedRichMessageId = result.message.id;
                freshnessEgressDisposition = 'published';
                freshnessEgressReplayed = result.replayed === true;
                if (!freshnessEgressReplayed && !voiceMode) {
                  noTextBlocks = await synthesizePublishedVoiceBlocks(deps, result.message, noTextBlocks, catId);
                }
                if (options.persistenceContext) {
                  options.persistenceContext.egressByCat ??= {};
                  options.persistenceContext.egressByCat[catId as string] = egressRecord;
                }
              } else if (result.outcome === 'discarded') {
                freshnessEgressDisposition = 'discarded';
                freshnessEgressHoldId = result.hold.id;
                if (options.persistenceContext) {
                  options.persistenceContext.egressByCat ??= {};
                  options.persistenceContext.egressByCat[catId as string] = egressRecord;
                }
              } else {
                freshnessEgressDisposition = 'held';
                freshnessEgressHoldId = result.hold.id;
                freshnessHoldStatus = egressRecord.holdStatus;
                if (options.persistenceContext) {
                  options.persistenceContext.egressByCat ??= {};
                  options.persistenceContext.egressByCat[catId as string] = egressRecord;
                }
              }
            } else {
              const stored = await deps.messageStore.append(outboundDraft);
              storedRichMessageId = stored.id;
            }

            // F088-P3: Stash rich blocks for outbound delivery only after publication.
            if (
              options.persistenceContext &&
              noTextBlocks.length > 0 &&
              !freshnessEgressReplayed &&
              freshnessEgressDisposition !== 'held' &&
              freshnessEgressDisposition !== 'discarded'
            ) {
              options.persistenceContext.richBlocks = [
                ...(options.persistenceContext.richBlocks ?? []),
                ...noTextBlocks,
              ];
            }
            // #80: Clean up draft only after successful append
            if (deps.draftStore && ownInvocationId) {
              deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
            }
            // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
            if (deps.invocationDeps.threadStore) {
              try {
                await deps.invocationDeps.threadStore.updateParticipantActivity(
                  threadId,
                  catId,
                  // #267: only errors before abort are provider failures
                  !hadProviderError,
                );
              } catch (activityErr) {
                log.warn({ catId: catId as string, err: activityErr }, 'updateParticipantActivity failed');
              }
            }
          } catch (err) {
            log.error({ catId: catId as string, err }, 'messageStore.append failed, degrading');
            if (options.persistenceContext) {
              options.persistenceContext.failed = true;
              options.persistenceContext.errors.push({
                catId: catId as string,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          yield* finalizePublishedHistoryCriticalSeal(
            callbackPostMessageId ?? storedRichMessageId,
            '',
            Boolean(callbackPostMessageId),
          );

          if (
            deps.freshnessGate &&
            freshnessEgressDisposition === 'published' &&
            !freshnessEgressReplayed &&
            storedRichMessageId
          ) {
            for (const callbackEvent of pendingCallbackExposureEvents.splice(0)) yield callbackEvent;
            for (const block of noTextBlocks) {
              yield {
                type: 'system_info',
                catId,
                content: JSON.stringify({ type: 'rich_block', block, messageId: storedRichMessageId }),
                invocationId: ownInvocationId,
                timestamp: Date.now(),
              } as AgentMessage;
            }
          } else if (deps.freshnessGate && freshnessEgressDisposition === 'held') {
            yield {
              type: 'system_info',
              catId,
              content: JSON.stringify({
                type: freshnessHoldStatus === 'needs_attention' ? 'freshness_needs_attention' : 'freshness_hold',
                disposition: 'held',
                holdId: freshnessEgressHoldId,
                message:
                  freshnessHoldStatus === 'needs_attention'
                    ? '连续两次复核仍遇到新消息，旧稿继续保留，等待人工处理。'
                    : '收到新消息，旧稿已扣住并等待重新审阅。',
              }),
              invocationId: ownInvocationId,
              timestamp: Date.now(),
            } as AgentMessage;
          }
          if (freshnessEgressReplayed) {
            pendingFreshnessToolExposureEvents.length = 0;
            pendingCallbackExposureEvents.length = 0;
          }
        }

        if (!shouldPersistNoTextMessage && callbackDisposition === 'published' && !callbackReplayed) {
          yield* finalizePublishedHistoryCriticalSeal(callbackPostMessageId, '', true);
        }

        if (shouldPersistSilentNotice) {
          const persistedNotice = await persistSilentCompletionNotice(deps, {
            threadId,
            catId: catId as string,
            displayName: catConfig?.displayName,
            toolCount: collectedToolEvents.length,
            provider: firstMetadata?.provider,
            model: firstMetadata?.model,
            invocationId: ownInvocationId,
          });
          if (!persistedNotice) {
            yield {
              type: 'system_info' as AgentMessageType,
              catId,
              content: JSON.stringify({
                type: 'silent_completion',
                detail: `${catConfig?.displayName ?? (catId as string)} completed without textual output.`,
                toolCount: collectedToolEvents.length,
                provider: firstMetadata?.provider,
                model: firstMetadata?.model,
                invocationId: ownInvocationId,
              }),
              timestamp: Date.now(),
            } as AgentMessage;
          }
          if (!shouldPersistNoTextMessage && deps.draftStore && ownInvocationId) {
            deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
          }
        } else if (!shouldPersistNoTextMessage && !sawUserFacingSystemInfo) {
          yield {
            type: 'system_info' as AgentMessageType,
            catId,
            content: JSON.stringify({
              type: 'silent_completion',
              detail: `${catConfig?.displayName ?? (catId as string)} completed without textual output.`,
              toolCount: collectedToolEvents.length,
              provider: firstMetadata?.provider,
              model: firstMetadata?.model,
              invocationId: ownInvocationId,
            }),
            timestamp: Date.now(),
          } as AgentMessage;
          // No persisted message for fully silent turns.
          if (deps.draftStore && ownInvocationId) {
            deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
          }
        } else if (deps.draftStore && ownInvocationId) {
          deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
        }
      } else if (collectedToolEvents.length > 0 && deps.freshnessGate) {
        // Tool-only provider failures have no publishable envelope. Treat the
        // private attempt as fail-closed control flow; never persist or expose
        // the tool input/result through history or downstream consumers.
        if (options.persistenceContext) {
          options.persistenceContext.egressByCat ??= {};
          options.persistenceContext.egressByCat[catId as string] = { disposition: 'discarded' };
        }
        if (deps.draftStore && ownInvocationId) {
          deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
        }
      } else if (collectedToolEvents.length > 0) {
        // hadError && textContent === '' but toolEvents exist — persist tool record so
        // refreshing the page still shows what the cat attempted before the error.
        try {
          await deps.messageStore.append({
            userId,
            catId,
            content: '',
            mentions: [],
            origin: 'stream',
            timestamp: invocationStartedAt,
            threadId,
            ...(streamReplyTo ? { replyTo: streamReplyTo } : {}),
            ...(firstMetadata ? { metadata: firstMetadata } : {}),
            toolEvents: collectedToolEvents,
            ...((options.parentInvocationId ?? ownInvocationId) || doneMsg?.tracing
              ? {
                  extra: {
                    ...((options.parentInvocationId ?? ownInvocationId)
                      ? { stream: { invocationId: (options.parentInvocationId ?? ownInvocationId) as string } }
                      : {}),
                    ...(doneMsg?.tracing ? { tracing: doneMsg.tracing } : {}),
                  },
                }
              : {}),
          });
          // #80: Clean up draft only after successful append
          if (deps.draftStore && ownInvocationId) {
            deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
          }
          // Cloud Codex R4 P1 fix: Update activity in isolated try/catch to not affect append status
          if (deps.invocationDeps.threadStore) {
            try {
              await deps.invocationDeps.threadStore.updateParticipantActivity(
                threadId,
                catId,
                // #267: only errors before abort are provider failures
                !hadProviderError,
              );
            } catch (activityErr) {
              log.warn({ catId: catId as string, err: activityErr }, 'updateParticipantActivity failed');
            }
          }
        } catch (err) {
          log.error({ catId: catId as string, err }, 'messageStore.append (error+tools) failed, degrading');
          if (options.persistenceContext) {
            options.persistenceContext.failed = true;
            options.persistenceContext.errors.push({
              catId: catId as string,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        // hadError && textContent === '' && no toolEvents → clean up draft only
        if (deps.draftStore && ownInvocationId) {
          deps.draftStore.delete(userId, threadId, ownInvocationId)?.catch?.(noop);
        }
        // Update activity for error-only responses (no text/tools branch handles it)
        if (deps.invocationDeps.threadStore) {
          try {
            await deps.invocationDeps.threadStore.updateParticipantActivity(threadId, catId, !hadProviderError);
          } catch (activityErr) {
            log.warn({ catId: catId as string, err: activityErr }, 'updateParticipantActivity failed');
          }
        }
      }

      // F27: Emit a2a_handoff for ALL new A2A targets (both response-text and callback-pushed).
      // Keep this outside the text branch: callback/tool-only turns can push worklist entries
      // without producing text, but their child slots still must be tracked before parent done.
      // We track which targets have already been announced to avoid duplicate handoff events.
      for (let wi = handoffEmitted; wi < worklist.length; wi++) {
        const pendingCat = worklist[wi]!;
        if (wi < targetCats.length) continue; // Skip original targets — not A2A

        // === A2A_HANDOFF 审计 (fire-and-forget, 缅因猫 review P2-3) ===
        const auditLog = getEventAuditLog();
        auditLog
          .append({
            type: AuditEventTypes.A2A_HANDOFF,
            threadId,
            data: {
              fromCat: catId,
              toCat: pendingCat,
              userId,
              a2aDepth: worklistEntry.a2aCount,
              maxDepth,
            },
          })
          .catch((err) => {
            log.warn({ threadId, fromCat: catId, toCat: pendingCat, err }, 'A2A_HANDOFF audit write failed');
          });

        const nextConfig: CatConfig | undefined = catRegistry.tryGet(pendingCat as string)?.config;
        if (options.invocationController && options.trackA2ASlot && !activeTrackedA2ASlots.has(pendingCat)) {
          options.trackA2ASlot(threadId, pendingCat, userId, options.invocationController);
          activeTrackedA2ASlots.add(pendingCat);
        }
        yield {
          type: 'a2a_handoff' as AgentMessageType,
          catId,
          content: `${catConfig?.displayName ?? catId} → ${nextConfig?.displayName ?? pendingCat}`,
          timestamp: Date.now(),
        } as AgentMessage;
      }
      handoffEmitted = worklist.length;

      // Persist error as system message so it survives F5 reload.
      // During streaming, errors render as red badges via ephemeral frontend state.
      // Without persistence, they vanish on page refresh.
      if (collectedErrorText) {
        try {
          await deps.messageStore.append({
            userId: 'system',
            catId: null,
            content: `Error: ${collectedErrorText}`,
            mentions: [],
            origin: 'stream',
            ...(collectedErrorMetadata
              ? {
                  metadata: {
                    ...collectedErrorMetadata,
                    diagnostics: {
                      ...collectedErrorMetadata.diagnostics,
                      ...(collectedErrorCode ? { errorCode: collectedErrorCode } : {}),
                    },
                  },
                }
              : {}),
            timestamp: Date.now(),
            threadId,
          });
        } catch (err) {
          log.error({ catId: catId as string, err }, 'messageStore.append (error system msg) failed');
        }
      }

      // Ack cursor regardless of hadError: messages were assembled into the prompt
      // and delivered to the cat. Not acking causes infinite re-delivery on subsequent
      // rounds (bug: "砚砚每次都疯狂回之前的消息").
      if (incrementalMode && deliveryBoundaryId) {
        if (options.cursorBoundaries) {
          // ADR-008 S3: defer ack — caller acks after completion (or on abort/exception)
          upsertMaxBoundary(options.cursorBoundaries, catId, deliveryBoundaryId);
        } else if (deps.deliveryCursorStore) {
          // Legacy: ack immediately (deprecated route() path)
          try {
            await deps.deliveryCursorStore.ackCursor(userId, catId, threadId, deliveryBoundaryId);
          } catch (err) {
            log.error({ catId: catId as string, err }, 'ackCursor failed');
          }
        }
      }

      // F148 OQ-2: Log briefing→invocation link + context eval signals
      if (briefingMessageId && ownInvocationId) {
        const evalSignals = briefingCoverageMap
          ? extractContextEvalSignals({
              coverageMap: briefingCoverageMap,
              toolNames: collectedToolNames,
              responseTokenEstimate: estimateTokens(textContent),
            })
          : undefined;
        log.info({
          f148: 'briefing-invocation-link',
          briefingMessageId,
          invocationId: ownInvocationId,
          catId,
          threadId,
          hadError: hadProviderError,
          ...(evalSignals ? { eval: evalSignals } : {}),
        });
      }

      // F155: Ack guide completion only after cat produced visible output.
      if (deps.invocationDeps.threadStore) {
        const { createGuideStoreBridge } = await import('../../../../guides/GuideSessionRepository.js');
        const sessionStore = deps.invocationDeps.guideSessionStore!;
        await ackGuideCompletion({
          ctx: guideCtx,
          catId,
          catProducedOutput,
          targetCatIds,
          threadId,
          userId,
          guideStore: createGuideStoreBridge(sessionStore),
          threadStore: deps.invocationDeps.threadStore!,
        });
      }

      // Yield buffered done with correct isFinal (evaluated AFTER worklist may have grown)
      // MUST always reach here regardless of append success (缅因猫 review P1-2)
      if (doneMsg) {
        const isFinal = index === worklist.length - 1;
        yield { ...doneMsg, ...(mentionsUser ? { mentionsUser } : {}), isFinal };
        activeTrackedA2ASlots.delete(catId);
        if (isFinal) yieldedFinalDone = true;
      }

      // F27: Advance executedIndex so pushToWorklist knows which cats are done
      worklistEntry.executedIndex = index + 1;
      index++;
    }
  } finally {
    // F153: Set route aggregate attributes on the parent route span
    if (options.routeSpan) {
      options.routeSpan.setAttribute(ROUTE_TOTAL_CATS_INVOKED, index);
      options.routeSpan.setAttribute(ROUTE_TOTAL_TOKENS, routeTotalTokens);
      options.routeSpan.setAttribute(ROUTE_HAS_A2A_HANDOFF, worklist.length > targetCats.length);
    }
    // F153: End all pending dispatch spans (unconditional — covers abort/throw)
    for (const entry of pendingDispatchSpans) {
      entry.span.end();
    }

    if (options.invocationController && options.completeA2ASlots && activeTrackedA2ASlots.size > 0) {
      options.completeA2ASlots(threadId, [...activeTrackedA2ASlots], options.invocationController);
    }

    // F27: Always unregister worklist, even on error/abort.
    // Pass owner ref so preempting new invocation's worklist is not deleted (缅因猫 R1 P1-1)
    unregisterWorklist(threadId, worklistEntry, options.parentInvocationId);

    // done-guarantee safety net: If loop exited without yielding a final done
    // (e.g. signal.aborted break at top of while, or provider threw before done),
    // synthesize one so the frontend always receives isFinal=true and clears its timer.
    if (!yieldedFinalDone && worklist.length > 0) {
      const lastCatId = worklist[Math.min(index, worklist.length - 1)]!;
      yield {
        type: 'done' as AgentMessageType,
        catId: lastCatId,
        isFinal: true,
        timestamp: Date.now(),
      } as AgentMessage;
    }
  }
}
