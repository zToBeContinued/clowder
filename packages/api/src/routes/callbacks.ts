/**
 * Callback API Routes — MCP 回传端点
 * 安全: 每个请求都需要 invocationId + callbackToken 验证。
 */

import { randomUUID } from 'node:crypto';
import type { CatId, CatRoutingError, RichBlock } from '@cat-cafe/shared';
import { catRegistry, createCatId, normalizeRichBlock } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveFrontendBaseUrl } from '../config/frontend-origin.js';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type {
  InvocationRecord,
  InvocationRegistry,
} from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { InvocationTracker } from '../domains/cats/services/agents/invocation/InvocationTracker.js';
import { MessageDeliveryService } from '../domains/cats/services/agents/invocation/MessageDeliveryService.js';
import { getRichBlockBuffer } from '../domains/cats/services/agents/invocation/RichBlockBuffer.js';
import { analyzeA2AMentions } from '../domains/cats/services/agents/routing/a2a-mentions.js';
import { sanitizeAgentVisibleOutput } from '../domains/cats/services/agents/routing/agent-output-sanitizer.js';
import { resolveCatTarget } from '../domains/cats/services/agents/routing/cat-target-resolver.js';
import { extractRichFromText } from '../domains/cats/services/agents/routing/rich-block-extract.js';
import {
  buildContentFreeInbox,
  decodeContentFreeInboxCursor,
  selectUnreadMessagesForCat,
} from '../domains/cats/services/agents/routing/route-helpers.js';
import type { AgentRouter } from '../domains/cats/services/index.js';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { DeliveryCursorStore } from '../domains/cats/services/stores/ports/DeliveryCursorStore.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import {
  hydrateReplyPreview,
  type IMessageStore,
  type StoredMessage,
  type ThreadAppendWatermark,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import { type ITaskStore, isSubjectOwnershipConflictError } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore, VotingStateV1 } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { canViewMessage, isSystemUserMessage } from '../domains/cats/services/stores/visibility.js';
import { getVoiceBlockSynthesizer } from '../domains/cats/services/tts/VoiceBlockSynthesizer.js';
import type { IEvidenceStore, IMarkerQueue, IReflectionService } from '../domains/memory/interfaces.js';
import type { MarkerQueueRouter } from '../domains/memory/MarkerQueueRouter.js';
import { buildVoteNotification } from '../domains/votes/vote-utils.js';
import { buildThreadDeepLink } from '../infrastructure/connectors/connector-command-helpers.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { scoreKeywordRelevance, tokenizeKeyword } from '../utils/keyword-relevance.js';
import { getFeatureTagId } from './backlog-doc-import.js';
import { enqueueA2ATargets, triggerA2AInvocation } from './callback-a2a-trigger.js';
import {
  extractCallbackCredentials,
  registerCallbackAuthHook,
  requireCallbackAuth,
  requireCallbackPrincipal,
} from './callback-auth-prehandler.js';
import { CallbackAuthSystemMessageNotifier } from './callback-auth-system-message.js';
import { recordCallbackAuthFailure } from './callback-auth-telemetry.js';
import { registerCallbackBootcampRoutes } from './callback-bootcamp-routes.js';
import { registerCallbackDocumentRoutes } from './callback-document-routes.js';
import { claimCallbackSideEffect } from './callback-freshness-side-effect.js';
import { registerCallbackGameRoutes } from './callback-game-routes.js';
import { registerCallbackGuideRoutes } from './callback-guide-routes.js';
import { type HoldBallRouteDeps, registerCallbackHoldBallRoutes } from './callback-hold-ball-routes.js';
import { registerCallbackLarkActionRoutes } from './callback-lark-action-routes.js';
import { registerCallbackLimbRoutes } from './callback-limb-routes.js';
import { registerCallbackMemoryRoutes } from './callback-memory-routes.js';
import { getMultiMentionOrchestrator, registerMultiMentionRoutes } from './callback-multi-mention-routes.js';
import { registerCallbackQuestRoutes } from './callback-quest-routes.js';
import {
  deriveCallbackActor,
  effectiveInvocationId,
  resolvePrincipalThread,
  resolveScopedThreadId,
} from './callback-scope-helpers.js';
import { registerCallbackTaskRoutes } from './callback-task-routes.js';
import { registerCallbackThreadCatsRoutes } from './callback-thread-cats-routes.js';
import { registerCallbackWeComActionRoutes } from './callback-wecom-action-routes.js';
import { registerCallbackWorkflowSopRoutes } from './callback-workflow-sop-routes.js';
import { type FeatIndexEntry, readFeatIndexEntries } from './feat-index-doc-import.js';
import { detectUserMention } from './user-mention.js';
import { clearVoteTimer, closeVoteInternal, voteTimers } from './votes.js';

const log = createModuleLogger('routes/callbacks');

const DEFAULT_HISTORY_FETCH_MESSAGES = 24;
const DEFAULT_HISTORY_FETCH_MAX_TOKENS = 8000;
const DEFAULT_HISTORY_FETCH_SCAN_MESSAGES = 500;

function readBoundedIntEnv(key: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[key] ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function estimateHistoryFetchTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function redactCredentialLikeText(text: string): string {
  return text
    .replace(/\bsk_(agent|machine|proj|live|test)_[A-Za-z0-9_-]+/g, 'sk_$1_<redacted>')
    .replace(/\b(?:ghp|gho|ghu|ghs|glpat)-[A-Za-z0-9_-]{20,}\b/g, '<redacted-token>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, 'Bearer <redacted>')
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '<redacted-access-key>');
}

function sanitizeHistoryFetchContent(content: string): string {
  return redactCredentialLikeText(sanitizeAgentVisibleOutput(content));
}

function buildPostMessageRoutingMessage(routedIds: string[], warnings: CatRoutingError[]): string {
  const parts: string[] = [];
  if (routedIds.length > 0) parts.push(`消息已路由给 ${routedIds.map((id) => `@${id}`).join('、')}。`);
  for (const w of warnings) {
    if (w.kind === 'cat_disabled') {
      const alts = w.alternatives
        .slice(0, 2)
        .map((a) => a.mention)
        .join('、');
      parts.push(`@${w.catId} 已停用，已跳过${alts ? `（可用替代：${alts}）` : ''}。`);
    } else {
      parts.push(`${w.mention} 不存在，已跳过。`);
    }
  }
  return parts.length > 0 ? parts.join(' ') : '消息已存储。';
}

export interface CallbackRoutesOptions {
  registry: InvocationRegistry;
  agentKeyRegistry?: import('../domains/cats/services/agents/agent-key/AgentKeyRegistry.js').AgentKeyRegistry;
  messageStore: IMessageStore;
  /** Freshness Hold egress gate. When absent, legacy callback delivery remains unchanged. */
  freshnessGate?: FreshnessEgressGate;
  socketManager: SocketManager;
  /** F174 D2b-1: in-context surface for callback auth failures (optional — back-compat). */
  callbackAuthNotifier?: CallbackAuthSystemMessageNotifier;
  /** F155 review fix: allow tests to inject a failing guide flow loader. */
  loadGuideFlow?: (guideId: string) => unknown;
  /** F155 review fix: allow tests to inject guide availability prerequisites. */
  getGuideAvailabilityContext?: (
    threadId: string,
  ) => Promise<{ memberCardCount: number }> | { memberCardCount: number };
  taskStore?: ITaskStore;
  backlogStore?: IBacklogStore;
  /** For thinking mode filtering in thread-context + thread-cats discovery */
  threadStore?: IThreadStore;
  /** F155 B-4: Independent guide session store */
  guideSessionStore?: import('../domains/guides/GuideSessionRepository.js').IGuideSessionStore;
  /** AgentRegistry for thread-cats MCP callback */
  agentRegistry?: { getAllEntries(): Map<string, unknown> };
  /** For post_message @mention → invocation triggering */
  router?: AgentRouter;
  invocationRecordStore?: IInvocationRecordStore;
  invocationTracker?: InvocationTracker;
  /** For mention ack cursor tracking (#77) */
  deliveryCursorStore?: DeliveryCursorStore;
  /** Phase D: validates GitHub repo exists before PR tracking registration */
  validateRepo?: (repoFullName: string) => Promise<boolean>;
  /** F043 P1: feat_index provider override for tests */
  featIndexProvider?: () => Promise<FeatIndexEntry[]>;
  /** F073 P1: workflow SOP store for bulletin board */
  workflowSopStore?: import('../domains/cats/services/stores/ports/WorkflowSopStore.js').IWorkflowSopStore;
  /** F102: DI memory services — SQLite-backed evidence store */
  evidenceStore: IEvidenceStore;
  markerQueue: IMarkerQueue;
  /** 按 thread 所属项目路由 marker，避免外部项目的知识写进本仓库 docs/markers/。 */
  markerQueueRouter?: MarkerQueueRouter;
  reflectionService: IReflectionService;
  holdBallDeps?: HoldBallRouteDeps;
  /** Queue auto-dequeue on A2A invocation completion */
  queueProcessor?: {
    onInvocationComplete(
      threadId: string,
      catId: string,
      status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
    ): Promise<void>;
    tryAutoExecute(threadId: string): Promise<void>;
    registerEntryCompleteHook(
      entryId: string,
      hook: (
        entryId: string,
        status: 'succeeded' | 'failed' | 'canceled' | 'canceled_by_user',
        responseText: string,
      ) => void,
    ): void;
    unregisterEntryCompleteHook(entryId: string): void;
  };
  /** F122B: InvocationQueue for agent-sourced A2A entries */
  invocationQueue?: import('../domains/cats/services/agents/invocation/InvocationQueue.js').InvocationQueue;
  /** F126: Limb node registry for device/hardware capability management */
  limbRegistry?: import('../domains/limb/LimbRegistry.js').LimbRegistry;
  /** F126 Phase C: Limb pairing store for remote device approval */
  limbPairingStore?: import('../domains/limb/LimbPairingStore.js').LimbPairingStore;
  /** F088: Outbound delivery hook for connector-bound threads (late-bound after gateway bootstrap). */
  outboundHook?: {
    deliver(
      threadId: string,
      content: string,
      catId?: string,
      richBlocks?: RichBlock[],
      threadMeta?: { threadShortId: string; threadTitle?: string; deepLinkUrl?: string },
      origin?: 'callback' | 'agent' | 'system',
      triggerMessageId?: string,
    ): Promise<void>;
  };
}

const postMessageSchema = z.object({
  content: z.string().min(1).max(50000),
  // LLM-authored callback payloads cannot self-declare a freshness exemption.
  messageClass: z.literal('substantive').optional(),
  threadId: z.string().min(1).optional(),
  replyTo: z.string().optional(),
  clientMessageId: z.string().min(1).max(200).optional(),
  targetCats: z.array(z.string().min(1)).optional(),
});

const postProgressSchema = z.object({
  content: z.string().min(1).max(2000),
  kind: z.enum(['ack', 'heartbeat']),
  threadId: z.string().min(1).optional(),
  replyTo: z.string().optional(),
  clientMessageId: z.string().min(1).max(200),
});

const freshnessReviewSchema = z.object({
  action: z.enum(['replace', 'send_draft', 'discard']),
  expectedVersion: z.number().int().positive(),
  clientMessageId: z.string().min(1).max(200).optional(),
  replacement: z
    .object({
      content: z.string().min(1).max(50000),
      replyTo: z.string().optional(),
      targetCats: z.array(z.string().min(1)).optional(),
    })
    .optional(),
});

const threadContextQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  threadId: z.string().min(1).optional(), // F-Swarm-6: optional cross-thread read
  catId: z.string().min(1).optional(),
  keyword: z.string().min(1).optional(),
});

const fetchThreadHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(80).optional(),
  threadId: z.string().min(1).optional(),
  fromMessageId: z.string().min(1).optional(),
  toMessageId: z.string().min(1).optional(),
  query: z.string().min(1).max(200).optional(),
  catId: z.string().min(1).optional(),
  maxTokens: z.coerce.number().int().min(500).max(20000).optional(),
});

const messageSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  threadId: z.string().min(1).optional(),
  catId: z.string().min(1).optional(),
});

const listThreadsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  activeSince: z.coerce.number().int().min(0).optional(),
  keyword: z.string().trim().min(1).max(200).optional(),
});

const featIndexQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  featId: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
});

const pendingMentionsQuerySchema = z.object({
  // Accept both scalar and repeated query params (Fastify may surface string[]).
  includeAcked: z.union([z.string(), z.array(z.string())]).optional(),
});

const checkInboxQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  cursor: z.string().min(1).max(1024).optional(),
});

const ackMentionsSchema = z.object({
  upToMessageId: z.string().min(1),
});

function isMessageVisibleToPrincipalUser(message: StoredMessage, userId: string): boolean {
  if (message.deletedAt) return false;
  if (message.userId === userId || isSystemUserMessage(message)) return true;
  // Agent / connector messages belong to the shared thread surface even when
  // persisted with a different technical userId.
  return Boolean(message.catId || message.source);
}

async function resolveCallbackThreadTitle(
  threadStore: IThreadStore | undefined,
  threadId: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(threadId);
  if (cached) return cached;

  const thread = await Promise.resolve(threadStore?.get(threadId)).catch(() => null);
  const title = thread?.title || (threadId === 'default' ? '大厅' : '未命名对话');
  cache.set(threadId, title);
  return title;
}

/** F22: Rich block creation schema — validates shape + kind-specific fields (cloud Codex P1) */
const richChecklistItemSchema = z.object({ id: z.string(), text: z.string(), checked: z.boolean().optional() });
const richMediaItemSchema = z.object({ url: z.string(), alt: z.string().optional(), caption: z.string().optional() });
const richBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('card'),
    v: z.literal(1),
    title: z.string(),
    bodyMarkdown: z.string().optional(),
    tone: z.enum(['info', 'success', 'warning', 'danger']).optional(),
    fields: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('diff'),
    v: z.literal(1),
    filePath: z.string(),
    diff: z.string(),
    languageHint: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('checklist'),
    v: z.literal(1),
    title: z.string().optional(),
    items: z.array(richChecklistItemSchema).min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('media_gallery'),
    v: z.literal(1),
    title: z.string().optional(),
    items: z.array(richMediaItemSchema).min(1),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('audio'),
    v: z.literal(1),
    url: z.string().optional().default(''),
    text: z.string().optional(),
    title: z.string().optional(),
    durationSec: z.number().optional(),
    mimeType: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('interactive'),
    v: z.literal(1),
    interactiveType: z.enum(['select', 'multi-select', 'card-grid', 'confirm']),
    title: z.string().optional(),
    description: z.string().optional(),
    options: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          emoji: z.string().optional(),
          icon: z.string().optional(),
          description: z.string().optional(),
          level: z.number().optional(),
          group: z.string().optional(),
          customInput: z.boolean().optional(),
          customInputPlaceholder: z.string().optional(),
          action: z
            .object({
              type: z.literal('callback'),
              endpoint: z.string().min(1),
              payload: z.record(z.unknown()).optional(),
            })
            .optional(),
        }),
      )
      .min(1),
    maxSelect: z.number().int().min(1).optional(),
    allowRandom: z.boolean().optional(),
    messageTemplate: z.string().optional(),
    disabled: z.boolean().optional(),
    selectedIds: z.array(z.string()).optional(),
    groupId: z.string().min(1).optional(),
  }),
  // F088 Phase J: file attachment block
  z.object({
    id: z.string().min(1),
    kind: z.literal('file'),
    v: z.literal(1),
    url: z
      .string()
      .min(1)
      .refine(
        (u) => !u.includes('..') && (/^\/uploads\//.test(u) || /^\/api\//.test(u) || /^https:\/\//.test(u)),
        'file url must start with /uploads/, /api/, or https://',
      ),
    fileName: z.string().min(1),
    mimeType: z.string().optional(),
    fileSize: z.number().int().min(0).optional(),
  }),
  // F120 Phase C: html_widget — inline sandboxed HTML/JS visualization
  z.object({
    id: z.string().min(1),
    kind: z.literal('html_widget'),
    v: z.literal(1),
    html: z.string().min(1).max(500_000),
    title: z.string().optional(),
    height: z.number().int().min(50).max(2000).optional(),
  }),
]);
const createRichBlockSchema = z.object({
  block: richBlockSchema,
});

function normalizeFeatId(value: string): string {
  return value.trim().toUpperCase();
}

async function buildThreadIdsByFeatId(
  threadStore: IThreadStore | undefined,
  backlogStore: IBacklogStore | undefined,
  userId: string,
  logger: { warn: (obj: unknown, msg?: string) => void },
): Promise<Map<string, string[]>> {
  const mapped = new Map<string, string[]>();
  if (!threadStore || !backlogStore) return mapped;

  try {
    const threads = await threadStore.list(userId);
    for (const thread of threads) {
      if (!thread.backlogItemId) continue;
      const backlogItem = await backlogStore.get(thread.backlogItemId, userId);
      if (!backlogItem) continue;
      const featureTagId = getFeatureTagId(backlogItem.tags);
      if (!featureTagId) continue;
      const featId = normalizeFeatId(featureTagId);
      if (featId.length === 0) continue;
      const existing = mapped.get(featId);
      if (!existing) {
        mapped.set(featId, [thread.id]);
        continue;
      }
      if (!existing.includes(thread.id)) existing.push(thread.id);
    }
  } catch (err) {
    logger.warn({ err, userId }, '[callbacks/feat-index] threadIds enrichment degraded');
  }

  return mapped;
}

export const callbacksRoutes: FastifyPluginAsync<CallbackRoutesOptions> = async (app, opts) => {
  const {
    registry,
    agentKeyRegistry,
    messageStore,
    socketManager,
    callbackAuthNotifier,
    taskStore,
    backlogStore,
    threadStore,
    router,
    invocationRecordStore,
    invocationTracker,
    deliveryCursorStore,
    validateRepo,
    featIndexProvider,
    queueProcessor,
  } = opts;

  registerCallbackAuthHook(app, registry, {
    ...(callbackAuthNotifier ? { notifier: callbackAuthNotifier } : {}),
    ...(agentKeyRegistry ? { agentKeyRegistry } : {}),
  });

  const callbackMutationGuards = new WeakMap<FastifyRequest, Map<string, () => void>>();
  const acquireCallbackMutation = (request: FastifyRequest, threadId: string): boolean => {
    if (!opts.invocationQueue) return true;
    const held = callbackMutationGuards.get(request) ?? new Map<string, () => void>();
    if (held.has(threadId)) return true;
    const guard = opts.invocationQueue.guardCallbackMutation(threadId);
    if (!guard.acquired) return false;
    held.set(threadId, guard.release);
    callbackMutationGuards.set(request, held);
    return true;
  };
  const releaseCallbackMutations = (request: FastifyRequest): void => {
    const held = callbackMutationGuards.get(request);
    if (!held) return;
    callbackMutationGuards.delete(request);
    for (const release of held.values()) release();
  };
  app.addHook('onResponse', async (request) => releaseCallbackMutations(request));
  app.addHook('onError', async (request) => releaseCallbackMutations(request));

  const invocationPredatesReset = async (record: InvocationRecord, targetThreadId: string): Promise<boolean> => {
    if (!threadStore || typeof threadStore.getContextResetBoundary !== 'function') return false;
    const boundary = await Promise.resolve(threadStore.getContextResetBoundary(targetThreadId, record.userId));
    return Boolean(boundary && record.createdAt < boundary.resetAt);
  };

  // A completed invocation token may remain valid for hours. Reset turns its
  // creation timestamp into a hard auth epoch so delayed callbacks cannot
  // republish pre-reset work under a newer message ID.
  app.addHook('preHandler', async (request, reply) => {
    const record = request.callbackAuth;
    if (!record || !threadStore) return;
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (await invocationPredatesReset(record, record.threadId)) {
      if (mutating) {
        reply.status(200).send({ status: 'stale_ignored', code: 'CONTEXT_RESET_STALE' });
        return;
      }
      reply.status(409).send({ error: 'Invocation predates context reset', code: 'CONTEXT_RESET_STALE' });
      return;
    }
    if (mutating && !acquireCallbackMutation(request, record.threadId)) {
      reply.status(200).send({ status: 'stale_ignored', code: 'CONTEXT_RESET_STALE' });
    }
  });

  app.post('/api/callbacks/post-progress', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = postProgressSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { content, kind, threadId, replyTo, clientMessageId } = parsed.data;
    const storedContent = sanitizeAgentVisibleOutput(content);
    if (!storedContent.trim()) {
      reply.status(400);
      return { error: 'Progress content is empty after sanitization' };
    }
    const routingAnalysis = analyzeA2AMentions(storedContent, createCatId(principal.catId));
    if (routingAnalysis.mentions.length > 0 || routingAnalysis.routing_warnings.length > 0) {
      reply.status(400);
      return { error: 'Progress messages cannot route or mention other Agents' };
    }

    let effectiveThreadId: string;
    let effectiveInvocationId: string | undefined;

    if (principal.kind === 'agent_key') {
      const threadResult = await resolvePrincipalThread(principal, threadId, { threadStore });
      if (!threadResult.ok) {
        reply.status(threadResult.statusCode);
        return { error: threadResult.error };
      }
      effectiveThreadId = threadResult.threadId;
    } else {
      if (!(await registry.isLatest(principal.invocationId))) {
        return { status: 'stale_ignored', clientMessageId };
      }
      if (threadId && threadId !== principal.threadId) {
        reply.status(400);
        return { error: 'Progress messages must stay in the current invocation thread' };
      }
      effectiveThreadId = principal.threadId;
      effectiveInvocationId = principal.parentInvocationId ?? principal.invocationId;
    }
    if (principal.kind === 'invocation' && (await invocationPredatesReset(request.callbackAuth!, effectiveThreadId))) {
      return { status: 'stale_ignored', code: 'CONTEXT_RESET_STALE', clientMessageId };
    }
    if (!acquireCallbackMutation(request, effectiveThreadId)) {
      return { status: 'stale_ignored', code: 'CONTEXT_RESET_STALE', clientMessageId };
    }

    let validatedReplyTo: string | undefined;
    if (replyTo) {
      const parentMsg = await messageStore.getById(replyTo);
      if (parentMsg && parentMsg.threadId === effectiveThreadId) validatedReplyTo = replyTo;
    }

    const agentCommunication = {
      kind,
      ...(effectiveInvocationId ? { invocationId: effectiveInvocationId } : {}),
    } as const;
    const invocationAckKey =
      principal.kind === 'invocation' && kind === 'ack'
        ? `agent-progress:ack:${principal.catId}`
        : `agent-progress:${clientMessageId}`;
    const storageIdempotencyKey =
      principal.kind === 'invocation' && kind === 'ack'
        ? `agent-progress:${principal.invocationId}:${principal.catId}:ack`
        : `agent-progress:${principal.kind}:${principal.catId}:${clientMessageId}`;
    const storedMsg = await messageStore.append({
      threadId: effectiveThreadId,
      userId: principal.userId,
      catId: principal.catId,
      content: storedContent,
      messageClass: 'status',
      mentions: [],
      origin: 'progress',
      timestamp: Date.now(),
      extra: {
        agentCommunication,
      },
      ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
      idempotencyKey: storageIdempotencyKey,
    });

    if (principal.kind === 'agent_key') {
      if (!agentKeyRegistry) {
        reply.status(503);
        return { error: 'Agent-key registry unavailable' };
      }
      const isFirst = await agentKeyRegistry.claimClientMessageId(principal.agentKeyId, invocationAckKey);
      if (!isFirst) return { status: 'duplicate', clientMessageId, messageId: storedMsg.id };
    } else {
      const isFirst = await registry.claimClientMessageId(principal.invocationId, invocationAckKey);
      if (!isFirst) return { status: 'duplicate', clientMessageId, messageId: storedMsg.id };
    }

    const replyPreview = validatedReplyTo ? await hydrateReplyPreview(messageStore, validatedReplyTo) : undefined;

    socketManager.broadcastAgentMessage(
      {
        type: 'text',
        catId: principal.catId,
        content: storedContent,
        origin: 'progress',
        messageId: storedMsg.id,
        ...(effectiveInvocationId ? { invocationId: effectiveInvocationId } : {}),
        extra: { agentCommunication },
        ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
        ...(replyPreview ? { replyPreview } : {}),
        timestamp: Date.now(),
      },
      effectiveThreadId,
    );

    if (opts.outboundHook) {
      const frontendBase = resolveFrontendBaseUrl(process.env);
      const thread = await threadStore?.get(effectiveThreadId);
      opts.outboundHook
        .deliver(
          effectiveThreadId,
          storedContent,
          principal.catId,
          undefined,
          {
            threadShortId: effectiveThreadId.slice(0, 15),
            threadTitle: thread?.title ?? undefined,
            deepLinkUrl: buildThreadDeepLink(frontendBase, effectiveThreadId),
          },
          'agent',
          validatedReplyTo,
        )
        .catch((err: unknown) => {
          app.log.error({ err, threadId: effectiveThreadId }, '[callbacks/post-progress] Outbound delivery failed');
        });
    }

    return {
      status: 'ok',
      threadId: effectiveThreadId,
      messageId: storedMsg.id,
      kind,
      clientMessageId,
    };
  });

  app.post('/api/callbacks/post-message', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    if (principal.kind === 'agent_key') {
      const parsed = postMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parsed.error.issues };
      }
      const threadResult = await resolvePrincipalThread(principal, parsed.data.threadId, { threadStore });
      if (!threadResult.ok) {
        reply.status(threadResult.statusCode);
        return { error: threadResult.error };
      }
      const effectiveThreadId = threadResult.threadId;
      if (!acquireCallbackMutation(request, effectiveThreadId)) {
        return { status: 'stale_ignored', code: 'CONTEXT_RESET_STALE' };
      }
      const { content, replyTo, clientMessageId, targetCats: explicitTargetCats } = parsed.data;

      if (clientMessageId && agentKeyRegistry) {
        const isFirst = await agentKeyRegistry.claimClientMessageId(principal.agentKeyId, clientMessageId);
        if (!isFirst) {
          return { status: 'duplicate', replyTo, clientMessageId };
        }
      }

      const { cleanText, blocks: richBlocks } = extractRichFromText(content);
      const storedContent = sanitizeAgentVisibleOutput(cleanText);

      const senderCatId = createCatId(principal.catId);
      // F182 AC-C1: use analyzeA2AMentions (captures routing_warnings for disabled cats)
      const contentAnalysis = analyzeA2AMentions(storedContent, senderCatId);
      const contentTargets = contentAnalysis.mentions;
      const validExplicitTargets: CatId[] = [];
      const routing_warnings: CatRoutingError[] = [...contentAnalysis.routing_warnings];
      for (const id of explicitTargetCats ?? []) {
        const resolved = resolveCatTarget(id);
        if ('ok' in resolved) {
          validExplicitTargets.push(createCatId(resolved.ok));
        } else {
          routing_warnings.push(resolved.error);
        }
      }
      const mergedTargets = new Set<CatId>([...contentTargets, ...validExplicitTargets]);
      if (contentTargets.length === 1 && mergedTargets.size > 1) {
        const [primaryTarget] = contentTargets;
        if (primaryTarget) {
          mergedTargets.clear();
          mergedTargets.add(primaryTarget);
        }
      }
      const mentions: CatId[] = [...mergedTargets];
      const mentionsUser = detectUserMention(storedContent);

      let validatedReplyTo: string | undefined;
      if (replyTo) {
        const parentMsg = await messageStore.getById(replyTo);
        if (parentMsg && parentMsg.threadId === effectiveThreadId) {
          validatedReplyTo = replyTo;
        }
      }

      const richExtra = richBlocks.length > 0 ? { rich: { v: 1 as const, blocks: richBlocks } } : {};
      const targetCatsExtra = validExplicitTargets.length ? { targetCats: validExplicitTargets } : {};
      const extraParts = { ...richExtra, ...targetCatsExtra };
      const extra = Object.keys(extraParts).length > 0 ? extraParts : undefined;

      const hasA2AMentions = !!(mentions.length > 0 && router && invocationRecordStore && effectiveThreadId);
      const willEnqueueToQueue = !!(hasA2AMentions && opts.invocationQueue);

      const storedMsg = await messageStore.append({
        threadId: effectiveThreadId,
        userId: principal.userId,
        catId: principal.catId,
        content: storedContent,
        mentions,
        ...(mentionsUser ? { mentionsUser } : {}),
        origin: 'callback',
        timestamp: Date.now(),
        ...(extra ? { extra } : {}),
        ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
        ...(willEnqueueToQueue ? { deliveryStatus: 'queued' as const } : {}),
      });

      const replyPreview = validatedReplyTo ? await hydrateReplyPreview(messageStore, validatedReplyTo) : undefined;

      const deliveryDecision = await MessageDeliveryService.resolveCallbackDeliveryDecision({
        canEnqueueA2A: hasA2AMentions,
        willEnqueueToQueue,
        messageId: storedMsg.id,
        threadId: effectiveThreadId,
        log: app.log,
        enqueueA2A: () =>
          enqueueA2ATargets(
            {
              router: router!,
              invocationRecordStore: invocationRecordStore!,
              socketManager,
              messageStore,
              ...(invocationTracker ? { invocationTracker } : {}),
              ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
              ...(queueProcessor ? { queueProcessor } : {}),
              ...(opts.invocationQueue ? { invocationQueue: opts.invocationQueue } : {}),
              log: app.log,
            },
            {
              targetCats: mentions,
              content: storedContent,
              userId: principal.userId,
              threadId: effectiveThreadId,
              triggerMessage: storedMsg,
              callerCatId: senderCatId,
            },
          ),
        markDelivered: (deliveredAt) => messageStore.markDelivered?.(storedMsg.id, deliveredAt),
        zeroEnqueuedWarnMessage: '[agent-key/post-message] Failed to recover ghost message — broadcasting anyway',
        enqueueFailureMessage: '[agent-key/post-message] enqueueA2ATargets failed — falling back to broadcast',
      });

      // #607: Only broadcast when message is not queued — queued messages are
      // broadcast later via messages_delivered when QueueProcessor delivers them.
      if (deliveryDecision.shouldBroadcastNow) {
        socketManager.broadcastAgentMessage(
          {
            type: 'text',
            catId: principal.catId,
            content: storedContent,
            origin: 'callback',
            messageId: storedMsg.id,
            invocationId: storedMsg.id,
            ...(validExplicitTargets.length ? { extra: { targetCats: validExplicitTargets } } : {}),
            ...(mentionsUser ? { mentionsUser } : {}),
            ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
            ...(replyPreview ? { replyPreview } : {}),
            timestamp: Date.now(),
          },
          effectiveThreadId,
        );

        for (const block of richBlocks) {
          socketManager.broadcastAgentMessage(
            {
              type: 'system_info' as const,
              catId: principal.catId,
              content: JSON.stringify({ type: 'rich_block', block, messageId: storedMsg.id }),
              invocationId: storedMsg.id,
              timestamp: Date.now(),
            },
            effectiveThreadId,
          );
        }
      }

      if (opts.outboundHook) {
        const frontendBase = resolveFrontendBaseUrl(process.env);
        const thread = await threadStore?.get(effectiveThreadId);
        const threadMeta = {
          threadShortId: effectiveThreadId.slice(0, 15),
          threadTitle: thread?.title ?? undefined,
          deepLinkUrl: buildThreadDeepLink(frontendBase, effectiveThreadId),
        };
        opts.outboundHook
          .deliver(
            effectiveThreadId,
            storedContent,
            principal.catId,
            richBlocks.length > 0 ? richBlocks : undefined,
            threadMeta,
            'callback',
            validatedReplyTo,
          )
          .catch((err: unknown) => {
            app.log.error({ err, threadId: effectiveThreadId }, '[agent-key/post-message] Outbound delivery failed');
          });
      }

      // F182 AC-C1: soft degradation — routing_warnings + KD-7 message field
      // If caller specified explicit targets and ALL were unavailable → signal routing failure
      const allExplicitFailed =
        (explicitTargetCats?.length ?? 0) > 0 && validExplicitTargets.length === 0 && contentTargets.length === 0;
      if (allExplicitFailed) {
        return {
          isError: true,
          routed: [],
          routing_warnings,
          message: buildPostMessageRoutingMessage([], routing_warnings),
          threadId: effectiveThreadId,
          messageId: storedMsg.id,
          ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        };
      }

      return {
        status: 'ok',
        threadId: effectiveThreadId,
        messageId: storedMsg.id,
        ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(routing_warnings.length > 0 ? { routing_warnings } : {}),
        message: buildPostMessageRoutingMessage([...mentions], routing_warnings),
      };
    }

    const record = request.callbackAuth!;
    const actor = deriveCallbackActor(record);

    const parsed = postMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { content, threadId, replyTo, clientMessageId, targetCats: explicitTargetCats } = parsed.data;
    const { invocationId } = actor;
    // #573: identity for cross-handler dedup. stream + callback for same logical
    // response must broadcast/persist with the same id; QueueProcessor + route-serial
    // use the parent (outer) id, so callback aligns to it.
    const effectiveInvId = effectiveInvocationId(actor);

    // Stale callback guard (cloud Codex P1 + 缅因猫 R3): reject callbacks from
    // preempted invocations. A newer invocation for the same thread+cat supersedes.
    // Return 200 + stale_ignored to avoid retry storms from the dying CLI process.
    if (!(await registry.isLatest(invocationId))) {
      return { status: 'stale_ignored', replyTo, ...(clientMessageId ? { clientMessageId } : {}) };
    }

    let effectiveThreadId = actor.threadId;
    if (threadId && threadId !== actor.threadId) {
      // DIAG: Cross-thread routing debug (ghost-thread bug — opus session responding in wrong thread)
      app.log.info(
        {
          invocationId,
          catId: actor.catId,
          recordThreadId: actor.threadId,
          requestedThreadId: threadId,
        },
        '[DIAG/ghost-thread] post-message: cross-thread detected',
      );
      const scoped = await resolveScopedThreadId(actor, threadId, {
        threadStore,
        threadStoreMissingError: 'Thread store not configured for cross-thread posting',
        accessDeniedError: 'Thread access denied',
      });
      if (!scoped.ok) {
        reply.status(scoped.statusCode);
        return { error: scoped.error };
      }
      effectiveThreadId = scoped.threadId;
    }
    if (await invocationPredatesReset(record, effectiveThreadId)) {
      return {
        status: 'stale_ignored',
        code: 'CONTEXT_RESET_STALE',
        replyTo,
        ...(clientMessageId ? { clientMessageId } : {}),
      };
    }
    if (!acquireCallbackMutation(request, effectiveThreadId)) {
      return {
        status: 'stale_ignored',
        code: 'CONTEXT_RESET_STALE',
        replyTo,
        ...(clientMessageId ? { clientMessageId } : {}),
      };
    }

    const freshnessProtected = Boolean(
      opts.freshnessGate && effectiveThreadId === actor.threadId && record.freshnessBaseline,
    );

    // Legacy identities keep the existing claim path. Protected submissions
    // move idempotency into FreshnessEgressGate so a held retry can replay its
    // holdId and delta instead of degrading to a context-free "duplicate".
    if (clientMessageId && !freshnessProtected) {
      const isFirstSeen = await registry.claimClientMessageId(invocationId, clientMessageId);
      if (!isFirstSeen) {
        return { status: 'duplicate', replyTo, clientMessageId };
      }
    }

    // #83: Extract cc_rich blocks from post_message content (Route B for callback path)
    const { cleanText, blocks: extractedBlocks } = extractRichFromText(content);
    const storedContent = sanitizeAgentVisibleOutput(cleanText);

    // F088-J hotfix: Consume any buffered rich blocks (e.g. file blocks from generate_document).
    // CLI agents don't go through route-serial, so the buffer must be consumed here.
    // For route-serial agents, the buffer is already consumed before post_message — this is a no-op.
    const bufferedBlocks = getRichBlockBuffer().consume(effectiveThreadId, actor.catId as string, invocationId);

    // F34-b: Resolve voice blocks (audio with text, no url) before storing
    const synthesizer = getVoiceBlockSynthesizer();
    let richBlocks = [...extractedBlocks, ...bufferedBlocks];
    if (!freshnessProtected && synthesizer && richBlocks.some((b) => b.kind === 'audio' && 'text' in b)) {
      try {
        richBlocks = await synthesizer.resolveVoiceBlocks(richBlocks, actor.catId as string);
      } catch (err) {
        app.log.error({ err }, '[callbacks/post-message] Voice block synthesis failed');
      }
    }

    // F52: Detect cross-thread post (used for both A2A exemption and crossPost metadata)
    const isCrossThread = effectiveThreadId !== actor.threadId;

    // Parse @mentions anywhere in text (A2A rule: strip code blocks, token boundary, max targets)
    // Uses analyzeA2AMentions to capture routing_warnings for disabled cats (F182 KD-10).
    // F52: Cross-thread posts skip self-reference filter so @codex can trigger target thread's codex
    const senderCatId = createCatId(actor.catId);
    const contentAnalysis = analyzeA2AMentions(storedContent, isCrossThread ? undefined : senderCatId);
    const contentTargets = contentAnalysis.mentions;
    // F098-C1: Merge explicit targetCats with content-parsed mentions (deduped)
    // F182: use resolveCatTarget to distinguish disabled vs unknown — collect routing_warnings
    const validExplicitTargets: CatId[] = [];
    const routing_warnings: CatRoutingError[] = [...contentAnalysis.routing_warnings];
    for (const id of explicitTargetCats ?? []) {
      const resolved = resolveCatTarget(id);
      if ('ok' in resolved) {
        validExplicitTargets.push(createCatId(resolved.ok));
      } else {
        routing_warnings.push(resolved.error);
        app.log.warn(
          { droppedId: id, catId: actor.catId, invocationId, reason: resolved.error.kind },
          '[callbacks/post-message] Dropped unavailable catId from targetCats',
        );
      }
    }
    const mergedTargets = new Set<CatId>([...contentTargets, ...validExplicitTargets]);
    if (contentTargets.length === 1 && mergedTargets.size > 1) {
      const [primaryTarget] = contentTargets;
      if (!primaryTarget) {
        app.log.warn(
          { invocationId, threadId: effectiveThreadId, senderCatId, contentTargets, validExplicitTargets },
          '[A2A/fail-closed] Unexpected empty primary target; skip fail-closed pruning',
        );
      } else {
        const droppedTargets = [...mergedTargets].filter((catId) => catId !== primaryTarget);
        mergedTargets.clear();
        mergedTargets.add(primaryTarget);
        app.log.warn(
          {
            invocationId,
            threadId: effectiveThreadId,
            senderCatId,
            contentTargets,
            validExplicitTargets,
            droppedTargets,
            retainedTarget: primaryTarget,
          },
          '[A2A/fail-closed] Single content mention detected; dropped extra merged targets',
        );
      }
    }
    const mentions: CatId[] = [...mergedTargets];
    if (contentTargets.length > 0 || validExplicitTargets.length > 0) {
      app.log.info(
        {
          invocationId,
          threadId: effectiveThreadId,
          senderCatId,
          contentTargets,
          validExplicitTargets,
          mergedTargets: mentions,
        },
        '[DIAG/a2a] post-message target merge',
      );
    }
    const mentionsUser = detectUserMention(storedContent);
    const crossPostExtra = isCrossThread
      ? { crossPost: { sourceThreadId: actor.threadId, sourceInvocationId: invocationId } }
      : {};
    const richExtra = richBlocks.length > 0 ? { rich: { v: 1 as const, blocks: richBlocks } } : {};
    const targetCatsExtra = validExplicitTargets.length ? { targetCats: validExplicitTargets } : {};
    const extraParts = { ...richExtra, ...crossPostExtra, ...targetCatsExtra };
    const extra = Object.keys(extraParts).length > 0 ? extraParts : undefined;

    // F121: Validate replyTo — must exist in the same thread
    let validatedReplyTo: string | undefined;
    // F121 enhancement: Auto-fill replyTo for A2A-triggered invocations.
    // Priority: 1) explicit replyTo  2) a2aTriggerMessageId (worklist path)  3) InvocationRecordStore fallback
    let autoFilledReplyTo: string | undefined;
    if (!replyTo) {
      // Worklist path: a2aTriggerMessageId is set by route-serial from WorklistEntry
      if (record.a2aTriggerMessageId) {
        autoFilledReplyTo = record.a2aTriggerMessageId;
      } else if (record.parentInvocationId && invocationRecordStore) {
        // Fallback path (standalone invocation): look up InvocationRecordStore
        const parentRecord = (await invocationRecordStore.get(record.parentInvocationId)) as {
          userMessageId?: string | null;
          threadId?: string | null;
        } | null;
        // P3-2 hardening: only trust userMessageId if parentRecord's threadId matches
        if (parentRecord?.userMessageId && (!parentRecord.threadId || parentRecord.threadId === effectiveThreadId)) {
          autoFilledReplyTo = parentRecord.userMessageId;
        }
      }
    }
    const effectiveReplyTo = replyTo ?? autoFilledReplyTo;
    if (effectiveReplyTo) {
      const parentMsg = await messageStore.getById(effectiveReplyTo);
      if (parentMsg && parentMsg.threadId === effectiveThreadId) {
        validatedReplyTo = effectiveReplyTo;
      } else if (replyTo) {
        // Only warn for explicit replyTo failures — auto-fill mismatches are expected
        // (e.g. cross-thread A2A where trigger is in a different thread)
        app.log.warn(
          { replyTo, effectiveThreadId, parentThreadId: parentMsg?.threadId },
          '[callbacks/post-message] replyTo rejected: not found or wrong thread',
        );
      }
    }

    // Store the message (scoped to the effective thread)
    // AC-B6-P1: When A2A mentions will be enqueued (invocationQueue available),
    // store with deliveryStatus:'queued' so ContextAssembler excludes this message
    // from other invocations' context until QueueProcessor.executeEntry marks it delivered.
    const hasA2AMentions = !!(mentions.length > 0 && router && invocationRecordStore && effectiveThreadId);
    const willEnqueueToQueue = !!(hasA2AMentions && opts.invocationQueue);
    // #573: persisted record's extra.stream.invocationId aligned to effectiveInvId
    // (parent/outer) so F5/hydration broadcasts match what live broadcasts use.
    // Merge with any existing extra (cross-post / explicit targets) without losing it.
    const persistedExtra = {
      ...(extra ?? {}),
      stream: { invocationId: effectiveInvId },
    };
    const outboundDraft = {
      userId: actor.userId,
      catId: actor.catId,
      content: storedContent,
      messageClass: 'substantive' as const,
      mentions,
      ...(mentionsUser ? { mentionsUser } : {}),
      origin: 'callback',
      timestamp: Date.now(),
      threadId: effectiveThreadId,
      extra: persistedExtra,
      ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
      ...(willEnqueueToQueue ? { deliveryStatus: 'queued' as const } : {}),
    } as const;

    let storedMsg: StoredMessage;
    if (freshnessProtected) {
      const freshnessResult = await opts.freshnessGate!.submit({
        invocationId,
        submissionKey: clientMessageId ?? randomUUID(),
        userId: actor.userId,
        catId: actor.catId,
        threadId: effectiveThreadId,
        baselineWatermark: record.freshnessBaseline as ThreadAppendWatermark,
        draft: {
          ...outboundDraft,
          ...(clientMessageId ? { idempotencyKey: `callback:${invocationId}:${clientMessageId}` } : {}),
        },
      });
      if (freshnessResult.outcome === 'held' || freshnessResult.outcome === 'needs_attention') {
        return {
          status: freshnessResult.outcome === 'held' ? 'freshness_held' : 'freshness_needs_attention',
          disposition: 'held',
          threadId: effectiveThreadId,
          holdId: freshnessResult.hold.id,
          ...(clientMessageId ? { clientMessageId } : {}),
          freshness: {
            baselineWatermark: freshnessResult.hold.baselineWatermark,
            observedWatermark: freshnessResult.hold.observedWatermark,
            version: freshnessResult.hold.version,
            reviewCount: freshnessResult.hold.reviewCount,
            maxReviews: 2,
            expiresAt: freshnessResult.hold.reviewDeadlineAt,
          },
          newMessages: freshnessResult.delta.messages,
          newMessageCount: freshnessResult.delta.messages.length,
          truncated: freshnessResult.delta.truncated,
          nextActions: ['replace', 'send_draft', 'discard'],
          message: '草稿未发布；请先审阅新消息。',
        };
      }
      if (freshnessResult.outcome === 'discarded') {
        return {
          status: 'freshness_discarded',
          disposition: 'discarded',
          threadId: freshnessResult.hold.threadId,
          holdId: freshnessResult.hold.id,
          ...(clientMessageId ? { clientMessageId } : {}),
        };
      }
      if (freshnessResult.replayed) {
        return {
          status: 'duplicate',
          disposition: 'published',
          threadId: effectiveThreadId,
          messageId: freshnessResult.message.id,
          ...(clientMessageId ? { clientMessageId } : {}),
        };
      }
      // appendIfFresh de-duplicates the formal message, but an idempotent
      // append alone does not tell this HTTP layer which retry owns fanout.
      // Claim only after the freshness verdict so held submissions remain
      // replayable with their canonical holdId and delta.
      if (clientMessageId && !(await registry.claimClientMessageId(invocationId, clientMessageId))) {
        return {
          status: 'duplicate',
          disposition: 'published',
          threadId: effectiveThreadId,
          messageId: freshnessResult.message.id,
          clientMessageId,
        };
      }
      storedMsg = freshnessResult.message;
      // Protected voice blocks are synthesized only after the atomic publication verdict.
      if (synthesizer && richBlocks.some((block) => block.kind === 'audio' && 'text' in block)) {
        try {
          richBlocks = await synthesizer.resolveVoiceBlocks(richBlocks, actor.catId as string);
          const updated = await messageStore.updateExtra(storedMsg.id, {
            ...(storedMsg.extra ?? {}),
            rich: { v: 1, blocks: richBlocks },
          });
          if (updated) storedMsg = updated;
        } catch (err) {
          app.log.error({ err }, '[callbacks/post-message] Published voice block synthesis failed');
        }
      }
    } else {
      storedMsg = await messageStore.append(outboundDraft);
    }

    // F121: Hydrate reply preview for broadcast
    const replyPreview = validatedReplyTo ? await hydrateReplyPreview(messageStore, validatedReplyTo) : undefined;

    // F27: Enqueue @mentioned cats into parent worklist (unified A2A path)
    const deliveryDecision = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: hasA2AMentions,
      willEnqueueToQueue,
      messageId: storedMsg.id,
      threadId: effectiveThreadId,
      log: app.log,
      enqueueA2A: () =>
        enqueueA2ATargets(
          {
            router: router!,
            invocationRecordStore: invocationRecordStore!,
            socketManager,
            messageStore,
            ...(invocationTracker ? { invocationTracker } : {}),
            ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
            ...(queueProcessor ? { queueProcessor } : {}),
            ...(opts.invocationQueue ? { invocationQueue: opts.invocationQueue } : {}),
            log: app.log,
          },
          {
            targetCats: mentions,
            content: storedContent,
            userId: actor.userId,
            threadId: effectiveThreadId,
            triggerMessage: storedMsg,
            callerCatId: senderCatId,
            parentInvocationId: record.parentInvocationId,
            callerTraceContext: record.traceContext,
            ...(freshnessProtected ? { freshnessProtected: true as const } : {}),
          },
        ),
      markDelivered: (deliveredAt) => messageStore.markDelivered?.(storedMsg.id, deliveredAt),
      zeroEnqueuedWarnMessage: '[AC-B6-P1] Failed to recover ghost message — broadcasting anyway',
      enqueueFailureMessage: '[invocation-callback] enqueueA2ATargets failed — falling back to broadcast',
    });

    // #607: Only broadcast when message is not queued — queued messages are
    // broadcast later via messages_delivered when QueueProcessor delivers them.
    if (deliveryDecision.shouldBroadcastNow) {
      socketManager.broadcastAgentMessage(
        {
          type: 'text',
          catId: actor.catId,
          content: storedContent,
          origin: 'callback',
          messageId: storedMsg.id,
          // #573: broadcast with effectiveInvId (parent/outer) so frontend's
          // (catId, invocationId) dedup matches stream broadcasts.
          invocationId: effectiveInvId,
          // F52+F098-C1: Include crossPost + targetCats in real-time broadcast
          ...(isCrossThread || validExplicitTargets.length
            ? {
                extra: {
                  ...(isCrossThread
                    ? { crossPost: { sourceThreadId: actor.threadId, sourceInvocationId: effectiveInvId } }
                    : {}),
                  ...(validExplicitTargets.length ? { targetCats: validExplicitTargets } : {}),
                },
              }
            : {}),
          ...(mentionsUser ? { mentionsUser } : {}),
          ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
          ...(replyPreview ? { replyPreview } : {}),
          timestamp: Date.now(),
        },
        effectiveThreadId,
      );

      // #83: Broadcast each extracted rich block as SSE event for live rendering
      // P2 cloud-review: include messageId for frontend correlation
      // #454/573: include effectiveInvId (parent/outer) so frontend can exact-match
      // callback to stream bubble.
      for (const block of richBlocks) {
        socketManager.broadcastAgentMessage(
          {
            type: 'system_info' as const,
            catId: actor.catId,
            content: JSON.stringify({ type: 'rich_block', block, messageId: storedMsg.id }),
            invocationId: effectiveInvId,
            timestamp: Date.now(),
          },
          effectiveThreadId,
        );
      }
    }

    if (opts.outboundHook) {
      const frontendBase = resolveFrontendBaseUrl(process.env);
      const thread = await opts.threadStore?.get(effectiveThreadId);
      const threadMeta = {
        threadShortId: effectiveThreadId.slice(0, 15),
        threadTitle: thread?.title ?? undefined,
        deepLinkUrl: buildThreadDeepLink(frontendBase, effectiveThreadId),
      };
      opts.outboundHook
        .deliver(
          effectiveThreadId,
          storedContent,
          actor.catId,
          richBlocks.length > 0 ? richBlocks : undefined,
          threadMeta,
          'callback',
          validatedReplyTo,
        )
        .catch((err: unknown) => {
          app.log.error({ err, threadId: effectiveThreadId }, '[callbacks/post-message] Outbound delivery failed');
        });
    }

    // F182 AC-C1: soft degradation — include routing_warnings + KD-7 message field
    // If caller specified explicit targets and ALL were unavailable → signal routing failure
    const allExplicitFailed =
      (explicitTargetCats?.length ?? 0) > 0 && validExplicitTargets.length === 0 && contentTargets.length === 0;
    if (allExplicitFailed) {
      return {
        isError: true,
        disposition: 'published',
        routed: [],
        routing_warnings,
        message: buildPostMessageRoutingMessage([], routing_warnings),
        threadId: effectiveThreadId,
        messageId: storedMsg.id,
        ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
      };
    }

    return {
      status: 'ok',
      disposition: 'published',
      threadId: effectiveThreadId,
      messageId: storedMsg.id,
      ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(routing_warnings.length > 0 ? { routing_warnings } : {}),
      message: buildPostMessageRoutingMessage([...mentions], routing_warnings),
    };
  });

  app.post('/api/callbacks/freshness-holds/:holdId/review', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation') {
      reply.status(403);
      return { error: 'Freshness review requires invocation credentials' };
    }
    if (!opts.freshnessGate) {
      reply.status(503);
      return { error: 'Freshness Hold is not configured' };
    }

    const parsed = freshnessReviewSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    if (parsed.data.action === 'replace' && !parsed.data.replacement) {
      reply.status(400);
      return { error: 'replacement is required for replace' };
    }

    const record = request.callbackAuth!;
    const actor = deriveCallbackActor(record);
    if (!(await registry.isLatest(actor.invocationId))) {
      return { status: 'stale_ignored', holdId: (request.params as { holdId: string }).holdId };
    }
    const holdId = (request.params as { holdId: string }).holdId;
    let replacementDraft: Parameters<FreshnessEgressGate['review']>[0]['replacementDraft'];
    if (parsed.data.action === 'replace' && parsed.data.replacement) {
      const replacement = parsed.data.replacement;
      const { cleanText, blocks } = extractRichFromText(replacement.content);
      const storedContent = sanitizeAgentVisibleOutput(cleanText);
      const senderCatId = createCatId(actor.catId);
      const contentTargets = analyzeA2AMentions(storedContent, senderCatId).mentions;
      const explicitTargets = (replacement.targetCats ?? [])
        .map((target) => resolveCatTarget(target))
        .flatMap((result) => ('ok' in result ? [createCatId(result.ok)] : []));
      const mentions = [...new Set<CatId>([...contentTargets, ...explicitTargets])];
      let validatedReplyTo: string | undefined;
      if (replacement.replyTo) {
        const parent = await messageStore.getById(replacement.replyTo);
        if (parent?.threadId === actor.threadId) validatedReplyTo = replacement.replyTo;
      }
      const willEnqueueToQueue = Boolean(
        mentions.length > 0 && router && invocationRecordStore && opts.invocationQueue,
      );
      replacementDraft = {
        userId: actor.userId,
        catId: actor.catId,
        threadId: actor.threadId,
        content: storedContent,
        messageClass: 'substantive',
        mentions,
        origin: 'callback',
        timestamp: Date.now(),
        ...(detectUserMention(storedContent) ? { mentionsUser: true } : {}),
        ...(validatedReplyTo ? { replyTo: validatedReplyTo } : {}),
        ...(willEnqueueToQueue ? { deliveryStatus: 'queued' as const } : {}),
        extra: {
          stream: { invocationId: effectiveInvocationId(actor) },
          ...(blocks.length > 0 ? { rich: { v: 1 as const, blocks } } : {}),
          ...(explicitTargets.length > 0 ? { targetCats: explicitTargets } : {}),
        },
      };
    }

    let result;
    try {
      result = await opts.freshnessGate.review({
        holdId,
        expectedVersion: parsed.data.expectedVersion,
        action: parsed.data.action,
        ...(replacementDraft ? { replacementDraft } : {}),
        invocationId: actor.invocationId,
        userId: actor.userId,
        catId: actor.catId,
        threadId: actor.threadId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Freshness review failed';
      reply.status(message.includes('ownership') ? 403 : 409);
      return { error: message, holdId };
    }

    if (result.outcome === 'held' || result.outcome === 'needs_attention') {
      return {
        status: result.outcome === 'held' ? 'freshness_held' : 'freshness_needs_attention',
        disposition: 'held',
        threadId: result.hold.threadId,
        holdId: result.hold.id,
        freshness: {
          baselineWatermark: result.hold.baselineWatermark,
          observedWatermark: result.hold.observedWatermark,
          version: result.hold.version,
          reviewCount: result.hold.reviewCount,
          maxReviews: 2,
          expiresAt: result.hold.reviewDeadlineAt,
        },
        newMessages: result.delta.messages,
        newMessageCount: result.delta.messages.length,
        truncated: result.delta.truncated,
      };
    }
    if (result.outcome === 'discarded') {
      return {
        status: 'freshness_discarded',
        disposition: 'discarded',
        threadId: result.hold.threadId,
        holdId: result.hold.id,
        freshness: { version: result.hold.version },
      };
    }

    if (result.replayed) {
      return {
        status: 'duplicate',
        disposition: 'published',
        threadId: result.hold.threadId,
        holdId: result.hold.id,
        messageId: result.message.id,
        freshness: { version: result.hold.version },
      };
    }

    let storedMsg = result.message;
    const reviewSynthesizer = getVoiceBlockSynthesizer();
    let reviewedRichBlocks = [...(storedMsg.extra?.rich?.blocks ?? [])] as RichBlock[];
    if (reviewSynthesizer && reviewedRichBlocks.some((block) => block.kind === 'audio' && 'text' in block)) {
      try {
        reviewedRichBlocks = await reviewSynthesizer.resolveVoiceBlocks(reviewedRichBlocks, actor.catId as string);
        const updated = await messageStore.updateExtra(storedMsg.id, {
          ...(storedMsg.extra ?? {}),
          rich: { v: 1, blocks: reviewedRichBlocks },
        });
        if (updated) storedMsg = updated;
      } catch (err) {
        app.log.error({ err, holdId }, '[freshness-review] Published voice block synthesis failed');
      }
    }
    const senderCatId = createCatId(actor.catId);
    const hasA2AMentions = Boolean(
      storedMsg.mentions.length > 0 && router && invocationRecordStore && storedMsg.threadId,
    );
    const willEnqueueToQueue = Boolean(hasA2AMentions && opts.invocationQueue);
    const deliveryDecision = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: hasA2AMentions,
      willEnqueueToQueue,
      messageId: storedMsg.id,
      threadId: storedMsg.threadId,
      log: app.log,
      enqueueA2A: () =>
        enqueueA2ATargets(
          {
            router: router!,
            invocationRecordStore: invocationRecordStore!,
            socketManager,
            messageStore,
            ...(invocationTracker ? { invocationTracker } : {}),
            ...(deliveryCursorStore ? { deliveryCursorStore } : {}),
            ...(queueProcessor ? { queueProcessor } : {}),
            ...(opts.invocationQueue ? { invocationQueue: opts.invocationQueue } : {}),
            log: app.log,
          },
          {
            targetCats: [...storedMsg.mentions],
            content: storedMsg.content,
            userId: storedMsg.userId,
            threadId: storedMsg.threadId,
            triggerMessage: storedMsg,
            callerCatId: senderCatId,
            parentInvocationId: record.parentInvocationId,
            callerTraceContext: record.traceContext,
            freshnessProtected: true,
          },
        ),
      markDelivered: (deliveredAt) => messageStore.markDelivered(storedMsg.id, deliveredAt),
      zeroEnqueuedWarnMessage: '[freshness-review] Failed to recover queued message — broadcasting anyway',
      enqueueFailureMessage: '[freshness-review] enqueue failed — falling back to broadcast',
    });
    const richBlocks = reviewedRichBlocks;
    if (deliveryDecision.shouldBroadcastNow) {
      const replyPreview = storedMsg.replyTo ? await hydrateReplyPreview(messageStore, storedMsg.replyTo) : undefined;
      socketManager.broadcastAgentMessage(
        {
          type: 'text',
          catId: actor.catId,
          content: storedMsg.content,
          origin: 'callback',
          messageId: storedMsg.id,
          invocationId: effectiveInvocationId(actor),
          ...(storedMsg.extra?.targetCats?.length ? { extra: { targetCats: storedMsg.extra.targetCats } } : {}),
          ...(storedMsg.mentionsUser ? { mentionsUser: true } : {}),
          ...(storedMsg.replyTo ? { replyTo: storedMsg.replyTo } : {}),
          ...(replyPreview ? { replyPreview } : {}),
          timestamp: storedMsg.timestamp,
        },
        storedMsg.threadId,
      );
      for (const block of richBlocks) {
        socketManager.broadcastAgentMessage(
          {
            type: 'system_info',
            catId: actor.catId,
            content: JSON.stringify({ type: 'rich_block', block, messageId: storedMsg.id }),
            invocationId: effectiveInvocationId(actor),
            timestamp: storedMsg.timestamp,
          },
          storedMsg.threadId,
        );
      }
    }
    if (opts.outboundHook) {
      const frontendBase = resolveFrontendBaseUrl(process.env);
      const thread = await threadStore?.get(storedMsg.threadId);
      void opts.outboundHook
        .deliver(
          storedMsg.threadId,
          storedMsg.content,
          actor.catId,
          richBlocks.length > 0 ? richBlocks : undefined,
          {
            threadShortId: storedMsg.threadId.slice(0, 15),
            threadTitle: thread?.title ?? undefined,
            deepLinkUrl: buildThreadDeepLink(frontendBase, storedMsg.threadId),
          },
          'callback',
          storedMsg.replyTo,
        )
        .catch((error: unknown) => {
          app.log.error({ error, holdId, threadId: storedMsg.threadId }, '[freshness-review] outbound failed');
        });
    }

    return {
      status: 'ok',
      disposition: 'published',
      threadId: storedMsg.threadId,
      messageId: storedMsg.id,
      holdId: result.hold.id,
      freshness: { version: result.hold.version },
      ...(parsed.data.clientMessageId ? { clientMessageId: parsed.data.clientMessageId } : {}),
    };
  });

  app.get('/api/callbacks/pending-mentions', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = pendingMentionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters' };
    }

    const { includeAcked } = parsed.data;

    const includeAckedValues = Array.isArray(includeAcked) ? includeAcked : includeAcked ? [includeAcked] : [];
    const shouldIncludeAcked = includeAckedValues.some((v) => v === '1' || v.toLowerCase() === 'true');

    // DIAG: ghost-thread bug — log which thread this invocation thinks it owns
    app.log.debug(
      {
        invocationId: record.invocationId,
        catId: record.catId,
        threadId: record.threadId,
      },
      '[DIAG/ghost-thread] pending-mentions: polling',
    );

    // #77: Use mention ack cursor to filter already-processed mentions
    const catId = createCatId(record.catId);
    const storedAckId = deliveryCursorStore
      ? await deliveryCursorStore.getMentionAckCursor(record.userId, catId, record.threadId)
      : undefined;
    const resetBoundary = threadStore
      ? await Promise.resolve(threadStore.getContextResetBoundary(record.threadId, record.userId))
      : null;
    const lastAckId =
      resetBoundary?.resetAtMessageId && (!storedAckId || resetBoundary.resetAtMessageId > storedAckId)
        ? resetBoundary.resetAtMessageId
        : storedAckId;

    const rawMentions = shouldIncludeAcked
      ? await messageStore.getRecentMentionsFor(record.catId, 20, record.userId, record.threadId)
      : await messageStore.getMentionsFor(record.catId, 20, record.userId, record.threadId, lastAckId);
    // F35: Filter out whispers not intended for this cat
    const mentionViewer = { type: 'cat' as const, catId };
    const mentions = rawMentions.filter(
      (m) =>
        canViewMessage(m, mentionViewer) && (!resetBoundary?.resetAtMessageId || m.id > resetBoundary.resetAtMessageId),
    );
    return {
      mentions: mentions.map((item) => ({
        id: item.id,
        from: item.catId ?? item.userId,
        message: item.content,
        timestamp: item.timestamp,
        ...(shouldIncludeAcked ? { acked: Boolean(lastAckId && item.id <= lastAckId) } : {}),
      })),
    };
  });

  app.get('/api/callbacks/check-inbox', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = checkInboxQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters' };
    }
    if (!deliveryCursorStore) {
      reply.status(501);
      return { error: 'Inbox unavailable (no cursor store)' };
    }

    const threadResult = await resolvePrincipalThread(principal, parsed.data.threadId, { threadStore });
    if (!threadResult.ok) {
      reply.status(threadResult.statusCode);
      return { error: threadResult.error };
    }
    const effectiveThreadId = threadResult.threadId;
    const storedCursor = await deliveryCursorStore.getCursor(principal.userId, principal.catId, effectiveThreadId);
    const resetBoundary = threadStore
      ? await Promise.resolve(threadStore.getContextResetBoundary(effectiveThreadId, principal.userId))
      : null;
    const cursor =
      resetBoundary?.resetAtMessageId && (!storedCursor || resetBoundary.resetAtMessageId > storedCursor)
        ? resetBoundary.resetAtMessageId
        : storedCursor;
    const rawUnseen = await messageStore.getByThreadAfter(effectiveThreadId, cursor, undefined, principal.userId);
    const unseen = resetBoundary?.resetAtMessageId
      ? rawUnseen.filter((message) => message.id > resetBoundary.resetAtMessageId!)
      : rawUnseen;
    const thread = await Promise.resolve(threadStore?.get(effectiveThreadId)).catch(() => null);
    const relevant = selectUnreadMessagesForCat(unseen, principal.catId, thread?.thinkingMode ?? 'play');
    const pageCursor = parsed.data.cursor ? decodeContentFreeInboxCursor(parsed.data.cursor) : undefined;
    if (parsed.data.cursor && !pageCursor) {
      reply.status(400);
      return { error: 'Invalid inbox cursor' };
    }
    const inbox = buildContentFreeInbox(effectiveThreadId, relevant, {
      maxIds: parsed.data.limit ?? 1,
      ...(pageCursor ? { cursor: pageCursor } : {}),
      ...(principal.kind === 'invocation' && request.callbackAuth?.a2aTriggerMessageId
        ? { excludeMessageId: request.callbackAuth.a2aTriggerMessageId }
        : {}),
    });
    return inbox;
  });

  // #77: POST /api/callbacks/ack-mentions — explicit ack with 4-way validation
  app.post('/api/callbacks/ack-mentions', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = ackMentionsSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { upToMessageId } = parsed.data;

    if (!deliveryCursorStore) {
      reply.status(501);
      return { error: 'Mention ack not available (no cursor store)' };
    }

    const catId = createCatId(record.catId);

    // Validation 1: existence
    const targetMsg = await messageStore.getById(upToMessageId);
    if (!targetMsg) {
      reply.status(400);
      return { error: 'upToMessageId does not exist' };
    }

    // Validation 2: ownership (userId + threadId + mentions catId)
    if (targetMsg.userId !== record.userId) {
      reply.status(400);
      return { error: 'upToMessageId does not belong to current user session' };
    }
    if (targetMsg.threadId !== record.threadId) {
      reply.status(400);
      return { error: 'upToMessageId does not belong to current thread' };
    }
    if (!targetMsg.mentions.includes(catId)) {
      reply.status(400);
      return { error: 'upToMessageId does not mention current cat' };
    }

    // Validation 3: monotonic (noop if backwards)
    const currentCursor = await deliveryCursorStore.getMentionAckCursor(record.userId, catId, record.threadId);
    if (currentCursor && upToMessageId <= currentCursor) {
      return { status: 'noop', reason: 'already acknowledged' };
    }

    // Validation 4: window — upToMessageId must be within current pending window
    const pendingWindow = await messageStore.getMentionsFor(
      record.catId,
      20,
      record.userId,
      record.threadId,
      currentCursor,
    );
    if (pendingWindow.length > 0) {
      const windowLastId = pendingWindow[pendingWindow.length - 1]?.id;
      if (upToMessageId > windowLastId) {
        reply.status(400);
        return {
          error: 'upToMessageId exceeds current pending window, ack only within fetched batch',
          windowLastId,
        };
      }
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: opts.freshnessGate,
      registry,
      record,
      route: 'ack-mentions',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return freshness.response;

    await deliveryCursorStore.ackMentionCursor(record.userId, catId, record.threadId, upToMessageId);
    return { status: 'ok', ackedUpTo: upToMessageId };
  });

  app.get('/api/callbacks/thread-context', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = threadContextQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters' };
    }

    const { limit, threadId: overrideThreadId, catId: filterCatId, keyword } = parsed.data;

    if (filterCatId && filterCatId !== 'user' && !catRegistry.has(filterCatId)) {
      reply.status(400);
      return { error: `Unknown catId filter: ${filterCatId}` };
    }

    let effectiveThreadId: string;
    if (principal.kind === 'agent_key') {
      const threadResult = await resolvePrincipalThread(principal, overrideThreadId, { threadStore });
      if (!threadResult.ok) {
        reply.status(threadResult.statusCode);
        return { error: threadResult.error };
      }
      effectiveThreadId = threadResult.threadId;
    } else {
      effectiveThreadId = overrideThreadId ?? principal.threadId;
    }
    const principalCatId = principal.kind === 'invocation' ? principal.catId : principal.catId;
    const principalUserId = principal.userId;
    const resetBoundary = threadStore
      ? await Promise.resolve(threadStore.getContextResetBoundary(effectiveThreadId, principalUserId))
      : null;
    const resetAtMessageId = resetBoundary?.resetAtMessageId;
    // F148 Phase B (AC-B2): tokenize keyword for relevance scoring
    const keywordTerms = keyword ? tokenizeKeyword(keyword) : [];

    const requestedLimit = limit ?? 20;
    let needsPlayFilter = false;
    if (effectiveThreadId && threadStore) {
      const thread = await threadStore.get(effectiveThreadId);
      needsPlayFilter = !!thread && (thread.thinkingMode ?? 'debug') === 'play';
    }

    let filtered: Awaited<ReturnType<typeof messageStore.getByThread>>;

    // F35: Callback callers are always cats, including debug mode.
    // thinkingMode only controls whether another cat's origin=stream is hidden;
    // it must never promote an agent to the all-seeing user viewer for whispers.
    const viewer = { type: 'cat' as const, catId: createCatId(principalCatId) };
    const matchesExtraFilters = (item: Awaited<ReturnType<typeof messageStore.getByThread>>[number]): boolean => {
      if (resetAtMessageId && item.id <= resetAtMessageId) return false;
      // F148 Phase E (AC-E2): briefing messages are non-routing, never enter cat context
      if (item.origin === 'briefing') return false;
      if (filterCatId) {
        if (filterCatId === 'user') {
          if (item.catId !== null) return false;
        } else if (item.catId !== filterCatId) {
          return false;
        }
      }
      // F148 Phase B (AC-B2): tokenized keyword relevance (replaces substring .includes())
      if (keywordTerms.length > 0 && scoreKeywordRelevance(item.content, keywordTerms) === 0) {
        return false;
      }
      return true;
    };

    if (!needsPlayFilter) {
      // Normal mode: paginate backwards collecting visible messages until we
      // have enough or data is exhausted. This ensures whisper filtering
      // doesn't silently shrink the result set.
      const visible: Awaited<ReturnType<typeof messageStore.getByThread>> = [];
      const pageSize = Math.max(requestedLimit * 2, 50);
      let cursorTimestamp = Number.MAX_SAFE_INTEGER;
      let cursorId: string | undefined;

      while (visible.length < requestedLimit) {
        const batch = effectiveThreadId
          ? await messageStore.getByThreadBefore(
              effectiveThreadId,
              cursorTimestamp,
              pageSize,
              cursorId,
              principalUserId,
            )
          : await messageStore.getBefore(cursorTimestamp, pageSize, principalUserId, cursorId);

        if (batch.length === 0) break;

        for (const item of batch) {
          if (!canViewMessage(item, viewer)) continue;
          if (!matchesExtraFilters(item)) continue;
          visible.push(item);
        }

        const oldest = batch[0]!;
        cursorTimestamp = oldest.timestamp;
        cursorId = oldest.id;
      }

      // F148 Phase B (AC-B2): sort by keyword relevance when searching, chronological otherwise
      if (keywordTerms.length > 0) {
        visible.sort((a, b) => {
          const sa = scoreKeywordRelevance(a.content, keywordTerms);
          const sb = scoreKeywordRelevance(b.content, keywordTerms);
          return sb - sa || b.timestamp - a.timestamp; // higher relevance first, then newest first
        });
        filtered = visible.slice(0, requestedLimit); // P1-1 fix: take HEAD (highest relevance)
      } else {
        visible.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
        filtered = visible.slice(-requestedLimit); // take TAIL (most recent)
      }
    } else {
      // Play mode: paginate backwards collecting visible messages until we have enough
      // or data is exhausted. No fixed page cap — correctness over latency.
      const visible: Awaited<ReturnType<typeof messageStore.getByThread>> = [];
      const pageSize = Math.max(requestedLimit * 2, 50); // fetch in chunks, min 50
      let cursorTimestamp = Number.MAX_SAFE_INTEGER;
      let cursorId: string | undefined;

      while (visible.length < requestedLimit) {
        const batch = effectiveThreadId
          ? await messageStore.getByThreadBefore(
              effectiveThreadId,
              cursorTimestamp,
              pageSize,
              cursorId,
              principalUserId,
            )
          : await messageStore.getBefore(cursorTimestamp, pageSize, principalUserId, cursorId);

        if (batch.length === 0) break; // no more messages

        for (const item of batch) {
          // F35: Skip whispers not intended for this cat
          if (!canViewMessage(item, viewer)) continue;
          // Visible in play mode: user messages, own cat's messages,
          // or other cats' messages that are NOT explicitly stream.
          // Legacy messages (no origin) are treated as visible for backward
          // compatibility — all new writes are tagged, so untagged = legacy callback.
          const isOtherCat = item.catId && item.catId !== principalCatId;
          if (!isOtherCat || item.origin !== 'stream') {
            if (!matchesExtraFilters(item)) continue;
            visible.push(item);
          }
        }

        // Move cursor to oldest message in batch (batch is ascending, first is oldest)
        const oldest = batch[0]!;
        cursorTimestamp = oldest.timestamp;
        cursorId = oldest.id;
      }

      // visible is accumulated in reverse-chronological page order but each page is ascending.
      // P2-1 fix: play mode also sorts by keyword relevance when keyword is active
      if (keywordTerms.length > 0) {
        visible.sort((a, b) => {
          const sa = scoreKeywordRelevance(a.content, keywordTerms);
          const sb = scoreKeywordRelevance(b.content, keywordTerms);
          return sb - sa || b.timestamp - a.timestamp;
        });
        filtered = visible.slice(0, requestedLimit);
      } else {
        visible.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
        filtered = visible.slice(-requestedLimit);
      }
    }

    // F073 P1: Look up workflow SOP for resume capsule if thread has linked backlog item
    // P1-3: Only expose workflowSop when the thread belongs to this user
    let workflowSop: Record<string, unknown> | undefined;
    if (effectiveThreadId && threadStore && opts.workflowSopStore) {
      const thread = await threadStore.get(effectiveThreadId);
      const isOwnThread = thread && (thread.createdBy === principalUserId || !overrideThreadId);
      if (isOwnThread && thread?.backlogItemId) {
        const sop = await opts.workflowSopStore.get(thread.backlogItemId);
        if (sop) {
          workflowSop = {
            featureId: sop.featureId,
            stage: sop.stage,
            batonHolder: sop.batonHolder,
            nextSkill: sop.nextSkill,
            resumeCapsule: sop.resumeCapsule,
            checks: sop.checks,
          };
        }
      }
    }

    return {
      // TD091: echo threadId so cats know which thread they're in
      threadId: effectiveThreadId,
      messages: filtered.map((item) => ({
        id: item.id,
        userId: item.userId,
        catId: item.catId,
        content: item.content,
        ...(item.contentBlocks ? { contentBlocks: item.contentBlocks } : {}),
        timestamp: item.timestamp,
        // F148 Phase B (AC-B2): include relevance score when keyword search is active
        ...(keywordTerms.length > 0 ? { relevanceScore: scoreKeywordRelevance(item.content, keywordTerms) } : {}),
      })),
      ...(workflowSop ? { workflowSop } : {}),
    };
  });

  app.get('/api/callbacks/fetch-thread-history', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = fetchThreadHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parsed.error.issues };
    }

    const {
      limit,
      threadId: overrideThreadId,
      fromMessageId,
      toMessageId,
      query,
      catId: filterCatId,
      maxTokens,
    } = parsed.data;

    if (filterCatId && filterCatId !== 'user' && !catRegistry.has(filterCatId)) {
      reply.status(400);
      return { error: `Unknown catId filter: ${filterCatId}` };
    }

    let effectiveThreadId: string;
    if (principal.kind === 'agent_key') {
      const threadResult = await resolvePrincipalThread(principal, overrideThreadId, { threadStore });
      if (!threadResult.ok) {
        reply.status(threadResult.statusCode);
        return { error: threadResult.error };
      }
      effectiveThreadId = threadResult.threadId;
    } else {
      effectiveThreadId = overrideThreadId ?? principal.threadId;
    }

    const configuredMessageCap = readBoundedIntEnv(
      'CAT_CAFE_HISTORY_FETCH_MAX_MESSAGES',
      DEFAULT_HISTORY_FETCH_MESSAGES,
      1,
      80,
    );
    const configuredTokenCap = readBoundedIntEnv(
      'CAT_CAFE_HISTORY_FETCH_MAX_TOKENS',
      DEFAULT_HISTORY_FETCH_MAX_TOKENS,
      500,
      20000,
    );
    const scanCap = readBoundedIntEnv(
      'CAT_CAFE_HISTORY_FETCH_MAX_SCAN_MESSAGES',
      DEFAULT_HISTORY_FETCH_SCAN_MESSAGES,
      50,
      2000,
    );
    const requestedLimit = limit ?? configuredMessageCap;
    const safeLimit = Math.min(requestedLimit, configuredMessageCap);
    const safeMaxTokens = Math.min(maxTokens ?? configuredTokenCap, configuredTokenCap);
    const principalCatId = principal.catId;
    const principalUserId = principal.userId;
    const resetBoundary = threadStore
      ? await Promise.resolve(threadStore.getContextResetBoundary(effectiveThreadId, principalUserId))
      : null;
    const resetAtMessageId = resetBoundary?.resetAtMessageId;

    let needsPlayFilter = false;
    if (threadStore) {
      const thread = await threadStore.get(effectiveThreadId);
      needsPlayFilter = !!thread && (thread.thinkingMode ?? 'debug') === 'play';
    }

    // Callback principals are cats in both debug and play modes. Keep whisper
    // authorization independent from the thinking-stream presentation mode.
    const viewer = { type: 'cat' as const, catId: createCatId(principalCatId) };
    const queryTerms = query ? tokenizeKeyword(query) : [];
    const isVisibleForFetch = (item: StoredMessage): boolean => {
      if (resetAtMessageId && item.id <= resetAtMessageId) return false;
      if (item.origin === 'briefing') return false;
      if (!canViewMessage(item, viewer)) return false;
      const isOtherCat = item.catId && item.catId !== principalCatId;
      if (needsPlayFilter && isOtherCat && item.origin === 'stream') return false;
      if (filterCatId) {
        if (filterCatId === 'user') {
          if (item.catId !== null) return false;
        } else if (item.catId !== filterCatId) {
          return false;
        }
      }
      if (queryTerms.length > 0 && scoreKeywordRelevance(item.content, queryTerms) === 0) return false;
      return true;
    };
    const isOwnThreadMessage = (item: StoredMessage): boolean =>
      item.threadId === effectiveThreadId && (item.userId === principalUserId || isSystemUserMessage(item));

    const fetchMessageById = async (messageId: string): Promise<StoredMessage | null> => {
      const msg = await messageStore.getById(messageId);
      if (!msg || !isOwnThreadMessage(msg) || (resetAtMessageId && msg.id <= resetAtMessageId)) return null;
      return msg;
    };

    let candidates: StoredMessage[] = [];
    let scanCount = 0;
    let mode: 'range' | 'query' | 'recent' = 'recent';

    if (fromMessageId || toMessageId) {
      mode = 'range';
      const fromMsg = fromMessageId ? await fetchMessageById(fromMessageId) : null;
      const toMsg = toMessageId ? await fetchMessageById(toMessageId) : null;
      if (fromMessageId && !fromMsg) {
        reply.status(404);
        return { error: 'fromMessageId not found in this thread' };
      }
      if (toMessageId && !toMsg) {
        reply.status(404);
        return { error: 'toMessageId not found in this thread' };
      }

      if (fromMsg && isVisibleForFetch(fromMsg)) candidates.push(fromMsg);

      const after = fromMessageId
        ? await messageStore.getByThreadAfter(effectiveThreadId, fromMessageId, safeLimit + 1, principalUserId)
        : toMsg
          ? await messageStore.getByThreadBefore(
              effectiveThreadId,
              toMsg.timestamp + 1,
              safeLimit,
              undefined,
              principalUserId,
            )
          : [];
      for (const item of after) {
        if (candidates.length >= safeLimit) break;
        if (toMessageId && item.id > toMessageId) break;
        if (!isVisibleForFetch(item)) continue;
        if (fromMessageId && item.id === fromMessageId) continue;
        candidates.push(item);
      }
    } else {
      mode = queryTerms.length > 0 ? 'query' : 'recent';
      const visible: StoredMessage[] = [];
      const pageSize = Math.max(safeLimit * 2, 50);
      let cursorTimestamp = Number.MAX_SAFE_INTEGER;
      let cursorId: string | undefined;

      while (visible.length < safeLimit && scanCount < scanCap) {
        const remainingScan = Math.max(1, scanCap - scanCount);
        const batch = await messageStore.getByThreadBefore(
          effectiveThreadId,
          cursorTimestamp,
          Math.min(pageSize, remainingScan),
          cursorId,
          principalUserId,
        );
        if (batch.length === 0) break;
        scanCount += batch.length;
        for (const item of batch) {
          if (!isVisibleForFetch(item)) continue;
          visible.push(item);
          if (visible.length >= safeLimit) break;
        }
        const oldest = batch[0]!;
        cursorTimestamp = oldest.timestamp;
        cursorId = oldest.id;
      }

      if (queryTerms.length > 0) {
        visible.sort((a, b) => {
          const sa = scoreKeywordRelevance(a.content, queryTerms);
          const sb = scoreKeywordRelevance(b.content, queryTerms);
          return sb - sa || b.timestamp - a.timestamp;
        });
        candidates = visible.slice(0, safeLimit);
      } else {
        visible.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
        candidates = visible.slice(-safeLimit);
      }
    }

    const messages: Array<{
      id: string;
      userId: string;
      catId: string | null;
      content: string;
      timestamp: number;
      estimatedTokens: number;
      relevanceScore?: number;
      contentTruncated?: boolean;
    }> = [];
    let estimatedTokens = 0;
    let byTokens = false;
    for (const item of candidates) {
      const sanitized = sanitizeHistoryFetchContent(item.content);
      const itemTokens = estimateHistoryFetchTokens(sanitized);
      if (estimatedTokens + itemTokens > safeMaxTokens) {
        byTokens = true;
        if (messages.length === 0) {
          const charBudget = Math.max(200, safeMaxTokens * 4);
          const truncatedContent =
            sanitized.length > charBudget
              ? `${sanitized.slice(0, charBudget)}\n[...truncated by maxTokens...]`
              : sanitized;
          const truncatedTokens = estimateHistoryFetchTokens(truncatedContent);
          messages.push({
            id: item.id,
            userId: item.userId,
            catId: item.catId,
            content: truncatedContent,
            timestamp: item.timestamp,
            estimatedTokens: truncatedTokens,
            ...(queryTerms.length > 0 ? { relevanceScore: scoreKeywordRelevance(item.content, queryTerms) } : {}),
            contentTruncated: true,
          });
          estimatedTokens += truncatedTokens;
        }
        break;
      }
      messages.push({
        id: item.id,
        userId: item.userId,
        catId: item.catId,
        content: sanitized,
        timestamp: item.timestamp,
        estimatedTokens: itemTokens,
        ...(queryTerms.length > 0 ? { relevanceScore: scoreKeywordRelevance(item.content, queryTerms) } : {}),
      });
      estimatedTokens += itemTokens;
    }

    return {
      threadId: effectiveThreadId,
      mode,
      messages,
      messageCount: messages.length,
      estimatedTokens,
      limits: {
        messages: safeLimit,
        maxTokens: safeMaxTokens,
        scanMessages: scanCap,
      },
      truncated: {
        byMessages: candidates.length > messages.length || requestedLimit > safeLimit,
        byTokens,
        byScanCap: mode !== 'range' && scanCount >= scanCap && messages.length < safeLimit,
      },
      guidance:
        'These original messages are on-demand history. Treat estimatedTokens as consumed context budget; narrow the range/query before fetching more.',
    };
  });

  app.get('/api/callbacks/message-search', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = messageSearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parsed.error.issues };
    }

    const { q, limit, threadId: requestedThreadId, catId: filterCatId } = parsed.data;

    if (filterCatId && filterCatId !== 'user' && !catRegistry.has(filterCatId)) {
      reply.status(400);
      return { error: `Unknown catId filter: ${filterCatId}` };
    }

    let effectiveThreadId = requestedThreadId;
    if (principal.kind === 'agent_key' && requestedThreadId) {
      const threadResult = await resolvePrincipalThread(principal, requestedThreadId, { threadStore });
      if (!threadResult.ok) {
        reply.status(threadResult.statusCode);
        return { error: threadResult.error };
      }
      effectiveThreadId = threadResult.threadId;
    }

    const requestedLimit = limit ?? 20;
    const queryTerms = tokenizeKeyword(q);
    const normalizedQuery = q.toLowerCase();
    const principalCatId = principal.catId;
    const principalUserId = principal.userId;
    const viewer = { type: 'cat' as const, catId: createCatId(principalCatId) };
    const threadTitleCache = new Map<string, string>();
    const recentMessages = await messageStore.getRecent(10000);

    const compactQuery = normalizedQuery.replace(/\s+/g, '');
    const getSearchScore = (content: string): number => {
      const relevanceScore = scoreKeywordRelevance(content, queryTerms);
      if (relevanceScore > 0) return relevanceScore;
      const lower = content.toLowerCase();
      if (lower.includes(normalizedQuery)) return 1;
      if (compactQuery && lower.replace(/\s+/g, '').includes(compactQuery)) return 1;
      return 0;
    };

    const matchesAuthorFilter = (item: StoredMessage): boolean => {
      if (!filterCatId) return true;
      if (filterCatId === 'user') return item.catId === null;
      return item.catId === filterCatId;
    };

    const visibleCandidates = recentMessages.filter((item) => {
      if (!isMessageVisibleToPrincipalUser(item, principalUserId)) return false;
      if (!canViewMessage(item, viewer)) return false;
      if (effectiveThreadId && item.threadId !== effectiveThreadId) return false;
      return true;
    });
    const boundaryByThread = new Map<string, string | undefined>();
    if (threadStore) {
      await Promise.all(
        [...new Set(visibleCandidates.map((item) => item.threadId))].map(async (threadId) => {
          const boundary = await Promise.resolve(threadStore.getContextResetBoundary(threadId, principalUserId));
          boundaryByThread.set(threadId, boundary?.resetAtMessageId);
        }),
      );
    }

    const rawMatches = visibleCandidates
      .filter((item) => {
        const resetAtMessageId = boundaryByThread.get(item.threadId);
        if (resetAtMessageId && item.id <= resetAtMessageId) return false;
        if (item.origin === 'briefing') return false;
        if (!matchesAuthorFilter(item)) return false;
        if (!item.content?.trim()) return false;
        return getSearchScore(item.content) > 0;
      })
      .sort((a, b) => {
        const scoreDelta = getSearchScore(b.content) - getSearchScore(a.content);
        return scoreDelta || b.timestamp - a.timestamp || b.id.localeCompare(a.id);
      })
      .slice(0, requestedLimit);

    const messages = await Promise.all(
      rawMatches.map(async (item) => ({
        id: item.id,
        threadId: item.threadId,
        threadTitle: await resolveCallbackThreadTitle(threadStore, item.threadId, threadTitleCache),
        userId: item.userId,
        catId: item.catId,
        content: item.content,
        timestamp: item.timestamp,
        ...(item.editedAt ? { editedAt: item.editedAt } : {}),
        relevanceScore: getSearchScore(item.content),
        type: (item.catId
          ? isSystemUserMessage(item)
            ? 'system'
            : 'assistant'
          : item.source
            ? 'connector'
            : isSystemUserMessage(item)
              ? 'system'
              : 'user') as 'user' | 'assistant' | 'connector' | 'system',
      })),
    );

    return {
      query: q,
      messages,
    };
  });

  app.get('/api/callbacks/list-threads', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    const parsed = listThreadsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { limit, activeSince, keyword } = parsed.data;

    if (!threadStore) {
      reply.status(503);
      return { error: 'Thread store not configured' };
    }

    const requestedLimit = limit ?? 20;
    let threads = await threadStore.list(principal.userId);
    if (activeSince !== undefined) {
      threads = threads.filter((thread) => thread.lastActiveAt >= activeSince);
    }
    if (keyword) {
      const needle = keyword.toLowerCase();
      threads = threads.filter((thread) => {
        const title = (thread.title ?? '').toLowerCase();
        return title.includes(needle) || thread.id.toLowerCase().includes(needle);
      });
    }

    threads.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const summaries = threads.slice(0, requestedLimit).map((thread) => ({
      threadId: thread.id,
      ...(thread.title ? { title: thread.title } : {}),
      lastActiveAt: thread.lastActiveAt,
      pinned: thread.pinned ?? false,
      messageCount: null,
      participants: thread.participants,
    }));

    return { threads: summaries };
  });

  app.get('/api/callbacks/feat-index', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = featIndexQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request query', details: parsed.error.issues };
    }

    const { featId, query, limit } = parsed.data;

    const normalizedFeatId = featId ? normalizeFeatId(featId) : undefined;
    const normalizedQuery = query?.trim().toLowerCase();
    const threadIdsByFeatId = await buildThreadIdsByFeatId(threadStore, backlogStore, record.userId, app.log);

    let items = await (featIndexProvider ? featIndexProvider() : readFeatIndexEntries());
    if (normalizedFeatId) {
      items = items.filter((item) => normalizeFeatId(item.featId) === normalizedFeatId);
    }
    if (normalizedQuery) {
      items = items.filter((item) => {
        const haystack = `${item.featId} ${item.name} ${item.status}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      });
    }

    const requestedLimit = limit ?? 20;
    const sliced = items.slice(0, requestedLimit);
    return {
      items: sliced.map((item) => ({
        featId: item.featId,
        name: item.name,
        status: item.status,
        ...(item.keyDecisions ? { keyDecisions: item.keyDecisions } : {}),
        threadIds: threadIdsByFeatId.get(normalizeFeatId(item.featId)) ?? [],
      })),
    };
  });

  // TD091: PR tracking registration via MCP callback
  // Cats call this after `gh pr create` to register the PR for Layer 1 routing.
  // Server resolves threadId from invocation record — cat doesn't need to know it.
  const registerPrTrackingSchema = z.object({
    repoFullName: z
      .string()
      .min(1)
      .regex(/^[^/]+\/[^/]+$/, 'Must be owner/repo format'),
    prNumber: z.number().int().positive(),
    catId: z.string().min(1).optional(), // ignored — server uses record.catId
  });

  app.post('/api/callbacks/register-pr-tracking', async (request, reply) => {
    // #320: Unified model — write to TaskStore instead of PrTrackingStore
    if (!taskStore) {
      reply.status(503);
      return { error: 'Task store not configured' };
    }

    const parsed = registerPrTrackingSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const { repoFullName, prNumber } = parsed.data;

    // Use authoritative catId from invocation record, not caller payload.
    const catId = record.catId;

    // Phase D: validate repo exists and is accessible (AC-D1)
    if (validateRepo) {
      let repoOk: boolean;
      try {
        repoOk = await validateRepo(repoFullName);
      } catch {
        reply.status(503);
        return { error: 'Repository validation unavailable — try again later' };
      }
      if (!repoOk) {
        reply.status(422);
        return { error: `Repository ${repoFullName} does not exist or is not accessible` };
      }
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: opts.freshnessGate,
      registry,
      record,
      route: 'register-pr-tracking',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return freshness.response;

    const subjectKey = `pr:${repoFullName}#${prNumber}`;
    try {
      const task = await taskStore.upsertBySubject({
        kind: 'pr_tracking',
        subjectKey,
        threadId: record.threadId,
        title: `PR tracking: ${repoFullName}#${prNumber}`,
        ownerCatId: catId,
        why: `Tracking PR ${repoFullName}#${prNumber} for review feedback, CI/CD, and conflict detection`,
        createdBy: catId,
        userId: record.userId,
      });

      return { status: 'ok', threadId: record.threadId, task };
    } catch (error) {
      if (isSubjectOwnershipConflictError(error)) {
        reply.status(409);
        return { error: `PR ${repoFullName}#${prNumber} already registered by another user` };
      }
      throw error;
    }
  });

  // F174 Phase C: refresh-token endpoint — keep tokens alive in long sessions
  // where猫 has no incidental tool calls. Heartbeat = empty verify (preHandler
  // slides TTL via Phase B mechanism); we just compute remaining TTL.
  //
  // P1 fix (gpt52 review): cooldown MUST run before app-level preHandler.
  // Otherwise verify() in preHandler已经 slides TTL even on rate-limited
  // requests → 429 is cosmetic, abuser still extends. Route-level onRequest
  // hook fires before plugin-scoped preHandler in Fastify's lifecycle, so we
  // claim the cooldown there and reply.send → preHandler is short-circuited.
  const REFRESH_COOLDOWN_MS = 5 * 60_000;
  app.post(
    '/api/callbacks/refresh-token',
    {
      preValidation: async (request, reply) => {
        // Cloud Codex P1 + gpt52 P1 #2/#3 (#1368): cooldown must mirror auth
        // — same creds extraction rule as preHandler, then peek (no-slide)
        // verify, claim cooldown, then atomic verifyLatest (replaces global
        // preHandler verify so stale-check + slide happen in one step).
        //
        // Cloud Codex P2 (08:54Z #1368): isLatest check in preValidation +
        // separate slide in preHandler had a race window — newer invocation
        // could win between hooks. verifyLatest closes it atomically.
        //
        // Hook stage: preValidation fires AFTER body parse and BEFORE all
        // preHandler hooks — body/query is accessible AND we can short-circuit
        // before app preHandler runs verify-with-slide.
        const creds = extractCallbackCredentials(request);
        if (!creds) {
          // Cloud Codex P2 (PR #1368, 6c8a4365): refresh-token route always
          // requires auth — no panel-path here. Global preHandler no-ops on
          // total absence (panel-path), which would let handler fall through
          // to unknown_invocation and misclassify the reason. Emit
          // missing_creds locally to keep telemetry/diagnostics accurate.
          recordCallbackAuthFailure({ reason: 'missing_creds', tool: 'refresh-token' });
          reply.status(401).send({
            error: 'callback_auth_failed',
            reason: 'missing_creds',
            message: 'refresh-token requires X-Invocation-Id + X-Callback-Token headers',
            hint: 'Both headers must be sent together; mixed-source (header + body) is not accepted.',
          });
          return;
        }

        const peeked = await registry.peek(creds.invocationId, creds.callbackToken);
        if (!peeked.ok) {
          // Let preHandler emit the corresponding reason 401 (no cooldown burned).
          // preHandler's verify() path records the failure; we don't double-record here.
          return;
        }

        const cooldownClaimed = await registry.tryClaimRefreshCooldown(creds.invocationId, REFRESH_COOLDOWN_MS);
        if (!cooldownClaimed) {
          reply.status(429).send({ error: 'refresh_rate_limited', retryAfterMs: REFRESH_COOLDOWN_MS });
          // reply.send short-circuits the lifecycle — preHandler/handler skipped,
          // so verify() never slides TTL for the rate-limited request.
          return;
        }

        // Atomic: verify token + check stale + slide TTL in one backend op.
        // Replaces global preHandler.verify for this route (we set
        // request.callbackAuth so the preHandler early-returns).
        const result = await registry.verifyLatest(creds.invocationId, creds.callbackToken);
        if (!result.ok) {
          const catId = peeked.ok ? peeked.record.catId : undefined;
          recordCallbackAuthFailure({ reason: result.reason, tool: 'refresh-token', catId });
          if (result.reason === 'stale_invocation') {
            reply.status(401).send({
              error: 'callback_auth_failed',
              reason: 'stale_invocation',
              message: 'Invocation has been superseded by a newer one for the same thread/cat slot',
              hint: 'A newer invocation now owns this (threadId, catId) slot. Old invocations cannot be refreshed.',
            });
            return;
          }
          // expired / invalid_token / unknown_invocation — race against expiry
          // or registry mutation between peek and verifyLatest. Surface the
          // structured reason directly (we own the auth path now, preHandler
          // will skip via the request.callbackAuth check).
          reply.status(401).send({
            error: 'callback_auth_failed',
            reason: result.reason,
            message: 'Auth state changed between peek and atomic verify',
            hint: '',
          });
          return;
        }
        request.callbackAuth = result.record;
      },
    },
    async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return; // preHandler already 401'd

      // preHandler's verify() already slid the record TTL forward.
      // Re-fetch to get the new expiresAt without triggering another slide.
      const fresh = await registry.getRecord(record.invocationId);
      if (!fresh) {
        recordCallbackAuthFailure({ reason: 'unknown_invocation', tool: 'refresh-token', catId: record.catId });
        reply.status(401);
        return {
          error: 'callback_auth_failed',
          reason: 'unknown_invocation',
          message: 'Invocation vanished between preHandler verify and refresh re-fetch',
          hint: '',
        };
      }
      const ttlRemainingMs = Math.max(0, fresh.expiresAt - Date.now());
      return { ok: true, expiresAt: fresh.expiresAt, ttlRemainingMs };
    },
  );

  // F22: Rich block creation via MCP callback
  app.post('/api/callbacks/create-rich-block', async (request, reply) => {
    // #85 M2b: normalize block before Zod parse (type→kind, auto v:1)
    const rawBody = request.body as Record<string, unknown>;
    if (rawBody && typeof rawBody === 'object' && rawBody.block) {
      normalizeRichBlock(rawBody.block);
    }

    const parsed = createRichBlockSchema.safeParse(rawBody);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const { block } = parsed.data;
    const { invocationId } = record;
    // #573: parent (outer) id used for broadcast identity to align with stream/queue path.
    const effectiveInvId = record.parentInvocationId ?? invocationId;

    // F34-b P2: audio blocks must have at least url or text (R10: trim whitespace)
    if (block.kind === 'audio' && !block.url?.trim() && !block.text?.trim()) {
      reply.status(400);
      return { error: 'audio block requires url or text' };
    }

    if (!(await registry.isLatest(invocationId))) {
      return { status: 'stale_ignored' };
    }

    const freshnessProtected = Boolean(opts.freshnessGate && record.freshnessBaseline);

    // Legacy callbacks keep eager synthesis. Protected blocks remain private and
    // are synthesized only after the final message publication verdict.
    let resolvedBlock: RichBlock = block as unknown as RichBlock;
    const synthesizer = getVoiceBlockSynthesizer();
    if (!freshnessProtected && synthesizer && block.kind === 'audio' && 'text' in block) {
      const resolved = await synthesizer.resolveVoiceBlocks([block as unknown as RichBlock], record.catId as string);
      if (resolved.length > 0) resolvedBlock = resolved[0]!;
    }

    // Buffer the block — consumed at append time in route-serial/route-parallel
    const isNew = getRichBlockBuffer().add(record.threadId, record.catId as string, resolvedBlock, invocationId);

    // Only broadcast new blocks (dedup retries at server to prevent frontend duplicates)
    // #454/573: include effectiveInvId (parent/outer) so frontend can exact-match
    // callback to stream bubble.
    if (isNew && !freshnessProtected) {
      socketManager.broadcastAgentMessage(
        {
          type: 'system_info' as const,
          catId: record.catId,
          content: JSON.stringify({ type: 'rich_block', block: resolvedBlock }),
          invocationId: effectiveInvId,
          timestamp: Date.now(),
        },
        record.threadId,
      );
    }

    // F182 AC-C1: A class — routing_warnings + KD-7 message (rich blocks have no routing targets)
    return { status: 'ok', routing_warnings: [], message: '富文本块已创建。' };
  });

  // F079 Gap 4: Cat-initiated vote via MCP callback
  const startVoteCallbackSchema = z.object({
    question: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(100)).min(2).max(20),
    anonymous: z.boolean().optional().default(false),
    timeoutSec: z.number().int().min(10).max(600).optional().default(120),
    voters: z.array(z.string().min(1).max(50)).min(1).max(20),
  });

  app.post('/api/callbacks/start-vote', async (request, reply) => {
    if (!threadStore) {
      reply.status(503);
      return { error: 'Thread store not configured' };
    }

    const parsed = startVoteCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const { question, options, anonymous, timeoutSec, voters } = parsed.data;

    // P2 fix: verify thread exists
    const thread = await threadStore.get(record.threadId);
    if (!thread) {
      reply.status(404);
      return { error: '对话不存在', code: 'THREAD_NOT_FOUND' };
    }

    // F182 AC-C2: B class — validate all voters are available, collect resolved canonical catIds
    const resolvedVoters: CatId[] = [];
    for (const voter of voters) {
      const resolved = resolveCatTarget(voter);
      if ('error' in resolved) {
        reply.status(400);
        return resolved.error;
      }
      resolvedVoters.push(createCatId(resolved.ok));
    }

    const freshness = await claimCallbackSideEffect({
      freshnessGate: opts.freshnessGate,
      registry,
      record,
      route: 'start-vote',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return freshness.response;

    // Legacy invocations keep the pre-F193 latest-invocation behavior.
    if (freshness.outcome === 'legacy' && !(await registry.isLatest(record.invocationId))) {
      return { status: 'stale_ignored' };
    }

    // Check for existing active vote
    const existing = await threadStore.getVotingState(record.threadId);
    if (existing && existing.status === 'active') {
      if (freshness.outcome === 'authorized') await freshness.abort();
      reply.status(409);
      return { error: '已有活跃投票', code: 'VOTE_ALREADY_ACTIVE' };
    }

    // P1-1 fix: createdBy must be userId (closeVoteInternal uses it as message userId).
    // initiatedByCat tracks which cat started the vote (for display purposes).
    const votingState: VotingStateV1 = {
      v: 1,
      question,
      options,
      votes: {},
      anonymous,
      deadline: Date.now() + timeoutSec * 1000,
      createdBy: record.userId,
      status: 'active',
      voters: resolvedVoters,
      initiatedByCat: record.catId as string,
    };

    await threadStore.updateVotingState(record.threadId, votingState);

    // Register timeout auto-close (shared timer map with votes.ts)
    clearVoteTimer(record.threadId);
    const timer = setTimeout(() => {
      closeVoteInternal(record.threadId, threadStore, socketManager, messageStore).catch((err) => {
        log.error({ threadId: record.threadId, err }, 'Timeout auto-close failed');
      });
    }, timeoutSec * 1000);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    voteTimers.set(record.threadId, timer);

    socketManager.broadcastToRoom(`thread:${record.threadId}`, 'vote_started', {
      threadId: record.threadId,
      votingState,
    });

    // Send notification message to each voter (so they see the vote request in chat)
    const notificationContent = buildVoteNotification(question, options);
    const mentionCatIds = resolvedVoters;
    let notificationMsg: Awaited<ReturnType<typeof messageStore.append>> | undefined;
    try {
      notificationMsg = await messageStore.append({
        userId: record.userId,
        catId: record.catId,
        content: notificationContent,
        mentions: mentionCatIds,
        origin: 'callback',
        timestamp: Date.now(),
        threadId: record.threadId,
      });
    } catch (err) {
      log.warn({ err }, 'Failed to persist vote notification');
    }

    // Dispatch voter cats so they receive the notification and can vote.
    // Uses enqueueA2ATargets (standard A2A dispatch, NOT multi_mention depth guard).
    // If queue overflows (>MAX_QUEUE_DEPTH), falls back to direct dispatch for remaining voters.
    if (notificationMsg && router && invocationRecordStore) {
      const a2aDeps = {
        router,
        invocationRecordStore,
        socketManager,
        messageStore,
        invocationTracker,
        deliveryCursorStore,
        queueProcessor,
        invocationQueue: opts.invocationQueue,
        log: app.log,
      };
      const a2aOpts = {
        targetCats: mentionCatIds,
        content: notificationContent,
        userId: record.userId,
        threadId: record.threadId,
        triggerMessage: notificationMsg,
        callerCatId: record.catId as CatId,
        callerTraceContext: record.traceContext,
      };
      try {
        const { enqueued } = await enqueueA2ATargets(a2aDeps, a2aOpts);
        // Fallback: voters that hit queue capacity limit → direct dispatch
        const missed = mentionCatIds.filter((c) => !enqueued.includes(c));
        if (missed.length > 0) {
          app.log.info(
            { threadId: record.threadId, missed, enqueued },
            '[callbacks/start-vote] Queue overflow: falling back to direct dispatch for remaining voters',
          );
          await triggerA2AInvocation(a2aDeps, { ...a2aOpts, targetCats: missed });
        }
      } catch (err) {
        app.log.warn(`[callbacks/start-vote] Failed to dispatch voter invocations: ${String(err)}`);
      }
    }

    return { status: 'ok', threadId: record.threadId, votingState };
  });

  if (taskStore) {
    registerCallbackTaskRoutes(app, {
      registry,
      taskStore,
      socketManager,
      messageStore,
      ...(threadStore ? { threadStore } : {}),
      ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
    });
  }

  if (opts.workflowSopStore && opts.backlogStore) {
    registerCallbackWorkflowSopRoutes(app, {
      registry,
      workflowSopStore: opts.workflowSopStore,
      backlogStore: opts.backlogStore,
      ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
    });
  }

  // F087: Bootcamp state transition callbacks
  if (opts.threadStore) {
    registerCallbackBootcampRoutes(app, {
      registry,
      threadStore: opts.threadStore,
      socketManager,
      ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
    });
  }

  // F171: First-Run Quest state transition callbacks
  if (opts.threadStore) {
    registerCallbackQuestRoutes(app, {
      registry,
      threadStore: opts.threadStore,
      ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
    });
  }

  if (opts.holdBallDeps) {
    registerCallbackHoldBallRoutes(app, {
      ...opts.holdBallDeps,
      ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
    });
  }

  // Thread cats discovery for MCP
  if (opts.threadStore && opts.agentRegistry) {
    registerCallbackThreadCatsRoutes(app, {
      threadStore: opts.threadStore,
      agentRegistry: opts.agentRegistry,
    });
  }

  await registerCallbackMemoryRoutes(app, {
    registry,
    evidenceStore: opts.evidenceStore,
    markerQueue: opts.markerQueue,
    reflectionService: opts.reflectionService,
    ...(opts.markerQueueRouter ? { markerQueueRouter: opts.markerQueueRouter } : {}),
    ...(opts.threadStore ? { threadStore: opts.threadStore } : {}),
    ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
  });

  // F126: Limb node callback routes
  if (opts.limbRegistry) {
    registerCallbackLimbRoutes(app, {
      registry,
      limbRegistry: opts.limbRegistry,
      pairingStore: opts.limbPairingStore,
      ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
    });
  }

  // F086: Multi-mention orchestration routes
  if (router && invocationRecordStore) {
    registerMultiMentionRoutes(app, {
      registry,
      messageStore,
      socketManager,
      router,
      invocationRecordStore,
      ...(invocationTracker ? { invocationTracker } : {}),
      ...(opts.invocationQueue ? { invocationQueue: opts.invocationQueue } : {}),
      ...(queueProcessor ? { queueProcessor } : {}),
      ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
    });
    // Wire orchestrator into SocketManager for cancel propagation (P1-1 fix)
    if (typeof socketManager.setMultiMentionOrchestrator === 'function') {
      socketManager.setMultiMentionOrchestrator(getMultiMentionOrchestrator());
    }
  }

  // F088 Phase J2: Document generation callback routes
  registerCallbackDocumentRoutes(app, {
    registry,
    socketManager,
    ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
  });

  // F162: WeChat Work enterprise action callback routes
  registerCallbackWeComActionRoutes(app, {
    registry,
    ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
  });

  // F162 Phase B: Lark/Feishu enterprise action callback routes
  registerCallbackLarkActionRoutes(app, {
    registry,
    ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
  });

  // F101: Game action callback for non-Claude cats (OpenCode/Codex/Gemini)
  registerCallbackGameRoutes(app, {
    registry,
    ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
  });

  // F155: Guide engine — state-validated routes with ThreadStore authority
  if (opts.threadStore) {
    await registerCallbackGuideRoutes(app, {
      registry,
      threadStore: opts.threadStore,
      socketManager,
      ...(opts.guideSessionStore ? { guideSessionStore: opts.guideSessionStore } : {}),
      ...(opts.loadGuideFlow ? { loadGuideFlow: opts.loadGuideFlow } : {}),
      ...(opts.getGuideAvailabilityContext ? { getGuideAvailabilityContext: opts.getGuideAvailabilityContext } : {}),
      ...(opts.freshnessGate ? { freshnessGate: opts.freshnessGate } : {}),
    });
  }
};
