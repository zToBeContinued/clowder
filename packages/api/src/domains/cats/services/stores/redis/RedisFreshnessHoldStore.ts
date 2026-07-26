/** Redis-backed Freshness Hold Store with Lua-linearized idempotency and CAS transitions. */

import { randomUUID } from 'node:crypto';
import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  ClaimFreshnessReviewInput,
  CreateFreshnessHoldInput,
  CreateOrGetFreshnessHoldResult,
  FreshnessHeldDraft,
  FreshnessHoldRecord,
  FreshnessHoldStatus,
  FreshnessHoldStoreOptions,
  IFreshnessHoldStore,
  ReholdFreshnessInput,
  ReleaseFreshnessHoldInput,
} from '../ports/FreshnessHoldStore.js';
import { FreshnessHoldKeys } from '../redis-keys/freshness-hold-keys.js';

const CREATE_OR_GET_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  return {'existing', existing}
end

redis.call('SET', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2],
  'id', ARGV[1],
  'invocationId', ARGV[2],
  'submissionKey', ARGV[3],
  'userId', ARGV[4],
  'catId', ARGV[5],
  'threadId', ARGV[6],
  'baselineWatermark', ARGV[7],
  'observedWatermark', ARGV[8],
  'deltaMessageIds', ARGV[9],
  'draft', ARGV[10],
  'createdAt', ARGV[11],
  'reviewDeadlineAt', ARGV[12],
  'status', 'held',
  'version', '1',
  'reviewCount', '0',
  'updatedAt', ARGV[11])
redis.call('ZADD', KEYS[3], ARGV[12], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[11], ARGV[1])
return {'created', ARGV[1]}
`;

const CLAIM_REVIEW_LUA = `
local currentVersion = tonumber(redis.call('HGET', KEYS[1], 'version'))
local currentStatus = redis.call('HGET', KEYS[1], 'status')
if not currentVersion or currentVersion ~= tonumber(ARGV[1]) or currentStatus ~= 'held' then
  return 0
end

local deadline = tonumber(redis.call('HGET', KEYS[1], 'reviewDeadlineAt'))
if deadline and tonumber(ARGV[2]) >= deadline then
  redis.call('HSET', KEYS[1],
    'status', 'needs_attention',
    'attentionReason', 'timeout',
    'version', tostring(currentVersion + 1),
    'updatedAt', ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[3])
  return 0
end

local reviewCount = tonumber(redis.call('HGET', KEYS[1], 'reviewCount')) or 0
if reviewCount >= tonumber(ARGV[4]) then
  redis.call('HSET', KEYS[1],
    'status', 'needs_attention',
    'attentionReason', 'review_limit',
    'version', tostring(currentVersion + 1),
    'updatedAt', ARGV[2])
  redis.call('ZREM', KEYS[2], ARGV[3])
  return 0
end

redis.call('HSET', KEYS[1],
  'status', 'reviewing',
  'version', tostring(currentVersion + 1),
  'updatedAt', ARGV[2])
return 1
`;

const REHOLD_LUA = `
local currentVersion = tonumber(redis.call('HGET', KEYS[1], 'version'))
local currentStatus = redis.call('HGET', KEYS[1], 'status')
if not currentVersion or currentVersion ~= tonumber(ARGV[1]) or currentStatus ~= 'reviewing' then
  return 0
end

local deadline = tonumber(redis.call('HGET', KEYS[1], 'reviewDeadlineAt'))
if deadline and tonumber(ARGV[5]) >= deadline then
  redis.call('HSET', KEYS[1],
    'status', 'needs_attention',
    'attentionReason', 'timeout',
    'version', tostring(currentVersion + 1),
    'updatedAt', ARGV[5])
  redis.call('ZREM', KEYS[2], ARGV[7])
  return 0
end

local reviewCount = (tonumber(redis.call('HGET', KEYS[1], 'reviewCount')) or 0) + 1
local nextStatus = 'held'
local attentionReason = ''
if reviewCount >= tonumber(ARGV[6]) then
  nextStatus = 'needs_attention'
  attentionReason = 'review_limit'
  redis.call('ZREM', KEYS[2], ARGV[7])
end

redis.call('HSET', KEYS[1],
  'status', nextStatus,
  'attentionReason', attentionReason,
  'version', tostring(currentVersion + 1),
  'reviewCount', tostring(reviewCount),
  'observedWatermark', ARGV[2],
  'deltaMessageIds', ARGV[3],
  'draft', ARGV[4],
  'updatedAt', ARGV[5])
return 1
`;

const RELEASE_LUA = `
local currentVersion = tonumber(redis.call('HGET', KEYS[1], 'version'))
local currentStatus = redis.call('HGET', KEYS[1], 'status')
if not currentVersion or currentVersion ~= tonumber(ARGV[1]) or currentStatus ~= 'reviewing' then
  return 0
end

local deadline = tonumber(redis.call('HGET', KEYS[1], 'reviewDeadlineAt'))
if deadline and tonumber(ARGV[4]) >= deadline then
  redis.call('HSET', KEYS[1],
    'status', 'needs_attention',
    'attentionReason', 'timeout',
    'version', tostring(currentVersion + 1),
    'updatedAt', ARGV[4])
  redis.call('ZREM', KEYS[2], ARGV[5])
  return 0
end

redis.call('HSET', KEYS[1],
  'status', 'released',
  'releasedMessageId', ARGV[2],
  'committedWatermark', ARGV[3],
  'resolvedAt', ARGV[4],
  'updatedAt', ARGV[4],
  'version', tostring(currentVersion + 1))
redis.call('HDEL', KEYS[1], 'draft', 'deltaMessageIds')
redis.call('ZREM', KEYS[2], ARGV[5])
redis.call('ZREM', KEYS[3], ARGV[5])
return 1
`;

const DISCARD_LUA = `
local currentVersion = tonumber(redis.call('HGET', KEYS[1], 'version'))
local currentStatus = redis.call('HGET', KEYS[1], 'status')
if not currentVersion or currentVersion ~= tonumber(ARGV[1]) then
  return 0
end
if currentStatus ~= 'held' and currentStatus ~= 'reviewing' then
  return 0
end

redis.call('HSET', KEYS[1],
  'status', 'discarded',
  'resolvedAt', ARGV[2],
  'updatedAt', ARGV[2],
  'version', tostring(currentVersion + 1))
redis.call('HDEL', KEYS[1], 'draft', 'deltaMessageIds')
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('ZREM', KEYS[3], ARGV[3])
return 1
`;

const EXPIRE_DUE_LUA = `
local currentStatus = redis.call('HGET', KEYS[1], 'status')
if currentStatus ~= 'held' and currentStatus ~= 'reviewing' then
  redis.call('ZREM', KEYS[2], ARGV[2])
  return 0
end

local deadline = tonumber(redis.call('HGET', KEYS[1], 'reviewDeadlineAt'))
if not deadline or deadline > tonumber(ARGV[1]) then
  return 0
end

local currentVersion = tonumber(redis.call('HGET', KEYS[1], 'version')) or 0
redis.call('HSET', KEYS[1],
  'status', 'needs_attention',
  'attentionReason', 'timeout',
  'version', tostring(currentVersion + 1),
  'updatedAt', ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[2])
return 1
`;

const HOLD_STATUSES = new Set<FreshnessHoldStatus>(['held', 'reviewing', 'released', 'discarded', 'needs_attention']);

function normalizeMaxReviews(value: number | undefined): number {
  if (!Number.isInteger(value) || (value ?? 0) <= 0) return 2;
  return value ?? 2;
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeStatus(value: string | undefined): FreshnessHoldStatus {
  return HOLD_STATUSES.has(value as FreshnessHoldStatus) ? (value as FreshnessHoldStatus) : 'needs_attention';
}

function hydrateOptionalFields(data: Record<string, string>): Partial<FreshnessHoldRecord> {
  const fields: Partial<FreshnessHoldRecord> = {};
  if (data.attentionReason === 'review_limit' || data.attentionReason === 'timeout') {
    fields.attentionReason = data.attentionReason;
  }
  if (data.releasedMessageId) fields.releasedMessageId = data.releasedMessageId;
  if (data.committedWatermark) fields.committedWatermark = data.committedWatermark;
  if (data.resolvedAt) fields.resolvedAt = Number(data.resolvedAt);
  return fields;
}

export class RedisFreshnessHoldStore implements IFreshnessHoldStore {
  private readonly maxReviews: number;

  constructor(
    private readonly redis: RedisClient,
    options?: FreshnessHoldStoreOptions,
  ) {
    this.maxReviews = normalizeMaxReviews(options?.maxReviews);
  }

  async createOrGet(input: CreateFreshnessHoldInput): Promise<CreateOrGetFreshnessHoldResult> {
    const id = randomUUID();
    const result = (await this.redis.eval(
      CREATE_OR_GET_LUA,
      4,
      FreshnessHoldKeys.submission(input.invocationId, input.submissionKey),
      FreshnessHoldKeys.detail(id),
      FreshnessHoldKeys.DEADLINES,
      FreshnessHoldKeys.userThread(input.userId, input.threadId),
      id,
      input.invocationId,
      input.submissionKey,
      input.userId,
      input.catId as string,
      input.threadId,
      input.baselineWatermark,
      input.observedWatermark,
      JSON.stringify(input.deltaMessageIds),
      JSON.stringify(input.draft),
      String(input.createdAt),
      String(input.reviewDeadlineAt),
    )) as [string, string];

    const hold = await this.get(result[1]);
    if (!hold) throw new Error(`Freshness hold index points to missing record: ${result[1]}`);
    return { outcome: result[0] as 'created' | 'existing', hold };
  }

  async get(id: string): Promise<FreshnessHoldRecord | null> {
    const data = await this.redis.hgetall(FreshnessHoldKeys.detail(id));
    if (!data?.id) return null;
    return this.hydrate(data);
  }

  async listActive(userId: string, threadId: string): Promise<FreshnessHoldRecord[]> {
    const ids = await this.redis.zrevrange(FreshnessHoldKeys.userThread(userId, threadId), 0, -1);
    const records = await Promise.all(ids.map((id) => this.get(id)));
    return records.filter(
      (record): record is FreshnessHoldRecord =>
        record !== null &&
        record.userId === userId &&
        record.threadId === threadId &&
        (record.status === 'held' || record.status === 'reviewing' || record.status === 'needs_attention'),
    );
  }

  async getBySubmission(invocationId: string, submissionKey: string): Promise<FreshnessHoldRecord | null> {
    const id = await this.redis.get(FreshnessHoldKeys.submission(invocationId, submissionKey));
    return id ? this.get(id) : null;
  }

  async claimReview(id: string, input: ClaimFreshnessReviewInput): Promise<FreshnessHoldRecord | null> {
    const changed = (await this.redis.eval(
      CLAIM_REVIEW_LUA,
      2,
      FreshnessHoldKeys.detail(id),
      FreshnessHoldKeys.DEADLINES,
      String(input.expectedVersion),
      String(input.now),
      id,
      String(this.maxReviews),
    )) as number;
    return changed === 1 ? this.get(id) : null;
  }

  async rehold(id: string, input: ReholdFreshnessInput): Promise<FreshnessHoldRecord | null> {
    const changed = (await this.redis.eval(
      REHOLD_LUA,
      2,
      FreshnessHoldKeys.detail(id),
      FreshnessHoldKeys.DEADLINES,
      String(input.expectedVersion),
      input.observedWatermark,
      JSON.stringify(input.deltaMessageIds),
      JSON.stringify(input.draft),
      String(input.now),
      String(this.maxReviews),
      id,
    )) as number;
    return changed === 1 ? this.get(id) : null;
  }

  async release(id: string, input: ReleaseFreshnessHoldInput): Promise<FreshnessHoldRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const changed = (await this.redis.eval(
      RELEASE_LUA,
      3,
      FreshnessHoldKeys.detail(id),
      FreshnessHoldKeys.DEADLINES,
      FreshnessHoldKeys.userThread(existing.userId, existing.threadId),
      String(input.expectedVersion),
      input.messageId,
      input.committedWatermark,
      String(input.now),
      id,
    )) as number;
    return changed === 1 ? this.get(id) : null;
  }

  async discard(id: string, input: ClaimFreshnessReviewInput): Promise<FreshnessHoldRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const changed = (await this.redis.eval(
      DISCARD_LUA,
      3,
      FreshnessHoldKeys.detail(id),
      FreshnessHoldKeys.DEADLINES,
      FreshnessHoldKeys.userThread(existing.userId, existing.threadId),
      String(input.expectedVersion),
      String(input.now),
      id,
    )) as number;
    return changed === 1 ? this.get(id) : null;
  }

  async expireDue(now: number): Promise<number> {
    const dueIds = await this.redis.zrangebyscore(FreshnessHoldKeys.DEADLINES, '-inf', String(now));
    let transitioned = 0;
    for (const id of dueIds) {
      const changed = (await this.redis.eval(
        EXPIRE_DUE_LUA,
        2,
        FreshnessHoldKeys.detail(id),
        FreshnessHoldKeys.DEADLINES,
        String(now),
        id,
      )) as number;
      if (changed === 1) transitioned += 1;
    }
    return transitioned;
  }

  async deleteByThread(userId: string, threadId: string): Promise<number> {
    const indexKey = FreshnessHoldKeys.userThread(userId, threadId);
    const ids = await this.redis.zrange(indexKey, 0, -1);

    const pipeline = this.redis.multi();
    for (const id of ids) {
      const detailKey = FreshnessHoldKeys.detail(id);
      // The submission pointer is keyed by invocation+submissionKey, so it can only be
      // resolved while the detail hash is still readable.
      const [invocationId, submissionKey] = await this.redis.hmget(detailKey, 'invocationId', 'submissionKey');
      if (invocationId && submissionKey) {
        pipeline.del(FreshnessHoldKeys.submission(invocationId, submissionKey));
      }
      pipeline.del(detailKey);
      pipeline.zrem(FreshnessHoldKeys.DEADLINES, id);
    }
    pipeline.del(indexKey);
    await pipeline.exec();

    return ids.length;
  }

  private hydrate(data: Record<string, string>): FreshnessHoldRecord {
    return {
      id: data.id ?? '',
      invocationId: data.invocationId ?? '',
      submissionKey: data.submissionKey ?? '',
      userId: data.userId ?? '',
      catId: (data.catId ?? '') as CatId,
      threadId: data.threadId ?? '',
      baselineWatermark: data.baselineWatermark ?? '0',
      observedWatermark: data.observedWatermark ?? '0',
      deltaMessageIds: parseJson<readonly string[]>(data.deltaMessageIds, []),
      draft: parseJson<FreshnessHeldDraft>(data.draft, { content: '' }),
      createdAt: Number(data.createdAt ?? 0),
      reviewDeadlineAt: Number(data.reviewDeadlineAt ?? 0),
      status: normalizeStatus(data.status),
      version: Number(data.version ?? 0),
      reviewCount: Number(data.reviewCount ?? 0),
      updatedAt: Number(data.updatedAt ?? 0),
      ...hydrateOptionalFields(data),
    };
  }
}
