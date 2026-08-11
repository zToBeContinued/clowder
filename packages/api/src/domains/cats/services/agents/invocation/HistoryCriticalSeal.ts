import type { CatId, SessionRecord } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import { validateProjectPath } from '../../../../../utils/project-path.js';
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { AgentMessage } from '../../types.js';
import { autoUpdateAgentMemory } from '../memory/AgentMemoryAutoWriter.js';
import type { HistoryCriticalSealIntent } from '../routing/route-helpers.js';
import { completeCapsuleForSeal, type RouteStateContinuityCapsule } from './CollaborationContinuityCapsule.js';
import type { InvocationDeps } from './invoke-single-cat.js';

const log = createModuleLogger('history-critical-seal');

export interface HistoryCriticalSealInput {
  deps: InvocationDeps;
  intent: HistoryCriticalSealIntent;
  userId: string;
  catId: CatId;
  threadId: string;
  invocationId?: string;
  currentUserMessageId?: string;
  assistantText: string;
  projectPath?: string;
  continuityCapsule: RouteStateContinuityCapsule;
}

async function forceCriticalMemoryWriteback(input: HistoryCriticalSealInput): Promise<void> {
  const { intent, catId, threadId } = input;
  let projectRoot: string | null = null;
  if (input.projectPath && input.projectPath !== 'default' && !input.projectPath.startsWith('games/')) {
    try {
      projectRoot = await validateProjectPath(input.projectPath);
    } catch (err) {
      log.warn(
        { threadId, catId: catId as string, projectPath: input.projectPath, err },
        'critical memory project path rejected; falling back to writer host root',
      );
    }
  }
  try {
    await autoUpdateAgentMemory(
      {
        catId,
        invocationId: input.invocationId ?? `history-critical:${intent.watermark}`,
        threadId,
        ...(input.currentUserMessageId ? { currentUserMessageId: input.currentUserMessageId } : {}),
        assistantText: input.assistantText,
        completedAt: Date.now(),
      },
      // 改为项目分片（集中在 Clowder 根）：此前把 projectRoot 重定向到外部项目，
      // 记忆写进外部项目的 .cat-cafe/memory/ 却从不被读回（读取侧只读 Clowder 根），
      // 既落盘污染又白写。分片与常规 auto-write 同一位置，读取侧可见。
      { ...(projectRoot ? { projectPath: projectRoot } : {}), force: true },
    );
  } catch (err) {
    log.warn(
      { threadId, catId: catId as string, invocationId: input.invocationId, err },
      'critical memory writeback failed; continuing with session seal',
    );
  }
}

async function completeAcceptedHistoryCriticalSeal(
  input: HistoryCriticalSealInput,
  activeRecord: SessionRecord,
  sessionSealer: ISessionSealer,
): Promise<AgentMessage> {
  const { deps, intent, userId, catId, threadId } = input;
  try {
    await deps.sessionManager.delete(userId, catId, threadId);
  } catch (err) {
    log.warn(
      { threadId, catId: catId as string, invocationId: input.invocationId, err },
      'history-critical seal accepted but CLI resume pointer cleanup failed',
    );
  }

  const sealTimestamp = Date.now();
  const continuityCapsule = completeCapsuleForSeal(input.continuityCapsule, {
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    createdAt: sealTimestamp,
    seal: {
      sessionId: activeRecord.id,
      sessionSeq: activeRecord.seq + 1,
      reason: intent.reason,
      healthSnapshot: {
        historyBudgetRatio: intent.historyBudgetRatio,
        criticalRatio: intent.criticalRatio,
        summaryWatermarkMessageId: intent.watermark,
      },
    },
  });
  const sealInfoMessage: AgentMessage = {
    type: 'system_info',
    catId,
    content: JSON.stringify({
      type: 'session_seal_requested',
      catId,
      sessionId: activeRecord.id,
      sessionSeq: activeRecord.seq + 1,
      reason: intent.reason,
      healthSnapshot: continuityCapsule.seal?.healthSnapshot,
      continuityCapsule,
      continuityDiagnostics: {
        source: 'route_state',
        boundary: continuityCapsule.continuationReason,
        generated: true,
        persistedVia: 'session_seal_requested',
        threadId,
        catId,
        invocationId: input.invocationId,
        sessionId: activeRecord.id,
      },
    }),
    ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    timestamp: sealTimestamp,
  };

  try {
    deps.transcriptWriter?.appendEvent(
      {
        sessionId: activeRecord.id,
        threadId,
        catId: activeRecord.catId,
        cliSessionId: activeRecord.cliSessionId,
        seq: activeRecord.seq,
      },
      sealInfoMessage as unknown as Record<string, unknown>,
      input.invocationId,
    );
  } catch (err) {
    log.error(
      { threadId, catId: catId as string, sessionId: activeRecord.id, err },
      'history-critical capsule transcript append failed after seal acceptance',
    );
  }
  try {
    await sessionSealer.finalize({ sessionId: activeRecord.id });
  } catch (err) {
    log.error(
      { threadId, catId: catId as string, sessionId: activeRecord.id, err },
      'history-critical session finalize failed after seal acceptance',
    );
  }
  return sealInfoMessage;
}

/**
 * F004: After a critical reply has been durably published, force its memory
 * writeback and seal the active session exactly once per summary watermark.
 */
export async function finalizeHistoryCriticalPublication(
  input: HistoryCriticalSealInput,
): Promise<AgentMessage | null> {
  const { deps, intent, userId, catId, threadId } = input;
  await forceCriticalMemoryWriteback(input);

  const threadStore = deps.threadStore;
  const sessionChainStore = deps.sessionChainStore;
  const sessionSealer = deps.sessionSealer;
  if (!threadStore || !sessionChainStore || !sessionSealer) {
    log.warn(
      { threadId, catId: catId as string, watermark: intent.watermark },
      'history-critical seal skipped because durable session dependencies are unavailable',
    );
    return null;
  }

  const claim = await threadStore.claimHistoryCriticalSeal(threadId, catId as string, intent.watermark);
  if (!claim.claimed) return null;

  // A provider threshold may already have sealed this invocation's session.
  // Keep the watermark consumed so a newly-created session cannot be sealed
  // again by the same summary boundary on the next invocation.
  let activeRecord: SessionRecord | null;
  try {
    activeRecord = await sessionChainStore.getActive(catId, threadId);
  } catch (err) {
    await Promise.resolve(threadStore.rollbackHistoryCriticalSeal(threadId, catId as string, claim));
    throw err;
  }
  if (!activeRecord) return null;
  if (activeRecord.userId !== userId) {
    await Promise.resolve(threadStore.rollbackHistoryCriticalSeal(threadId, catId as string, claim));
    log.warn(
      { threadId, catId: catId as string, activeUserId: activeRecord.userId, requestedUserId: userId },
      'history-critical seal skipped because the active session belongs to another user',
    );
    return null;
  }

  let sealResult: Awaited<ReturnType<ISessionSealer['requestSeal']>>;
  try {
    sealResult = await sessionSealer.requestSeal({
      sessionId: activeRecord.id,
      reason: intent.reason,
    });
  } catch (err) {
    await Promise.resolve(threadStore.rollbackHistoryCriticalSeal(threadId, catId as string, claim)).catch(
      () => undefined,
    );
    throw err;
  }
  if (!sealResult.accepted) {
    await threadStore.rollbackHistoryCriticalSeal(threadId, catId as string, claim);
    return null;
  }
  return completeAcceptedHistoryCriticalSeal(input, activeRecord, sessionSealer);
}
