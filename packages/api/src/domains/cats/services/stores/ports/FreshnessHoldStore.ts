/**
 * Freshness Hold Store
 *
 * 持久化被 freshness 闸门扣住的完整稿件，并以 version CAS 保护 review 状态迁移。
 * needs_attention 是 fail-closed 终态：稿件必须继续保留，不能靠 TTL 静默删除。
 */

import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';

export type FreshnessHoldStatus = 'held' | 'reviewing' | 'released' | 'discarded' | 'needs_attention';
export type FreshnessAttentionReason = 'review_limit' | 'timeout';

/**
 * 闸门已经物化的完整待发 envelope。
 * 除 content 外的字段由出口按需扩展，例如 richBlocks、replyTo、targetCats。
 */
export interface FreshnessHeldDraft {
  content: string;
  readonly [key: string]: unknown;
}

export interface CreateFreshnessHoldInput {
  invocationId: string;
  /** 与 invocationId 共同组成幂等域，通常为 callback clientMessageId。 */
  submissionKey: string;
  userId: string;
  catId: CatId;
  threadId: string;
  baselineWatermark: string;
  observedWatermark: string;
  deltaMessageIds: readonly string[];
  draft: FreshnessHeldDraft;
  createdAt: number;
  reviewDeadlineAt: number;
}

export interface FreshnessHoldRecord extends CreateFreshnessHoldInput {
  id: string;
  status: FreshnessHoldStatus;
  version: number;
  reviewCount: number;
  updatedAt: number;
  attentionReason?: FreshnessAttentionReason;
  releasedMessageId?: string;
  committedWatermark?: string;
  resolvedAt?: number;
}

export type CreateOrGetFreshnessHoldResult =
  | { outcome: 'created'; hold: FreshnessHoldRecord }
  | { outcome: 'existing'; hold: FreshnessHoldRecord };

export interface ClaimFreshnessReviewInput {
  expectedVersion: number;
  now: number;
}

export interface ReholdFreshnessInput extends ClaimFreshnessReviewInput {
  observedWatermark: string;
  deltaMessageIds: readonly string[];
  draft: FreshnessHeldDraft;
}

export interface ReleaseFreshnessHoldInput extends ClaimFreshnessReviewInput {
  messageId: string;
  committedWatermark: string;
}

export interface IFreshnessHoldStore {
  createOrGet(input: CreateFreshnessHoldInput): Promise<CreateOrGetFreshnessHoldResult>;
  get(id: string): Promise<FreshnessHoldRecord | null>;
  /** 列出指定用户/线程尚未解决的 hold，按创建时间倒序。 */
  listActive(userId: string, threadId: string): Promise<FreshnessHoldRecord[]>;
  /** Read the canonical record for a submission without creating a new hold. */
  getBySubmission(invocationId: string, submissionKey: string): Promise<FreshnessHoldRecord | null>;
  claimReview(id: string, input: ClaimFreshnessReviewInput): Promise<FreshnessHoldRecord | null>;
  rehold(id: string, input: ReholdFreshnessInput): Promise<FreshnessHoldRecord | null>;
  release(id: string, input: ReleaseFreshnessHoldInput): Promise<FreshnessHoldRecord | null>;
  discard(id: string, input: ClaimFreshnessReviewInput): Promise<FreshnessHoldRecord | null>;
  /** 将所有到期 held/reviewing 记录转为 needs_attention，返回成功迁移数量。 */
  expireDue(now: number): Promise<number>;
  /**
   * 删除某用户某线程的所有 hold 记录（对话被永久删除时级联）。返回删除数量。
   * hold 里存着未发布的 draft 正文，所以"永久删除"必须连它一起清掉。
   */
  deleteByThread(userId: string, threadId: string): Promise<number>;
}

export interface FreshnessHoldStoreOptions {
  maxReviews?: number;
}

function normalizeMaxReviews(value: number | undefined): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) return 2;
  return value ?? 2;
}

function submissionIndexKey(invocationId: string, submissionKey: string): string {
  return `${invocationId}\u0000${submissionKey}`;
}

function cloneRecord(record: FreshnessHoldRecord): FreshnessHoldRecord {
  return structuredClone(record);
}

/**
 * Resolved holds keep a metadata tombstone for dedupe/recovery, but no longer
 * need the private review payload. Keep the required record shape with empty
 * values so callers cannot recover prior content from the in-memory store.
 */
function scrubResolvedPayload(record: FreshnessHoldRecord): void {
  record.draft = { content: '' };
  record.deltaMessageIds = [];
}

/** In-memory implementation. Mutations happen synchronously before each Promise resolves. */
export class FreshnessHoldStore implements IFreshnessHoldStore {
  private readonly records = new Map<string, FreshnessHoldRecord>();
  private readonly submissionIndex = new Map<string, string>();
  private readonly maxReviews: number;

  constructor(options?: FreshnessHoldStoreOptions) {
    this.maxReviews = normalizeMaxReviews(options?.maxReviews);
  }

  async createOrGet(input: CreateFreshnessHoldInput): Promise<CreateOrGetFreshnessHoldResult> {
    const indexKey = submissionIndexKey(input.invocationId, input.submissionKey);
    const existingId = this.submissionIndex.get(indexKey);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing) return { outcome: 'existing', hold: cloneRecord(existing) };
      this.submissionIndex.delete(indexKey);
    }

    const record: FreshnessHoldRecord = {
      ...structuredClone(input),
      id: randomUUID(),
      status: 'held',
      version: 1,
      reviewCount: 0,
      updatedAt: input.createdAt,
    };
    this.records.set(record.id, record);
    this.submissionIndex.set(indexKey, record.id);
    return { outcome: 'created', hold: cloneRecord(record) };
  }

  async get(id: string): Promise<FreshnessHoldRecord | null> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : null;
  }

  async listActive(userId: string, threadId: string): Promise<FreshnessHoldRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.userId === userId &&
          record.threadId === threadId &&
          (record.status === 'held' || record.status === 'reviewing' || record.status === 'needs_attention'),
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map(cloneRecord);
  }

  async getBySubmission(invocationId: string, submissionKey: string): Promise<FreshnessHoldRecord | null> {
    const indexKey = submissionIndexKey(invocationId, submissionKey);
    const id = this.submissionIndex.get(indexKey);
    if (!id) return null;
    const record = this.records.get(id);
    if (record) return cloneRecord(record);
    this.submissionIndex.delete(indexKey);
    return null;
  }

  async claimReview(id: string, input: ClaimFreshnessReviewInput): Promise<FreshnessHoldRecord | null> {
    const record = this.records.get(id);
    if (!record || record.version !== input.expectedVersion || record.status !== 'held') return null;
    if (input.now >= record.reviewDeadlineAt) {
      this.moveToNeedsAttention(record, 'timeout', input.now);
      return null;
    }
    if (record.reviewCount >= this.maxReviews) {
      this.moveToNeedsAttention(record, 'review_limit', input.now);
      return null;
    }

    record.status = 'reviewing';
    record.version += 1;
    record.updatedAt = input.now;
    return cloneRecord(record);
  }

  async rehold(id: string, input: ReholdFreshnessInput): Promise<FreshnessHoldRecord | null> {
    const record = this.records.get(id);
    if (!record || record.version !== input.expectedVersion || record.status !== 'reviewing') return null;
    if (input.now >= record.reviewDeadlineAt) {
      this.moveToNeedsAttention(record, 'timeout', input.now);
      return null;
    }

    record.observedWatermark = input.observedWatermark;
    record.deltaMessageIds = structuredClone(input.deltaMessageIds);
    record.draft = structuredClone(input.draft);
    record.reviewCount += 1;
    record.version += 1;
    record.updatedAt = input.now;
    if (record.reviewCount >= this.maxReviews) {
      record.status = 'needs_attention';
      record.attentionReason = 'review_limit';
    } else {
      record.status = 'held';
    }
    return cloneRecord(record);
  }

  async release(id: string, input: ReleaseFreshnessHoldInput): Promise<FreshnessHoldRecord | null> {
    const record = this.records.get(id);
    if (!record || record.version !== input.expectedVersion || record.status !== 'reviewing') return null;
    if (input.now >= record.reviewDeadlineAt) {
      this.moveToNeedsAttention(record, 'timeout', input.now);
      return null;
    }

    record.status = 'released';
    record.releasedMessageId = input.messageId;
    record.committedWatermark = input.committedWatermark;
    record.resolvedAt = input.now;
    record.updatedAt = input.now;
    record.version += 1;
    scrubResolvedPayload(record);
    return cloneRecord(record);
  }

  async discard(id: string, input: ClaimFreshnessReviewInput): Promise<FreshnessHoldRecord | null> {
    const record = this.records.get(id);
    if (
      !record ||
      record.version !== input.expectedVersion ||
      (record.status !== 'held' && record.status !== 'reviewing')
    ) {
      return null;
    }

    record.status = 'discarded';
    record.resolvedAt = input.now;
    record.updatedAt = input.now;
    record.version += 1;
    scrubResolvedPayload(record);
    return cloneRecord(record);
  }

  async expireDue(now: number): Promise<number> {
    let transitioned = 0;
    for (const record of this.records.values()) {
      if ((record.status === 'held' || record.status === 'reviewing') && record.reviewDeadlineAt <= now) {
        this.moveToNeedsAttention(record, 'timeout', now);
        transitioned += 1;
      }
    }
    return transitioned;
  }

  async deleteByThread(userId: string, threadId: string): Promise<number> {
    let deleted = 0;
    for (const [id, record] of this.records) {
      if (record.userId !== userId || record.threadId !== threadId) continue;
      this.records.delete(id);
      // The submission index is keyed by invocation+submissionKey, so it has to be
      // cleaned via the record we are about to drop.
      this.submissionIndex.delete(submissionIndexKey(record.invocationId, record.submissionKey));
      deleted += 1;
    }
    return deleted;
  }

  private moveToNeedsAttention(record: FreshnessHoldRecord, reason: FreshnessAttentionReason, now: number): void {
    record.status = 'needs_attention';
    record.attentionReason = reason;
    record.version += 1;
    record.updatedAt = now;
  }
}
