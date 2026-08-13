import type { CatId, TaskEvent, TaskItem } from '@cat-cafe/shared';
import { hmacId } from '../../../../infrastructure/telemetry/hmac.js';
import type { LocalTraceStore, TraceSpanDTO } from '../../../../infrastructure/telemetry/local-trace-store.js';
import type {
  IInvocationRecordStore,
  InvocationPhase,
  InvocationRecord,
  InvocationStatus,
} from '../stores/ports/InvocationRecordStore.js';
import type { IMessageStore, StoredMessage, StoredToolEvent } from '../stores/ports/MessageStore.js';
import type { ITaskStore } from '../stores/ports/TaskStore.js';
import type { TokenUsage } from '../types.js';

export type RunLedgerEventType =
  | 'created'
  | 'queued'
  | 'dequeued'
  | 'context_started'
  | 'context_ready'
  | 'runtime_starting'
  | 'runtime_ready'
  | 'first_token'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'tool_usage'
  | 'artifact_delta'
  | 'usage_recorded'
  | 'compact_boundary'
  | 'message_persisted'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'recovered';

export interface RunLedgerEvent {
  id: string;
  invocationId: string;
  ts: number;
  seq: number;
  type: RunLedgerEventType;
  actor: 'system' | 'user' | CatId;
  severity: 'info' | 'warning' | 'error';
  data: Record<string, unknown>;
}

export interface RunLedgerSummary {
  invocationId: string;
  threadId: string;
  userMessageId: string | null;
  assistantMessageId?: string;
  taskId?: string;
  targetCats: CatId[];
  status: InvocationStatus;
  phase: InvocationPhase;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  failureClass?:
    | 'agent_error'
    | 'build_failed'
    | 'test_failed'
    | 'timeout'
    | 'infra_error'
    | 'manual_fail'
    | 'process_restart'
    | 'runtime_hung'
    | 'runtime_spawn_failed'
    | 'budget_exhausted'
    | 'tool_failed'
    | 'user_canceled'
    | 'unknown';
  usage?: Pick<
    TokenUsage,
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadTokens'
    | 'cacheCreationTokens'
    | 'costUsd'
    | 'historyMode'
    | 'historyFullTokens'
    | 'historySummaryTokens'
    | 'historyBudgetRatio'
    | 'summarySegmentId'
    | 'historyGovernanceDegraded'
    | 'deliveryOnlyMode'
    | 'deliveryOnlyDegradedIssue'
    | 'budgetGateTriggered'
    | 'historyFullTokensBeforeGate'
  >;
  artifactCount?: number;
  toolCallCount?: number;
  traceId?: string;
}

export interface RunLedgerResponse {
  summary: RunLedgerSummary;
  events: RunLedgerEvent[];
  sources: {
    invocationRecord: boolean;
    messages: number;
    taskEvents: number;
    trace: boolean;
  };
  degraded?: {
    reason: string;
    missingSources: string[];
  };
}

interface DraftEvent {
  ts: number;
  type: RunLedgerEventType;
  actor: RunLedgerEvent['actor'];
  severity: RunLedgerEvent['severity'];
  data: Record<string, unknown>;
}

export interface RunLedgerAssemblerOptions {
  invocationRecordStore: IInvocationRecordStore;
  messageStore: IMessageStore;
  taskStore?: ITaskStore;
  traceStore?: LocalTraceStore | null;
  messageLimit?: number;
}

const DEFAULT_MESSAGE_LIMIT = 500;

export class RunLedgerAssembler {
  private readonly invocationRecordStore: IInvocationRecordStore;
  private readonly messageStore: IMessageStore;
  private readonly taskStore?: ITaskStore;
  private readonly traceStore?: LocalTraceStore | null;
  private readonly messageLimit: number;

  constructor(options: RunLedgerAssemblerOptions) {
    this.invocationRecordStore = options.invocationRecordStore;
    this.messageStore = options.messageStore;
    this.taskStore = options.taskStore;
    this.traceStore = options.traceStore ?? null;
    this.messageLimit = options.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
  }

  async assemble(invocationId: string): Promise<RunLedgerResponse | null> {
    const record = await this.invocationRecordStore.get(invocationId);
    if (!record) return null;

    const threadMessages = await this.messageStore.getByThread(record.threadId, this.messageLimit, record.userId);
    const messages = threadMessages.filter((message) => isInvocationMessage(message, record));
    const assistantMessages = messages.filter(
      (message) => message.catId !== null && message.extra?.stream?.invocationId === record.id,
    );
    const tasks = await this.findAssociatedTasks(record, messages);
    const taskEvents = collectTaskEvents(tasks, record.id);
    const traceSpans = queryTraceSpans(this.traceStore, record.id);
    const traceId = traceSpans[0]?.traceId;

    const events: DraftEvent[] = [
      {
        ts: record.createdAt,
        type: 'created',
        actor: 'system',
        severity: 'info',
        data: { status: 'queued' },
      },
      {
        ts: record.createdAt,
        type: 'queued',
        actor: 'system',
        severity: 'info',
        data: { threadId: record.threadId, targetCats: record.targetCats },
      },
    ];

    if (record.status !== 'queued') {
      events.push({
        ts: record.createdAt + 1,
        type: 'runtime_starting',
        actor: record.targetCats[0] ?? 'system',
        severity: 'info',
        data: { phase: 'runtime_starting' },
      });
    }

    const firstAssistantMessage = assistantMessages[0];
    if (firstAssistantMessage) {
      events.push({
        ts: firstAssistantMessage.timestamp,
        type: 'first_token',
        actor: firstAssistantMessage.catId ?? 'system',
        severity: 'info',
        data: { messageId: firstAssistantMessage.id },
      });
    }

    for (const message of assistantMessages) {
      for (const toolEvent of message.toolEvents ?? []) {
        events.push(toToolLedgerEvent(record.id, message.catId ?? 'system', toolEvent));
      }
      events.push({
        ts: message.timestamp,
        type: 'message_persisted',
        actor: message.catId ?? 'system',
        severity: 'info',
        data: {
          messageId: message.id,
          origin: message.origin ?? null,
          hasToolEvents: (message.toolEvents?.length ?? 0) > 0,
        },
      });
    }

    for (const taskEvent of taskEvents) {
      const mapped = toTaskLedgerEvent(taskEvent);
      if (mapped) events.push(mapped);
    }

    if (record.status === 'succeeded') {
      events.push({
        ts: record.updatedAt,
        type: 'succeeded',
        actor: 'system',
        severity: 'info',
        data: { phase: record.phase },
      });
    } else if (record.status === 'failed') {
      events.push({
        ts: record.updatedAt,
        type: 'failed',
        actor: 'system',
        severity: 'error',
        data: {
          phase: record.phase,
          failureClass: classifyFailure(record.error),
          error: sanitizeString(record.error ?? 'unknown'),
        },
      });
    } else if (record.status === 'canceled') {
      events.push({
        ts: record.updatedAt,
        type: 'canceled',
        actor: 'system',
        severity: 'warning',
        data: { phase: record.phase },
      });
    }

    const normalizedEvents = normalizeEvents(record.id, events);
    const usage = summarizeUsage(record.usageByCat);
    const artifactCount = countArtifactFiles(taskEvents);
    const toolCallCount = assistantMessages.reduce((sum, message) => sum + (message.toolEvents?.length ?? 0), 0);
    const task = tasks[0];
    const missingSources = [
      ...(traceSpans.length === 0 ? ['trace'] : []),
      ...(assistantMessages.length === 0 && isTerminal(record.status) ? ['assistant_message'] : []),
    ];

    return {
      summary: {
        invocationId: record.id,
        threadId: record.threadId,
        userMessageId: record.userMessageId,
        ...(assistantMessages[assistantMessages.length - 1]?.id
          ? { assistantMessageId: assistantMessages[assistantMessages.length - 1]!.id }
          : {}),
        ...(task?.id ? { taskId: task.id } : {}),
        targetCats: record.targetCats,
        status: record.status,
        phase: record.phase,
        startedAt: record.createdAt,
        ...(isTerminal(record.status)
          ? { endedAt: record.updatedAt, durationMs: Math.max(0, record.updatedAt - record.createdAt) }
          : {}),
        ...(record.status === 'failed' ? { failureClass: classifyFailure(record.error) } : {}),
        ...(usage ? { usage } : {}),
        artifactCount,
        toolCallCount,
        ...(traceId ? { traceId } : {}),
      },
      events: normalizedEvents,
      sources: {
        invocationRecord: true,
        messages: messages.length,
        taskEvents: taskEvents.length,
        trace: traceSpans.length > 0,
      },
      ...(missingSources.length > 0
        ? {
            degraded: {
              reason: `Missing optional source(s): ${missingSources.join(', ')}`,
              missingSources,
            },
          }
        : {}),
    };
  }

  async listByThread(threadId: string, limit: number): Promise<RunLedgerSummary[]> {
    const records = await this.scanAllRecords();
    const matched = records
      .filter((record) => record.threadId === threadId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    const summaries: RunLedgerSummary[] = [];
    for (const record of matched) {
      const ledger = await this.assemble(record.id);
      if (ledger) summaries.push(ledger.summary);
    }
    return summaries;
  }

  async listByTask(taskId: string, limit: number): Promise<RunLedgerSummary[] | null> {
    if (!this.taskStore) return [];
    const task = await this.taskStore.get(taskId);
    if (!task) return null;
    const records = await this.scanAllRecords();
    const eventInvocationIds = new Set(
      (task.events ?? [])
        .map((event) => event.invocationId ?? event.data?.invocationId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    );
    const matched = records
      .filter((record) => {
        if (eventInvocationIds.has(record.id)) return true;
        if (task.sourceMessageId && record.userMessageId === task.sourceMessageId) return true;
        if (task.taskThreadId && record.threadId === task.taskThreadId) return true;
        return false;
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
    const summaries: RunLedgerSummary[] = [];
    for (const record of matched) {
      const ledger = await this.assemble(record.id);
      if (ledger) summaries.push(ledger.summary);
    }
    return summaries;
  }

  supportsScanAll(): boolean {
    return typeof this.invocationRecordStore.scanAll === 'function';
  }

  private async scanAllRecords(): Promise<InvocationRecord[]> {
    if (!this.invocationRecordStore.scanAll) {
      throw new Error('scanAll unavailable');
    }
    return this.invocationRecordStore.scanAll();
  }

  private async findAssociatedTasks(record: InvocationRecord, messages: StoredMessage[]): Promise<TaskItem[]> {
    if (!this.taskStore) return [];
    const messageIds = new Set(messages.map((message) => message.id));
    if (record.userMessageId) messageIds.add(record.userMessageId);
    const candidates = new Map<string, TaskItem>();

    for (const task of await this.taskStore.listByThread(record.threadId)) {
      if (isTaskAssociated(task, record, messageIds)) candidates.set(task.id, task);
    }

    for (const kind of ['work', 'pr_tracking'] as const) {
      for (const task of await this.taskStore.listByKind(kind)) {
        if (isTaskAssociated(task, record, messageIds)) candidates.set(task.id, task);
      }
    }

    return [...candidates.values()];
  }
}

function isInvocationMessage(message: StoredMessage, record: InvocationRecord): boolean {
  return (
    message.id === record.userMessageId ||
    message.extra?.stream?.invocationId === record.id ||
    message.extra?.crossPost?.sourceInvocationId === record.id
  );
}

function isTaskAssociated(task: TaskItem, record: InvocationRecord, messageIds: Set<string>): boolean {
  if (task.sourceMessageId && messageIds.has(task.sourceMessageId)) return true;
  if (task.taskThreadId && task.taskThreadId === record.threadId) return true;
  return (task.events ?? []).some(
    (event) => event.invocationId === record.id || event.data?.invocationId === record.id,
  );
}

function collectTaskEvents(tasks: TaskItem[], invocationId: string): TaskEvent[] {
  return tasks.flatMap((task) =>
    (task.events ?? []).filter((event) => {
      if (event.invocationId === invocationId) return true;
      if (event.data?.invocationId === invocationId) return true;
      return (
        event.type === 'usage' ||
        event.type === 'artifact' ||
        event.type === 'capability_usage' ||
        event.type === 'tool_usage' ||
        event.type === 'compact_boundary' ||
        event.type.startsWith('fast_lane_')
      );
    }),
  );
}

function queryTraceSpans(traceStore: LocalTraceStore | null | undefined, invocationId: string): TraceSpanDTO[] {
  if (!traceStore) return [];
  try {
    return traceStore.query({ invocationId: hmacId(invocationId), limit: 100 });
  } catch {
    // Trace is an optional source for Phase A; never fail the ledger API because
    // local telemetry salt/config is unavailable.
    return [];
  }
}

function toToolLedgerEvent(invocationId: string, actor: RunLedgerEvent['actor'], event: StoredToolEvent): DraftEvent {
  const type = event.type === 'tool_use' ? 'tool_started' : 'tool_completed';
  return {
    ts: event.timestamp,
    type,
    actor,
    severity: type === 'tool_completed' ? 'info' : 'info',
    data: {
      invocationId,
      tool: sanitizeString(event.label),
      ...(event.detail ? { detail: sanitizeString(event.detail) } : {}),
    },
  };
}

function toTaskLedgerEvent(event: TaskEvent): DraftEvent | null {
  const ts = Date.parse(event.ts);
  const actor = event.catId as RunLedgerEvent['actor'];
  if (Number.isNaN(ts)) return null;
  if (event.type === 'usage') {
    return {
      ts,
      type: 'usage_recorded',
      actor,
      severity: 'info',
      data: pickUsageEventData(event.data ?? {}),
    };
  }
  if (event.type === 'capability_usage') {
    return {
      ts,
      type: 'usage_recorded',
      actor,
      severity: event.data?.status === 'failed' ? 'warning' : 'info',
      data: {
        usageKind: 'capability',
        capabilityId: sanitizeUnknown(event.data?.capabilityId),
        capabilityType: sanitizeUnknown(event.data?.capabilityType),
        toolName: sanitizeUnknown(event.data?.toolName),
        status: sanitizeUnknown(event.data?.status),
        durationMs: sanitizeUnknown(event.data?.durationMs),
        costUsd: sanitizeUnknown(event.data?.costUsd),
      },
    };
  }
  if (event.type === 'tool_usage') {
    return {
      ts,
      type: 'tool_usage',
      actor,
      severity: event.data?.status === 'failed' ? 'warning' : 'info',
      data: {
        usageKind: 'tool',
        provider: sanitizeUnknown(event.data?.provider),
        serverId: sanitizeUnknown(event.data?.serverId),
        toolName: sanitizeUnknown(event.data?.toolName),
        toolId: sanitizeUnknown(event.data?.toolId),
        status: sanitizeUnknown(event.data?.status),
        title: sanitizeUnknown(event.data?.title),
        target: sanitizeUnknown(event.data?.target),
        durationMs: sanitizeUnknown(event.data?.durationMs),
      },
    };
  }
  if (event.type === 'artifact') {
    return {
      ts,
      type: 'artifact_delta',
      actor,
      severity: 'info',
      data: pickArtifactEventData(event.data ?? {}),
    };
  }
  if (event.type === 'compact_boundary') {
    return {
      ts,
      type: 'compact_boundary',
      actor,
      severity: 'info',
      data: pickCompactBoundaryEventData(event.data ?? {}),
    };
  }
  if (event.type === 'fast_lane_completed') {
    return {
      ts,
      type: 'artifact_delta',
      actor,
      severity: 'info',
      data: {
        taskEventType: event.type,
        workflowId: sanitizeUnknown(event.data?.workflowId),
        artifactCount: sanitizeUnknown(event.data?.artifactCount),
        routeExecutionBypassed: sanitizeUnknown(event.data?.routeExecutionBypassed),
      },
    };
  }
  if (event.type === 'fast_lane_failed') {
    return {
      ts,
      type: 'failed',
      actor,
      severity: 'error',
      data: {
        taskEventType: event.type,
        workflowId: sanitizeUnknown(event.data?.workflowId),
        error: sanitizeUnknown(event.data?.error ?? event.data?.stderr),
      },
    };
  }
  return null;
}

function normalizeEvents(invocationId: string, events: DraftEvent[]): RunLedgerEvent[] {
  return events
    .sort((a, b) => a.ts - b.ts)
    .map((event, index) => ({
      id: `${invocationId}:${index + 1}:${event.type}`,
      invocationId,
      ts: event.ts,
      seq: index + 1,
      type: event.type,
      actor: event.actor,
      severity: event.severity,
      data: sanitizeRecord(event.data),
    }));
}

function summarizeUsage(usageByCat: InvocationRecord['usageByCat']): RunLedgerSummary['usage'] | undefined {
  if (!usageByCat) return undefined;
  const usage: NonNullable<RunLedgerSummary['usage']> = {};
  for (const item of Object.values(usageByCat)) {
    addUsageNumber(usage, 'inputTokens', item.inputTokens);
    addUsageNumber(usage, 'outputTokens', item.outputTokens);
    addUsageNumber(usage, 'cacheReadTokens', item.cacheReadTokens);
    addUsageNumber(usage, 'cacheCreationTokens', item.cacheCreationTokens);
    addUsageNumber(usage, 'costUsd', item.costUsd);
    if (item.historyMode != null) usage.historyMode = item.historyMode;
    if (item.historyFullTokens != null) usage.historyFullTokens = item.historyFullTokens;
    if (item.historySummaryTokens != null) usage.historySummaryTokens = item.historySummaryTokens;
    if (item.historyBudgetRatio != null) usage.historyBudgetRatio = item.historyBudgetRatio;
    if (item.summarySegmentId != null) usage.summarySegmentId = item.summarySegmentId;
    if (item.historyGovernanceDegraded != null) {
      usage.historyGovernanceDegraded = item.historyGovernanceDegraded;
    }
    if (item.deliveryOnlyMode === 'degraded') {
      usage.deliveryOnlyMode = 'degraded';
      if (item.deliveryOnlyDegradedIssue) {
        usage.deliveryOnlyDegradedIssue = item.deliveryOnlyDegradedIssue;
      }
    } else if (item.deliveryOnlyMode === 'active' && usage.deliveryOnlyMode !== 'degraded') {
      usage.deliveryOnlyMode = 'active';
    }
    if (item.budgetGateTriggered != null) usage.budgetGateTriggered = item.budgetGateTriggered;
    if (item.historyFullTokensBeforeGate != null) {
      usage.historyFullTokensBeforeGate = item.historyFullTokensBeforeGate;
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function addUsageNumber(
  target: NonNullable<RunLedgerSummary['usage']>,
  key: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'costUsd',
  value: number | undefined,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  target[key] = (target[key] ?? 0) + value;
}

function countArtifactFiles(events: TaskEvent[]): number {
  let count = 0;
  for (const event of events) {
    const files = event.data?.files;
    if (Array.isArray(files)) {
      count += files.length;
    } else if (typeof event.data?.artifactCount === 'number') {
      count += event.data.artifactCount;
    }
  }
  return count;
}

function classifyFailure(error: string | undefined): NonNullable<RunLedgerSummary['failureClass']> {
  const value = (error ?? '').toLowerCase();
  if (value.includes('process_restart')) return 'process_restart';
  if (value.includes('timeout') || value.includes('timed out')) return 'runtime_hung';
  if (value.includes('permission_cancelled') || (value.includes('permission') && value.includes('cancel'))) {
    return 'tool_failed';
  }
  if (value.includes('cancel')) return 'user_canceled';
  if (value.includes('budget')) return 'budget_exhausted';
  if (value.includes('tool')) return 'tool_failed';
  if (value.includes('spawn') || value.includes('enoent')) return 'runtime_spawn_failed';
  return 'unknown';
}

function isTerminal(status: InvocationStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function pickUsageEventData(data: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'provider',
    'model',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
    'costUsd',
    'durationMs',
    'durationApiMs',
    'sourceBreakdown',
    'historyMode',
    'historyFullTokens',
    'historySummaryTokens',
    'historyBudgetRatio',
    'summarySegmentId',
    'historyGovernanceDegraded',
    'deliveryOnlyMode',
    'deliveryOnlyDegradedIssue',
    'budgetGateTriggered',
    'historyFullTokensBeforeGate',
  ];
  return pickKeys(data, keys);
}

function pickArtifactEventData(data: Record<string, unknown>): Record<string, unknown> {
  return pickKeys(data, ['files', 'totalAdded', 'totalRemoved', 'artifactCount']);
}

function pickCompactBoundaryEventData(data: Record<string, unknown>): Record<string, unknown> {
  return pickKeys(data, ['boundary', 'source', 'preTokens', 'sessionId', 'compressionCount']);
}

function pickKeys(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (data[key] !== undefined) result[key] = sanitizeUnknown(data[key]);
  }
  return result;
}

function sanitizeRecord(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (/prompt|env|header|token|secret|credential/i.test(key) && key !== 'totalTokens' && !key.endsWith('Tokens')) {
      result[key] = '<redacted>';
    } else {
      result[key] = sanitizeUnknown(value);
    }
  }
  return result;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeUnknown(item));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = sanitizeUnknown(nested);
    }
    return result;
  }
  return String(value);
}

export function sanitizeString(value: string): string {
  const redacted = value
    .replace(/sk_(agent|machine)_[A-Za-z0-9_-]+/g, 'sk_$1_<redacted>')
    .replace(/raft_secret_[A-Za-z0-9_-]+/g, 'raft_secret_<redacted>')
    .replace(/slock_secret_[A-Za-z0-9_-]+/g, 'slock_secret_<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer <redacted>');
  return redacted.length > 500 ? `${redacted.slice(0, 500)}...` : redacted;
}
