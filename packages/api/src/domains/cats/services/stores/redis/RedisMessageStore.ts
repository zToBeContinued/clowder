/**
 * Redis Message Store
 * Redis-backed message storage with same interface as in-memory MessageStore.
 *
 * Redis 数据结构:
 *   cat-cafe:msg:{id}                → Hash (消息详情)
 *   cat-cafe:msg:timeline            → Sorted Set (全局时间线, score=timestamp)
 *   cat-cafe:msg:user:{userId}       → Sorted Set (用户维度)
 *   cat-cafe:msg:mentions:{catId}    → Sorted Set (提及维度)
 *   cat-cafe:msg:thread:{threadId}   → Sorted Set (对话维度)
 *
 * 消息 TTL 可配置 (默认 7 天)。
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { createModuleLogger } from '../../../../../infrastructure/logger.js';
import type {
  AppendMessageInput,
  ConditionalAppendResult,
  FreshnessAudience,
  FreshnessDelta,
  FreshnessSideEffectClaimInput,
  FreshnessSideEffectClaimResult,
  StoredMessage,
  StreamMetadataAugmentInput,
  ThreadAppendWatermark,
} from '../ports/MessageStore.js';
import {
  applyStreamMetadataAugment,
  DEFAULT_THREAD_ID,
  generateSortableId,
  isDelivered,
  isFreshnessProtectedPublication,
  isFreshnessRelevantMessage,
  isPendingFreshnessReviewPublication,
} from '../ports/MessageStore.js';
import { MessageKeys } from '../redis-keys/message-keys.js';
import { isSystemUserMessage } from '../visibility.js';
import {
  safeParseConnectorSource,
  safeParseContentBlocks,
  safeParseExtra,
  safeParseMentions,
  safeParseMetadata,
  safeParseToolEvents,
  serializeExtra,
} from './redis-message-parsers.js';

const log = createModuleLogger('redis-message-store');

const DEFAULT_LIMIT = 50;
const DEFAULT_TTL_SECONDS = 0; // persistent — set >0 via env to enable expiry

const MARK_DELIVERED_LUA = `
if redis.call('HGET', KEYS[1], 'deliveryStatus') ~= 'queued' then
  return 0
end
local isReviewPublication = redis.call('HGET', KEYS[1], 'freshnessReviewPublication') == '1'
local isReviewRelease = ARGV[3] == '1'
if isReviewPublication ~= isReviewRelease then
  return 0
end
redis.call('HSET', KEYS[1],
  'deliveredAt', ARGV[1],
  'deliveryStatus', 'delivered')
redis.call('HDEL', KEYS[1], 'freshnessReviewPublication')
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[3], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[4], ARGV[1], ARGV[2])
return 1
`;

/**
 * One linearization point for both ordinary and conditional appends.
 *
 * KEYS:
 *   1 detail hash, 2 global timeline, 3 user timeline, 4 thread timeline,
 *   5 idempotency key (or detail key as an ignored placeholder),
 *   6 freshness sequence, 7 public freshness zset, 8 gate audience whisper zset,
 *   9.. mention zsets followed by whisper-recipient freshness zsets.
 *
 * ARGV:
 *   1 mode, 2 baseline, 3 id, 4 timeline score, 5 hash-fields JSON,
 *   6 freshness-relevant flag, 7 visibility, 8 ttl seconds,
 *   9 idempotency flag, 10 mention-key count, 11 whisper-key count,
 *   12 publication-gate flag, 13 parent invocation group allowed as sibling.
 */
const APPEND_MESSAGE_LUA = `
local mode = ARGV[1]
local baseline = ARGV[2]
local messageId = ARGV[3]
local timelineScore = ARGV[4]
local relevant = ARGV[6] == '1'
local visibility = ARGV[7]
local ttl = tonumber(ARGV[8]) or 0
local hasIdempotency = ARGV[9] == '1'
local mentionCount = tonumber(ARGV[10]) or 0
local whisperCount = tonumber(ARGV[11]) or 0
local gateCheck = ARGV[12] == '1'
local gateGroup = ARGV[13] or ''
local danglingIdempotency = false

-- Idempotency replay wins over staleness: an already-published retry returns
-- the canonical message instead of becoming held on a newer watermark.
if hasIdempotency then
  local existingId = redis.call('GET', KEYS[5])
  if existingId then
    local detailPrefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - string.len(messageId))
    if redis.call('EXISTS', detailPrefix .. existingId) == 1 then
      return {'existing', existingId, ''}
    end
    -- Repair a legacy dangling pointer inside this same linearization point.
    -- A concurrent retry can no longer delete a newly rebuilt pointer.
    danglingIdempotency = true
  end
end

local function latestScore(key)
  local row = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  if #row >= 2 then return row[2] end
  return '0'
end

local function decimalGreater(left, right)
  if string.len(left) ~= string.len(right) then
    return string.len(left) > string.len(right)
  end
  return left > right
end

local observed = '0'
if mode == 'conditional' then
  local publicScore = latestScore(KEYS[7])
  local whisperScore = latestScore(KEYS[8])
  if decimalGreater(publicScore, whisperScore) then observed = publicScore else observed = whisperScore end
  if gateCheck and decimalGreater(observed, baseline) then
    local independent = gateGroup == ''
    if not independent then
      local detailPrefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - string.len(messageId))
      local function containsIndependent(key)
        local ids = redis.call('ZRANGEBYSCORE', key, '(' .. baseline, '+inf')
        for _, id in ipairs(ids) do
          local group = redis.call('HGET', detailPrefix .. id, 'freshnessGroupId') or ''
          if group ~= gateGroup then return true end
        end
        return false
      end
      independent = containsIndependent(KEYS[7]) or containsIndependent(KEYS[8])
    end
    if independent then return {'stale', baseline, observed} end
  end
end

local appendWatermark = ''
if relevant then
  local maxWatermark = '9007199254740991'
  local current = redis.call('GET', KEYS[6]) or '0'
  if not string.match(current, '^%d+$') or
     string.len(current) > string.len(maxWatermark) or
     (string.len(current) == string.len(maxWatermark) and current >= maxWatermark) then
    return redis.error_reply('freshness watermark exhausted')
  end
  redis.call('INCR', KEYS[6])
  appendWatermark = redis.call('GET', KEYS[6])
end

if danglingIdempotency then redis.call('DEL', KEYS[5]) end

local decoded = cjson.decode(ARGV[5])
local fields = {}
for field, value in pairs(decoded) do
  fields[#fields + 1] = field
  fields[#fields + 1] = value
end
if appendWatermark ~= '' then
  fields[#fields + 1] = 'appendWatermark'
  fields[#fields + 1] = appendWatermark
end
redis.call('HSET', KEYS[1], unpack(fields))
redis.call('ZADD', KEYS[2], timelineScore, messageId)
redis.call('ZADD', KEYS[3], timelineScore, messageId)
redis.call('ZADD', KEYS[4], timelineScore, messageId)

local keyIndex = 9
for _ = 1, mentionCount do
  redis.call('ZADD', KEYS[keyIndex], timelineScore, messageId)
  keyIndex = keyIndex + 1
end

if relevant then
  if visibility == 'whisper' then
    for i = 0, whisperCount - 1 do
      redis.call('ZADD', KEYS[keyIndex + i], appendWatermark, messageId)
    end
  else
    redis.call('ZADD', KEYS[7], appendWatermark, messageId)
  end
end

if hasIdempotency then
  redis.call('SET', KEYS[5], messageId)
end

if ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  -- Timeline scores are caller-supplied timestamps, not insertion time. They
  -- therefore cannot safely drive TTL pruning: a historical timestamp would
  -- delete a message immediately (or delete a prior concurrent append). Hash
  -- and index-key expiry retain the configured inactive-key cleanup semantics.
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
  redis.call('EXPIRE', KEYS[4], ttl)
  if hasIdempotency then redis.call('EXPIRE', KEYS[5], ttl) end

  keyIndex = 9
  for _ = 1, mentionCount do
    redis.call('EXPIRE', KEYS[keyIndex], ttl)
    keyIndex = keyIndex + 1
  end
  if relevant then
    if visibility == 'whisper' then
      for i = 0, whisperCount - 1 do redis.call('EXPIRE', KEYS[keyIndex + i], ttl) end
    else
      redis.call('EXPIRE', KEYS[7], ttl)
    end
  end
end

if appendWatermark == '' then appendWatermark = observed end
return {'appended', messageId, appendWatermark}
`;

/** Atomically reserve an idempotent callback side effect at the captured audience watermark. */
const CLAIM_FRESHNESS_SIDE_EFFECT_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {'claimed', '1', ARGV[1]}
end

local function latestScore(key)
  local row = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  if #row >= 2 then return row[2] end
  return '0'
end

local function decimalGreater(left, right)
  if string.len(left) ~= string.len(right) then
    return string.len(left) > string.len(right)
  end
  return left > right
end

local baseline = ARGV[1]
local gateGroup = ARGV[2] or ''
local publicScore = latestScore(KEYS[2])
local whisperScore = latestScore(KEYS[3])
local observed = whisperScore
if decimalGreater(publicScore, whisperScore) then observed = publicScore end

if decimalGreater(observed, baseline) then
  local independent = gateGroup == ''
  if not independent then
    local function containsIndependent(key)
      local ids = redis.call('ZRANGEBYSCORE', key, '(' .. baseline, '+inf')
      for _, id in ipairs(ids) do
        local group = redis.call('HGET', KEYS[4] .. id, 'freshnessGroupId') or ''
        if group ~= gateGroup then return true end
      end
      return false
    end
    independent = containsIndependent(KEYS[2]) or containsIndependent(KEYS[3])
  end
  if independent then return {'stale', '0', observed} end
end

redis.call('SET', KEYS[1], '1', 'EX', ARGV[3])
return {'claimed', '0', observed}
`;

const COMPARE_DELETE_IDEMPOTENCY_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('EXISTS', KEYS[2]) == 0 then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const RESTORE_MESSAGE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 0 then return '' end
if redis.call('HGET', KEYS[1], '_tombstone') == '1' then return '' end
if not redis.call('HGET', KEYS[1], 'deletedAt') then return '' end
if ARGV[1] == '1' then
  local maxWatermark = '9007199254740991'
  local current = redis.call('GET', KEYS[2]) or '0'
  if not string.match(current, '^%d+$') or
     string.len(current) > string.len(maxWatermark) or
     (string.len(current) == string.len(maxWatermark) and current >= maxWatermark) then
    return redis.error_reply('freshness watermark exhausted')
  end
end
redis.call('HDEL', KEYS[1], 'deletedAt', 'deletedBy')
if ARGV[1] ~= '1' then return '0' end
redis.call('INCR', KEYS[2])
local revision = redis.call('GET', KEYS[2])
redis.call('HSET', KEYS[1], 'appendWatermark', revision)
for i = 3, #KEYS do redis.call('ZADD', KEYS[i], revision, ARGV[2]) end
return revision
`;

/**
 * Reveal every matching whisper at one Redis linearization point.
 *
 * KEYS:
 *   1 thread timeline, 2 freshness sequence, 3 public freshness zset,
 *   4 message-detail key prefix, 5 whisper freshness key prefix.
 * ARGV:
 *   1 user id, 2 reveal timestamp.
 */
const REVEAL_WHISPERS_LUA = `
local maxWatermark = '9007199254740991'

local function redisType(key)
  local reply = redis.call('TYPE', key)
  if type(reply) == 'table' then return reply.ok end
  return reply
end

local function isZsetOrMissing(key)
  local keyType = redisType(key)
  return keyType == 'none' or keyType == 'zset'
end

local function isFreshnessRelevant(detailKey)
  if redis.call('HGET', detailKey, 'messageClass') == 'status' then return false end
  if redis.call('HGET', detailKey, 'deliveryStatus') == 'canceled' then return false end
  if redis.call('HGET', detailKey, 'deletedAt') then return false end
  if redis.call('HGET', detailKey, '_tombstone') == '1' then return false end

  local messageUserId = redis.call('HGET', detailKey, 'userId') or ''
  local catId = redis.call('HGET', detailKey, 'catId')
  if (messageUserId == 'scheduler' or messageUserId == 'system') and
     (not catId or catId == '' or catId == 'system') then
    return false
  end
  if redis.call('HGET', detailKey, 'origin') == 'briefing' then return false end

  local rawExtra = redis.call('HGET', detailKey, 'extra')
  if rawExtra and rawExtra ~= '' then
    local decodedOk, decoded = pcall(cjson.decode, rawExtra)
    if decodedOk and type(decoded) == 'table' and decoded.systemKind ~= nil then
      return false
    end
  end
  return true
end

local function collectWhisperIndexes(detailKey)
  local result = {}
  local seen = {}
  local rawRecipients = redis.call('HGET', detailKey, 'whisperTo')
  if not rawRecipients or rawRecipients == '' then return result end

  local decodedOk, recipients = pcall(cjson.decode, rawRecipients)
  if not decodedOk or type(recipients) ~= 'table' then return result end
  for _, catId in ipairs(recipients) do
    if type(catId) == 'string' and not seen[catId] then
      seen[catId] = true
      result[#result + 1] = KEYS[5] .. catId
    end
  end
  return result
end

local function incrementDecimal(value)
  local digits = {}
  local carry = 1
  for index = string.len(value), 1, -1 do
    local digit = string.byte(value, index) - 48 + carry
    if digit >= 10 then
      digit = digit - 10
      carry = 1
    else
      carry = 0
    end
    table.insert(digits, 1, string.char(48 + digit))
  end
  if carry == 1 then table.insert(digits, 1, '1') end
  return table.concat(digits)
end

local ids = redis.call('ZRANGE', KEYS[1], 0, -1)
local candidates = {}
local relevantCount = 0

-- Discover and re-check every candidate inside the script. No reveal write is
-- allowed until the whole batch and its required watermark capacity are known.
for _, id in ipairs(ids) do
  local detailKey = KEYS[4] .. id
  if redis.call('HGET', detailKey, 'visibility') == 'whisper' and
     not redis.call('HGET', detailKey, 'revealedAt') and
     redis.call('HGET', detailKey, 'userId') == ARGV[1] then
    local relevant = isFreshnessRelevant(detailKey)
    local whisperIndexes = collectWhisperIndexes(detailKey)
    for _, whisperKey in ipairs(whisperIndexes) do
      if not isZsetOrMissing(whisperKey) then
        return redis.error_reply('freshness index has wrong type')
      end
    end
    candidates[#candidates + 1] = {
      id = id,
      detailKey = detailKey,
      relevant = relevant,
      whisperIndexes = whisperIndexes,
    }
    if relevant then relevantCount = relevantCount + 1 end
  end
end

if relevantCount > 0 then
  if not isZsetOrMissing(KEYS[3]) then
    return redis.error_reply('freshness index has wrong type')
  end
  local current = redis.call('GET', KEYS[2]) or '0'
  if not string.match(current, '^%d+$') or string.len(current) > string.len(maxWatermark) then
    return redis.error_reply('freshness watermark exhausted')
  end

  local planned = current
  for _ = 1, relevantCount do
    if string.len(planned) == string.len(maxWatermark) and planned >= maxWatermark then
      return redis.error_reply('freshness watermark exhausted')
    end
    planned = incrementDecimal(planned)
  end
end

for _, candidate in ipairs(candidates) do
  redis.call('HSET', candidate.detailKey, 'revealedAt', ARGV[2])
  for _, whisperKey in ipairs(candidate.whisperIndexes) do
    redis.call('ZREM', whisperKey, candidate.id)
  end
  if candidate.relevant then
    redis.call('INCR', KEYS[2])
    local revision = redis.call('GET', KEYS[2])
    redis.call('HSET', candidate.detailKey, 'appendWatermark', revision)
    redis.call('ZADD', KEYS[3], revision, candidate.id)
  end
end
return #candidates
`;

function parseWatermark(value: string): ThreadAppendWatermark {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid freshness watermark: ${value}`);
  return value as ThreadAppendWatermark;
}

function maxWatermark(...values: string[]): ThreadAppendWatermark {
  let latest = 0n;
  for (const value of values) {
    if (!value) continue;
    const parsed = BigInt(value);
    if (parsed > latest) latest = parsed;
  }
  return latest.toString(10) as ThreadAppendWatermark;
}

function rowsWithScores(rows: string[]): Array<{ id: string; watermark: ThreadAppendWatermark }> {
  const result: Array<{ id: string; watermark: ThreadAppendWatermark }> = [];
  for (let index = 0; index + 1 < rows.length; index += 2) {
    result.push({ id: rows[index]!, watermark: parseWatermark(rows[index + 1]!) });
  }
  return result;
}

export class RedisMessageStore {
  private readonly redis: RedisClient;
  /** null means no expiration/pruning (persistent retention). */
  private readonly ttlSeconds: number | null;
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;

  constructor(
    redis: RedisClient,
    options?: {
      ttlSeconds?: number;
      onAppend?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'timestamp' | 'content'>) => void;
    },
  ) {
    this.redis = redis;
    this.onAppend = options?.onAppend;
    const raw = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(raw) || raw <= 0) {
      this.ttlSeconds = null;
    } else {
      this.ttlSeconds = Math.floor(raw);
    }
  }

  private notifyAppend(stored: StoredMessage): void {
    if (!this.onAppend) return;
    try {
      void Promise.resolve(this.onAppend(stored)).catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  /** Resolve ioredis keyPrefix (SCAN doesn't auto-apply it) */
  private get keyPrefix(): string {
    return (this.redis.options as { keyPrefix?: string }).keyPrefix ?? '';
  }

  /** Strip keyPrefix from a raw SCAN key for use with normal commands (which auto-prefix) */
  private stripPrefix(rawKey: string): string {
    const p = this.keyPrefix;
    return p && rawKey.startsWith(p) ? rawKey.slice(p.length) : rawKey;
  }

  async captureFreshnessWatermark(threadId: string, audience: FreshnessAudience): Promise<ThreadAppendWatermark> {
    const [publicRows, whisperRows] = await Promise.all([
      this.redis.zrevrange(MessageKeys.freshnessPublic(threadId), 0, 0, 'WITHSCORES'),
      this.redis.zrevrange(MessageKeys.freshnessWhisper(threadId, audience.catId), 0, 0, 'WITHSCORES'),
    ]);
    return maxWatermark(publicRows[1] ?? '0', whisperRows[1] ?? '0');
  }

  async getFreshnessDelta(
    threadId: string,
    audience: FreshnessAudience,
    after: ThreadAppendWatermark,
    through?: ThreadAppendWatermark,
    limit: number = DEFAULT_LIMIT,
  ): Promise<FreshnessDelta> {
    parseWatermark(after);
    const requestedWatermark = through
      ? parseWatermark(through)
      : await this.captureFreshnessWatermark(threadId, audience);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    const fetchLimit = safeLimit + 1;
    const min = `(${after}`;

    const [publicRows, whisperRows] = await Promise.all([
      this.redis.zrangebyscore(
        MessageKeys.freshnessPublic(threadId),
        min,
        requestedWatermark,
        'WITHSCORES',
        'LIMIT',
        0,
        fetchLimit,
      ),
      this.redis.zrangebyscore(
        MessageKeys.freshnessWhisper(threadId, audience.catId),
        min,
        requestedWatermark,
        'WITHSCORES',
        'LIMIT',
        0,
        fetchLimit,
      ),
    ]);

    const byId = new Map<string, ThreadAppendWatermark>();
    for (const row of [...rowsWithScores(publicRows), ...rowsWithScores(whisperRows)]) {
      const existing = byId.get(row.id);
      if (!existing || BigInt(row.watermark) > BigInt(existing)) byId.set(row.id, row.watermark);
    }
    const candidates = [...byId.entries()].sort((left, right) => {
      const a = BigInt(left[1]);
      const b = BigInt(right[1]);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const { ids, privateBarrier } = await this.selectFreshnessDeltaIds(candidates, safeLimit);
    const messages = (await this.hydrateMessages(ids)).filter(isFreshnessRelevantMessage);
    const lastReturned = messages[messages.length - 1];
    return {
      // The review cursor may only cover messages materialized in this page.
      observedWatermark: lastReturned?.appendWatermark ?? after,
      messages,
      truncated: privateBarrier || candidates.length > messages.length,
    };
  }

  private async selectFreshnessDeltaIds(
    candidates: Array<[string, ThreadAppendWatermark]>,
    limit: number,
  ): Promise<{ ids: string[]; privateBarrier: boolean }> {
    const structuralReads = this.redis.multi();
    for (const [id] of candidates) {
      structuralReads.hmget(MessageKeys.detail(id), 'deliveryStatus', 'freshnessReviewPublication');
    }
    const results = (await structuralReads.exec()) as Array<[Error | null, [string | null, string | null]]> | null;
    const ids: string[] = [];
    for (const [index, [id]] of candidates.entries()) {
      const result = results?.[index];
      if (!result || result[0] || !Array.isArray(result[1])) {
        // Structural metadata must be readable before any private draft hash is hydrated.
        return { ids, privateBarrier: true };
      }
      const [deliveryStatus, marker] = result[1];
      const isPrivate = isPendingFreshnessReviewPublication(
        deliveryStatus as StoredMessage['deliveryStatus'],
        marker === '1',
      );
      if (isPrivate) return { ids, privateBarrier: true };
      ids.push(id);
      if (ids.length >= limit) break;
    }
    return { ids, privateBarrier: false };
  }

  async appendIfFresh(
    msg: AppendMessageInput,
    gate: { baseline: ThreadAppendWatermark; audience: FreshnessAudience; groupId?: string },
  ): Promise<ConditionalAppendResult> {
    parseWatermark(gate.baseline);
    return this.appendAtomically(msg, gate);
  }

  async append(msg: AppendMessageInput): Promise<StoredMessage> {
    const result = await this.appendAtomically(msg);
    if (result.outcome === 'stale') {
      throw new Error('ordinary append unexpectedly evaluated as stale');
    }
    return result.message;
  }

  async claimFreshnessSideEffect(input: FreshnessSideEffectClaimInput): Promise<FreshnessSideEffectClaimResult> {
    parseWatermark(input.baseline);
    const raw = (await this.redis.eval(
      CLAIM_FRESHNESS_SIDE_EFFECT_LUA,
      4,
      MessageKeys.freshnessSideEffectClaim(input.idempotencyKey),
      MessageKeys.freshnessPublic(input.threadId),
      MessageKeys.freshnessWhisper(input.threadId, input.audience.catId),
      MessageKeys.detail(''),
      input.baseline,
      input.groupId ?? '',
      String(24 * 60 * 60),
    )) as [string, string, string];
    const [outcome, replayed, observed] = raw;
    const observedWatermark = parseWatermark(observed);
    if (outcome === 'stale') {
      return { outcome: 'stale', baseline: input.baseline, observedWatermark };
    }
    if (outcome !== 'claimed') throw new Error(`Unexpected freshness side-effect claim outcome: ${outcome}`);
    return { outcome: 'claimed', observedWatermark, replayed: replayed === '1' };
  }

  async abortFreshnessSideEffect(idempotencyKey: string): Promise<void> {
    await this.redis.del(MessageKeys.freshnessSideEffectClaim(idempotencyKey));
  }

  private async appendAtomically(
    msg: AppendMessageInput,
    gate?: { baseline: ThreadAppendWatermark; audience: FreshnessAudience; groupId?: string },
  ): Promise<ConditionalAppendResult> {
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    const id = generateSortableId(msg.timestamp);
    const idempotencyIndexKey = msg.idempotencyKey
      ? MessageKeys.idempotency(msg.userId, threadId, msg.idempotencyKey)
      : null;
    const {
      idempotencyKey: _idempotencyKey,
      appendWatermark: _appendWatermark,
      freshnessReviewPublication,
      ...payload
    } = msg;
    void _idempotencyKey;
    void _appendWatermark;
    const stored: StoredMessage = { ...payload, id, threadId };
    const relevant = isFreshnessRelevantMessage(stored);
    const effectiveVisibility = stored.visibility === 'whisper' && !stored.revealedAt ? 'whisper' : 'public';
    const mentionKeys = [...new Set(stored.mentions.map((catId) => MessageKeys.mentions(catId)))];
    const whisperKeys =
      effectiveVisibility === 'whisper'
        ? [...new Set((stored.whisperTo ?? []).map((catId) => MessageKeys.freshnessWhisper(threadId, catId)))]
        : [];
    const hashKey = MessageKeys.detail(id);
    const gateWhisperKey = gate
      ? MessageKeys.freshnessWhisper(threadId, gate.audience.catId)
      : MessageKeys.freshnessPublic(threadId);
    const keys = [
      hashKey,
      MessageKeys.TIMELINE,
      MessageKeys.user(stored.userId),
      MessageKeys.thread(threadId),
      idempotencyIndexKey ?? hashKey,
      MessageKeys.freshnessSequence(threadId),
      MessageKeys.freshnessPublic(threadId),
      gateWhisperKey,
      ...mentionKeys,
      ...whisperKeys,
    ];
    const hashFields: Record<string, string> = {
      id,
      threadId,
      userId: stored.userId,
      catId: stored.catId ?? '',
      content: stored.content,
      contentBlocks: stored.contentBlocks ? JSON.stringify(stored.contentBlocks) : '',
      toolEvents: stored.toolEvents ? JSON.stringify(stored.toolEvents) : '',
      metadata: stored.metadata ? JSON.stringify(stored.metadata) : '',
      extra: stored.extra ? serializeExtra(stored.extra) : '',
      mentions: JSON.stringify(stored.mentions),
      timestamp: String(stored.timestamp),
      ...(stored.messageClass ? { messageClass: stored.messageClass } : {}),
      ...(stored.editedAt ? { editedAt: String(stored.editedAt) } : {}),
      ...(stored.thinking ? { thinking: stored.thinking } : {}),
      ...(stored.origin ? { origin: stored.origin } : {}),
      ...(stored.visibility ? { visibility: stored.visibility } : {}),
      ...(stored.whisperTo ? { whisperTo: JSON.stringify(stored.whisperTo) } : {}),
      ...(stored.revealedAt ? { revealedAt: String(stored.revealedAt) } : {}),
      ...(stored.source ? { source: JSON.stringify(stored.source) } : {}),
      ...(stored.mentionsUser ? { mentionsUser: '1' } : {}),
      ...(stored.deliveredAt ? { deliveredAt: String(stored.deliveredAt) } : {}),
      ...(stored.deliveryStatus ? { deliveryStatus: stored.deliveryStatus } : {}),
      ...(freshnessReviewPublication ? { freshnessReviewPublication: '1' } : {}),
      ...(stored.replyTo ? { replyTo: stored.replyTo } : {}),
      ...(stored.extra?.stream?.invocationId ? { freshnessGroupId: stored.extra.stream.invocationId } : {}),
    };
    const ttl = this.ttlSeconds ?? 0;

    // A stale legacy idempotency pointer may predate the atomic script. Retry
    // once after removing it; new pointers cannot dangle because Lua writes the
    // pointer and message in the same transaction.
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = (await this.redis.eval(
        APPEND_MESSAGE_LUA,
        keys.length,
        ...keys,
        gate ? 'conditional' : 'append',
        gate?.baseline ?? ('0' as ThreadAppendWatermark),
        id,
        String(stored.timestamp),
        JSON.stringify(hashFields),
        relevant ? '1' : '0',
        effectiveVisibility,
        String(ttl),
        idempotencyIndexKey ? '1' : '0',
        String(mentionKeys.length),
        String(whisperKeys.length),
        gate && isFreshnessProtectedPublication(stored) ? '1' : '0',
        gate?.groupId ?? '',
      )) as unknown;
      if (!Array.isArray(raw) || raw.length < 3) throw new Error('invalid Redis append result');
      const [kind, resultId, rawWatermark] = raw.map((value) => String(value));

      if (kind === 'stale') {
        return {
          outcome: 'stale',
          baseline: gate!.baseline,
          observedWatermark: parseWatermark(rawWatermark!),
        };
      }
      if (kind === 'existing') {
        const existing = await this.getByIdRaw(resultId!);
        if (existing) {
          const committedWatermark =
            existing.appendWatermark ??
            (gate ? await this.captureFreshnessWatermark(threadId, gate.audience) : ('0' as ThreadAppendWatermark));
          return { outcome: 'appended', message: existing, committedWatermark, replayed: true };
        }
        if (idempotencyIndexKey && attempt === 0) {
          await this.redis.eval(
            COMPARE_DELETE_IDEMPOTENCY_LUA,
            2,
            idempotencyIndexKey,
            MessageKeys.detail(resultId!),
            resultId!,
          );
          continue;
        }
        throw new Error('message idempotency key points to a missing message');
      }
      if (kind !== 'appended') throw new Error(`unknown Redis append result: ${kind}`);

      if (rawWatermark) stored.appendWatermark = parseWatermark(rawWatermark);
      const committedWatermark =
        stored.appendWatermark ??
        (gate ? await this.captureFreshnessWatermark(threadId, gate.audience) : ('0' as ThreadAppendWatermark));

      if (isDelivered(stored)) this.notifyAppend(stored);
      return { outcome: 'appended', message: stored, committedWatermark };
    }

    throw new Error('message idempotency retry exhausted');
  }

  private freshnessIndexKeysForMessage(msg: StoredMessage): string[] {
    if (!msg.appendWatermark) return [];
    if (msg.visibility === 'whisper' && !msg.revealedAt) {
      return [...new Set((msg.whisperTo ?? []).map((catId) => MessageKeys.freshnessWhisper(msg.threadId, catId)))];
    }
    return [MessageKeys.freshnessPublic(msg.threadId)];
  }

  async getById(id: string): Promise<StoredMessage | null> {
    return this.getByIdWithMode(id, 'public');
  }

  async getByIdForFreshnessRelease(id: string): Promise<StoredMessage | null> {
    return this.getByIdRaw(id);
  }

  private async getByIdRaw(id: string): Promise<StoredMessage | null> {
    return this.getByIdWithMode(id, 'raw');
  }

  private async getByIdWithMode(id: string, mode: 'public' | 'raw'): Promise<StoredMessage | null> {
    const data = await this.redis.hgetall(MessageKeys.detail(id));
    if (!data || !data.id) return null;
    const pendingReviewPublication = isPendingFreshnessReviewPublication(
      data.deliveryStatus as StoredMessage['deliveryStatus'],
      data.freshnessReviewPublication === '1',
    );
    if (mode === 'public' && pendingReviewPublication) return null;

    const contentBlocks = safeParseContentBlocks(data.contentBlocks);
    const toolEvents = safeParseToolEvents(data.toolEvents);
    const parsedMetadata = safeParseMetadata(data.metadata);
    const parsedExtra = safeParseExtra(data.extra);
    const parsedSource = safeParseConnectorSource(data.source);
    const deletedAt = data.deletedAt ? parseInt(data.deletedAt, 10) : undefined;
    const editedAt = data.editedAt ? parseInt(data.editedAt, 10) : undefined;
    return {
      id: data.id,
      threadId: data.threadId || DEFAULT_THREAD_ID,
      userId: data.userId ?? 'unknown',
      catId: (data.catId || null) as CatId | null,
      content: data.content ?? '',
      ...(data.messageClass === 'status' || data.messageClass === 'substantive'
        ? { messageClass: data.messageClass }
        : {}),
      ...(data.appendWatermark && /^\d+$/.test(data.appendWatermark)
        ? { appendWatermark: data.appendWatermark as ThreadAppendWatermark }
        : {}),
      ...(contentBlocks ? { contentBlocks } : {}),
      ...(toolEvents ? { toolEvents } : {}),
      ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
      ...(parsedExtra ? { extra: parsedExtra } : {}),
      mentions: safeParseMentions(data.mentions),
      timestamp: parseInt(data.timestamp ?? '0', 10),
      ...(editedAt ? { editedAt } : {}),
      ...(deletedAt ? { deletedAt, deletedBy: data.deletedBy ?? '' } : {}),
      ...(data._tombstone === '1' ? { _tombstone: true as const } : {}),
      ...(data.thinking ? { thinking: data.thinking } : {}),
      ...(data.origin === 'stream' ||
      data.origin === 'callback' ||
      data.origin === 'briefing' ||
      data.origin === 'progress'
        ? { origin: data.origin as 'stream' | 'callback' | 'briefing' | 'progress' }
        : {}),
      ...(data.visibility === 'whisper' ? { visibility: 'whisper' as const } : {}),
      ...(data.whisperTo ? { whisperTo: safeParseMentions(data.whisperTo) } : {}),
      ...(data.revealedAt ? { revealedAt: parseInt(data.revealedAt, 10) } : {}),
      ...(data.deliveredAt ? { deliveredAt: parseInt(data.deliveredAt, 10) } : {}),
      ...(data.deliveryStatus ? { deliveryStatus: data.deliveryStatus as StoredMessage['deliveryStatus'] } : {}),
      ...(parsedSource ? { source: parsedSource } : {}),
      ...(data.mentionsUser === '1' ? { mentionsUser: true } : {}),
      ...(data.replyTo ? { replyTo: data.replyTo } : {}),
    };
  }

  /** Scan all stored message hashes (Redis-only repair helper). */
  async scanAll(): Promise<StoredMessage[]> {
    const matchPattern = `${this.keyPrefix}${MessageKeys.detail('*')}`;
    const messages: StoredMessage[] = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        const pipeline = this.redis.pipeline();
        for (const key of keys) {
          pipeline.hgetall(this.stripPrefix(key));
        }
        const results = await pipeline.exec();
        for (const entry of results ?? []) {
          const [err, data] = entry!;
          if (err || !data || typeof data !== 'object') continue;
          const d = data as Record<string, string>;
          if (!d.id) continue;
          const msg = await this.getById(d.id);
          if (msg) messages.push(msg);
        }
      }
    } while (cursor !== '0');
    return messages;
  }

  /** Reassign a message to a different userId and move user-timeline membership. */
  async reassignUserId(id: string, nextUserId: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    if (msg.userId === nextUserId) return msg;

    const oldUserKey = MessageKeys.user(msg.userId);
    const newUserKey = MessageKeys.user(nextUserId);
    const score = (await this.redis.zscore(oldUserKey, id)) ?? String(msg.deliveredAt ?? msg.timestamp);

    const pipeline = this.redis.multi();
    pipeline.hset(MessageKeys.detail(id), { userId: nextUserId });
    pipeline.zrem(oldUserKey, id);
    pipeline.zadd(newUserKey, score, id);
    if (this.ttlSeconds !== null) {
      pipeline.expire(newUserKey, this.ttlSeconds);
    }
    await pipeline.exec();

    msg.userId = nextUserId;
    return msg;
  }

  async getRecent(limit?: number, userId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = userId ? MessageKeys.user(userId) : MessageKeys.TIMELINE;
    return this.fetchDeliveredDesc(key, n);
  }

  /**
   * Get mentions for a cat, ascending (oldest first after cursor).
   * When afterMessageId is provided, only returns mentions after that ID.
   * Cursor fallback: if afterMessageId not in sorted set (TTL/delete), falls back to full scan (#77 R2 P2).
   */
  async getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const mentionKey = MessageKeys.mentions(catId);

    // Cursor fallback: verify afterMessageId exists in the sorted set
    let effectiveAfter = afterMessageId;
    if (effectiveAfter) {
      const rank = await this.redis.zrank(mentionKey, effectiveAfter);
      if (rank === null) {
        log.warn({ cursor: effectiveAfter, catId }, 'cursor not in mention set, falling back to full pending');
        effectiveAfter = undefined;
      }
    }

    // Ascending scan: collect oldest N mentions after cursor
    const CHUNK = 50;
    const ids: string[] = [];
    let startIndex = 0;

    if (effectiveAfter) {
      // Find the rank of afterMessageId and start scanning after it
      const rank = await this.redis.zrank(mentionKey, effectiveAfter);
      if (rank !== null) {
        startIndex = rank + 1; // Start after the cursor
      }
    }

    // Scan forward (ascending) in chunks
    let offset = startIndex;
    while (ids.length < n) {
      const chunk = await this.redis.zrange(mentionKey, offset, offset + CHUNK - 1);
      if (chunk.length === 0) break;
      for (const id of chunk) {
        if (ids.length >= n) break;
        // Extra safety: skip IDs <= afterMessageId (handles edge cases)
        if (effectiveAfter && id <= effectiveAfter) continue;
        if (userId) {
          const score = await this.redis.zscore(MessageKeys.user(userId), id);
          if (score === null) continue;
        }
        if (threadId) {
          const score = await this.redis.zscore(MessageKeys.thread(threadId), id);
          if (score === null) continue;
        }
        ids.push(id);
      }
      offset += CHUNK;
    }

    if (ids.length === 0) return [];
    const messages = await this.hydrateMessages(ids); // Already ascending
    return messages.filter(isDelivered);
  }

  /**
   * Get the most recent N mentions for a cat, ascending within the returned window (oldest→newest).
   */
  async getRecentMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const mentionKey = MessageKeys.mentions(catId);

    const CHUNK = 50;
    const ids: string[] = [];
    let offset = 0;

    // Scan backward (descending) in chunks and filter down to the most recent N matches.
    while (ids.length < n) {
      const chunk = await this.redis.zrevrange(mentionKey, offset, offset + CHUNK - 1);
      if (chunk.length === 0) break;
      for (const id of chunk) {
        if (ids.length >= n) break;
        if (userId) {
          const score = await this.redis.zscore(MessageKeys.user(userId), id);
          if (score === null) continue;
        }
        if (threadId) {
          const score = await this.redis.zscore(MessageKeys.thread(threadId), id);
          if (score === null) continue;
        }
        ids.push(id);
      }
      offset += CHUNK;
    }

    if (ids.length === 0) return [];
    const messages = await this.hydrateMessages(ids.reverse());
    return messages.filter(isDelivered);
  }

  async getBefore(timestamp: number, limit?: number, userId?: string, beforeId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = userId ? MessageKeys.user(userId) : MessageKeys.TIMELINE;

    if (!beforeId) {
      // F117: Chunked scan (desc) to collect N delivered messages
      const CHUNK = Math.max(n, 50);
      const result: StoredMessage[] = []; // desc order (newest first)
      let offset = 0;
      while (result.length < n) {
        const ids = await this.redis.zrevrangebyscore(key, `(${timestamp}`, '-inf', 'LIMIT', offset, CHUNK);
        if (ids.length === 0) break;
        // Keep desc order — don't reverse
        const messages = await this.hydrateMessages(ids);
        for (const msg of messages) {
          if (isDelivered(msg)) result.push(msg);
          if (result.length >= n) break;
        }
        if (ids.length < CHUNK) break;
        offset += CHUNK;
      }
      // Take first N (newest) and reverse to ascending
      return result.slice(0, n).reverse();
    }

    // F117: Scan cursor path with integrated isDelivered filtering
    const result = await this.fetchDeliveredBeforeCursor(key, timestamp, beforeId, n);
    return result.reverse();
  }

  async getByThread(threadId: string, limit?: number, userId?: string): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = MessageKeys.thread(threadId);
    return this.fetchDeliveredDesc(key, n, userId ? (m) => m.userId === userId || isSystemUserMessage(m) : undefined);
  }

  /**
   * Get messages in a thread after a cursor ID (exclusive), oldest first.
   * If afterId is undefined, returns from thread start.
   * If limit is undefined, returns all matches.
   */
  async getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
  ): Promise<StoredMessage[]> {
    const key = MessageKeys.thread(threadId);

    let ids: string[];
    if (!afterId) {
      if (limit && limit > 0) {
        ids = await this.redis.zrange(key, 0, limit - 1);
      } else {
        ids = await this.redis.zrange(key, 0, -1);
      }
    } else {
      const afterScore = await this.redis.zscore(key, afterId);
      if (afterScore === null) {
        // Cursor message may have expired; fall back to lexicographic ID filtering.
        ids = await this.redis.zrange(key, 0, -1);
        ids = ids.filter((id) => id > afterId);
      } else {
        // Split into two ranges to avoid filtering by ID across different
        // scores — deliveredAt can shift a message's score forward while
        // its ID still embeds the original send timestamp.
        // 1) Same score as cursor: use ID as tiebreaker
        const sameScore = await this.redis.zrangebyscore(key, afterScore, afterScore);
        const sameFiltered = sameScore.filter((id) => id !== afterId && id > afterId);
        // 2) Strictly higher scores: include all (no ID filter needed)
        const higherScore = await this.redis.zrangebyscore(key, `(${afterScore}`, '+inf');
        ids = [...sameFiltered, ...higherScore];
      }
      if (limit && limit > 0 && ids.length > limit) {
        ids = ids.slice(0, limit);
      }
    }

    if (ids.length === 0) return [];

    // ADR-008 D3: cursor path must include deleted messages (tombstones)
    const messages = await this.hydrateMessages(ids, { includeDeleted: true });
    const delivered = messages.filter(isDelivered);
    if (!userId) return delivered;
    return delivered.filter((m) => m.userId === userId || isSystemUserMessage(m));
  }

  async getLatestThreadWatermarkMessageId(threadId: string): Promise<string | undefined> {
    const key = MessageKeys.thread(threadId);
    const chunkSize = 50;
    let offset = 0;
    let latest: string | undefined;
    while (true) {
      const ids = await this.redis.zrange(key, offset, offset + chunkSize - 1);
      if (ids.length === 0) return latest;
      const messages = await this.hydrateMessages(ids, { includeDeleted: true });
      for (const message of messages) {
        if (isDelivered(message) && (!latest || message.id > latest)) latest = message.id;
      }
      if (ids.length < chunkSize) return latest;
      offset += chunkSize;
    }
  }

  async getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
  ): Promise<StoredMessage[]> {
    const n = limit ?? DEFAULT_LIMIT;
    const key = MessageKeys.thread(threadId);
    const userFilter = userId ? (m: StoredMessage) => m.userId === userId || isSystemUserMessage(m) : undefined;

    if (!beforeId) {
      // F117: Chunked desc scan — collect N delivered, scan until full or exhausted
      const CHUNK = Math.max(n, 50);
      const result: StoredMessage[] = []; // desc order (newest first)
      let offset = 0;
      while (result.length < n) {
        const ids = await this.redis.zrevrangebyscore(key, `(${timestamp}`, '-inf', 'LIMIT', offset, CHUNK);
        if (ids.length === 0) break;
        // Keep desc order — don't reverse
        const messages = await this.hydrateMessages(ids);
        for (const msg of messages) {
          if (!isDelivered(msg)) continue;
          if (userFilter && !userFilter(msg)) continue;
          result.push(msg);
          if (result.length >= n) break;
        }
        if (ids.length < CHUNK) break;
        offset += CHUNK;
      }
      return result.slice(0, n).reverse();
    }

    // F117: Scan cursor path with integrated isDelivered + user filtering
    const result = await this.fetchDeliveredBeforeCursor(key, timestamp, beforeId, n, userFilter);
    return result.reverse();
  }

  /**
   * F117: Scan a sorted set in reverse (newest first), hydrate + filter by isDelivered,
   * collecting up to `n` delivered messages. Returns messages in ascending order (oldest first).
   * Scans until N delivered collected or sorted set exhausted.
   */
  private async fetchDeliveredDesc(
    key: string,
    n: number,
    extraFilter?: (msg: StoredMessage) => boolean,
  ): Promise<StoredMessage[]> {
    const CHUNK = Math.max(n, 50);
    const result: StoredMessage[] = []; // Collects in desc order (newest first)
    let offset = 0;

    while (result.length < n) {
      const ids = await this.redis.zrevrange(key, offset, offset + CHUNK - 1);
      if (ids.length === 0) break; // Sorted set exhausted

      // Hydrate in desc order (don't reverse — preserve newest-first)
      const messages = await this.hydrateMessages(ids);
      for (const msg of messages) {
        if (!isDelivered(msg)) continue;
        if (extraFilter && !extraFilter(msg)) continue;
        result.push(msg);
        if (result.length >= n) break;
      }

      // If Redis returned fewer than CHUNK, the set is exhausted
      if (ids.length < CHUNK) break;
      offset += CHUNK;
    }

    // Take first N (newest) and reverse to ascending order
    return result.slice(0, n).reverse();
  }

  /**
   * Fetch IDs before a composite cursor (timestamp + beforeId) using chunked scanning.
   * Loops until we have `limit` results or exhaust the sorted set.
   */
  private async fetchBeforeWithCursor(
    key: string,
    timestamp: number,
    beforeId: string,
    limit: number,
  ): Promise<string[]> {
    const CHUNK = 50;
    const filtered: string[] = [];
    let offset = 0;

    while (filtered.length < limit) {
      const chunk = await this.redis.zrevrangebyscore(key, String(timestamp), '-inf', 'LIMIT', offset, CHUNK);
      if (chunk.length === 0) break;

      for (const id of chunk) {
        if (filtered.length >= limit) break;
        const score = await this.redis.zscore(key, id);
        if (score !== null && parseInt(score, 10) === timestamp && id >= beforeId) {
          continue;
        }
        filtered.push(id);
      }

      offset += CHUNK;
    }

    return filtered;
  }

  /**
   * F117: Scan before a cursor (desc), hydrate + filter by isDelivered + optional extra,
   * collecting exactly N delivered messages or until sorted set exhausted.
   * Returns messages in desc order (newest first). Caller must reverse for asc.
   */
  private async fetchDeliveredBeforeCursor(
    key: string,
    timestamp: number,
    beforeId: string,
    n: number,
    extraFilter?: (msg: StoredMessage) => boolean,
  ): Promise<StoredMessage[]> {
    const CHUNK = 50;
    const result: StoredMessage[] = [];
    let offset = 0;

    while (result.length < n) {
      const chunk = await this.redis.zrevrangebyscore(key, String(timestamp), '-inf', 'LIMIT', offset, CHUNK);
      if (chunk.length === 0) break;

      // Filter cursor boundary (same logic as fetchBeforeWithCursor)
      const validIds: string[] = [];
      for (const id of chunk) {
        const score = await this.redis.zscore(key, id);
        if (score !== null && Number.parseInt(score, 10) === timestamp && id >= beforeId) {
          continue;
        }
        validIds.push(id);
      }

      if (validIds.length > 0) {
        // Hydrate in desc order (don't reverse)
        const messages = await this.hydrateMessages(validIds);
        for (const msg of messages) {
          if (!isDelivered(msg)) continue;
          if (extraFilter && !extraFilter(msg)) continue;
          result.push(msg);
          if (result.length >= n) break;
        }
      }

      if (chunk.length < CHUNK) break;
      offset += CHUNK;
    }

    return result;
  }

  /**
   * Delete all messages in a thread. Returns count of deleted messages.
   */
  async deleteByThread(threadId: string): Promise<number> {
    const key = MessageKeys.thread(threadId);

    // Get all message IDs in this thread
    const ids = await this.redis.zrange(key, 0, -1);
    if (ids.length === 0) return 0;

    const pipeline = this.redis.multi();

    // Delete each message hash
    for (const id of ids) {
      pipeline.del(MessageKeys.detail(id));
    }

    // Delete the thread sorted set
    pipeline.del(key);
    pipeline.del(MessageKeys.freshnessPublic(threadId));

    // Note: We don't clean up global timeline, user timeline, or mention sets
    // as those will auto-expire via TTL. Cleaning them would be O(n) expensive.
    //
    // MessageKeys.freshnessSequence is deliberately kept as an ABA tombstone
    // (mirrors the in-memory MessageStore): if this thread id is ever reused, a
    // still-running old invocation must not become fresh again.

    await pipeline.exec();

    await this.deleteByPattern(MessageKeys.freshnessWhisper(threadId, '*'));
    // Idempotency indexes are keyed by (userId, threadId, key) and have no TTL, so
    // they outlive the messages they point at unless cleaned here. The in-memory
    // store prunes them in deleteByThread; keep both implementations aligned.
    await this.deleteByPattern(MessageKeys.idempotency('*', threadId, '*'));
    return ids.length;
  }

  /** SCAN + DEL every key matching a bare (unprefixed) pattern. */
  private async deleteByPattern(pattern: string): Promise<void> {
    const matchPattern = `${this.keyPrefix}${pattern}`;
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) await this.redis.del(...keys.map((entry) => this.stripPrefix(entry)));
    } while (cursor !== '0');
  }

  /**
   * ADR-008 D3: Soft delete — set deletedAt/deletedBy on message hash.
   */
  async softDelete(id: string, deletedBy: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const now = Date.now();
    const pipeline = this.redis.multi();
    pipeline.hset(MessageKeys.detail(id), {
      deletedAt: String(now),
      deletedBy,
    });
    for (const key of this.freshnessIndexKeysForMessage(msg)) pipeline.zrem(key, id);
    await pipeline.exec();
    msg.deletedAt = now;
    msg.deletedBy = deletedBy;
    return msg;
  }

  /**
   * ADR-008 D3: Hard delete — wipe content, keep tombstone skeleton.
   */
  async hardDelete(id: string, deletedBy: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const now = Date.now();
    const pipeline = this.redis.multi();
    pipeline.hset(MessageKeys.detail(id), {
      content: '',
      contentBlocks: '',
      toolEvents: '',
      metadata: '',
      extra: '',
      thinking: '',
      editedAt: '',
      mentions: '[]',
      deletedAt: String(now),
      deletedBy,
      _tombstone: '1',
    });
    for (const key of this.freshnessIndexKeysForMessage(msg)) pipeline.zrem(key, id);
    await pipeline.exec();
    msg.content = '';
    msg.mentions = [];
    delete msg.contentBlocks;
    delete msg.toolEvents;
    delete msg.metadata;
    delete msg.extra;
    delete msg.thinking;
    delete msg.editedAt;
    msg.deletedAt = now;
    msg.deletedBy = deletedBy;
    msg._tombstone = true;
    return msg;
  }

  /**
   * ADR-008 D3: Restore a soft-deleted message — remove deletedAt/deletedBy.
   * Rejects tombstones (hard-deleted messages are irreversible).
   */
  async restore(id: string): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg || !msg.deletedAt || msg._tombstone) return null;
    const relevant = isFreshnessRelevantMessage({ ...msg, deletedAt: undefined });
    const indexKeys = relevant
      ? msg.visibility === 'whisper' && !msg.revealedAt
        ? [...new Set((msg.whisperTo ?? []).map((catId) => MessageKeys.freshnessWhisper(msg.threadId, catId)))]
        : [MessageKeys.freshnessPublic(msg.threadId)]
      : [];
    const revision = String(
      await this.redis.eval(
        RESTORE_MESSAGE_LUA,
        2 + indexKeys.length,
        MessageKeys.detail(id),
        MessageKeys.freshnessSequence(msg.threadId),
        ...indexKeys,
        relevant ? '1' : '0',
        id,
      ),
    );
    if (!revision) return null;
    delete msg.deletedAt;
    delete msg.deletedBy;
    if (revision !== '0') msg.appendWatermark = parseWatermark(revision);
    return msg;
  }

  /**
   * F35: Reveal all unrevealed whispers in a thread. Returns count of revealed messages.
   */
  async revealWhispers(threadId: string, userId: string): Promise<number> {
    return Number(
      await this.redis.eval(
        REVEAL_WHISPERS_LUA,
        5,
        MessageKeys.thread(threadId),
        MessageKeys.freshnessSequence(threadId),
        MessageKeys.freshnessPublic(threadId),
        MessageKeys.detail(''),
        MessageKeys.freshnessWhisper(threadId, ''),
        userId,
        String(Date.now()),
      ),
    );
  }

  /** F096: Update message extra data (merge semantics — preserves existing fields). */
  async updateExtra(id: string, extra: NonNullable<StoredMessage['extra']>): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const merged = { ...msg.extra, ...extra };
    await this.redis.hset(MessageKeys.detail(id), { extra: serializeExtra(merged) });
    msg.extra = merged;
    return msg;
  }

  async updateContent(id: string, content: string, editedAt: number): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    await this.redis.hset(MessageKeys.detail(id), {
      content,
      editedAt: String(editedAt),
    });
    msg.content = content;
    msg.editedAt = editedAt;
    return msg;
  }

  async augmentStreamMetadata(id: string, patch: StreamMetadataAugmentInput): Promise<StoredMessage | null> {
    const msg = await this.getById(id);
    if (!msg) return null;
    const augmented = applyStreamMetadataAugment(msg, patch);
    const fields: Record<string, string> = {};
    if (patch.thinking && augmented.thinking) fields.thinking = augmented.thinking;
    if (patch.metadata && augmented.metadata) fields.metadata = JSON.stringify(augmented.metadata);
    if (patch.toolEvents?.length && augmented.toolEvents) fields.toolEvents = JSON.stringify(augmented.toolEvents);
    if (patch.replyTo && augmented.replyTo) fields.replyTo = augmented.replyTo;
    if (patch.mentionsUser && augmented.mentionsUser) fields.mentionsUser = '1';
    if (patch.extra && augmented.extra) fields.extra = serializeExtra(augmented.extra);
    if (Object.keys(fields).length > 0) {
      await this.redis.hset(MessageKeys.detail(id), fields);
    }
    return augmented;
  }

  /** F098-D: Mark a queued message as delivered (set deliveredAt timestamp). */
  async markDelivered(id: string, deliveredAt: number): Promise<StoredMessage | null> {
    return this.deliverQueuedMessage(id, deliveredAt, false);
  }

  async releaseFreshnessReviewPublication(id: string, deliveredAt: number): Promise<StoredMessage | null> {
    return this.deliverQueuedMessage(id, deliveredAt, true);
  }

  private async deliverQueuedMessage(
    id: string,
    deliveredAt: number,
    freshnessReviewRelease: boolean,
  ): Promise<StoredMessage | null> {
    const msg = await this.getByIdRaw(id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return msg; // only transition queued → delivered
    const changed = (await this.redis.eval(
      MARK_DELIVERED_LUA,
      4,
      MessageKeys.detail(id),
      MessageKeys.thread(msg.threadId),
      MessageKeys.TIMELINE,
      MessageKeys.user(msg.userId),
      String(deliveredAt),
      id,
      freshnessReviewRelease ? '1' : '0',
    )) as number;
    if (changed !== 1) return this.getByIdRaw(id);
    msg.deliveredAt = deliveredAt;
    msg.deliveryStatus = 'delivered';
    this.notifyAppend(msg);
    return msg;
  }

  /** F117: Mark a queued message as canceled (withdraw/clear). */
  async markCanceled(id: string): Promise<StoredMessage | null> {
    const msg = await this.getByIdRaw(id);
    if (!msg) return null;
    const pipeline = this.redis.multi();
    pipeline.hset(MessageKeys.detail(id), { deliveryStatus: 'canceled' });
    pipeline.hdel(MessageKeys.detail(id), 'freshnessReviewPublication');
    for (const key of this.freshnessIndexKeysForMessage(msg)) pipeline.zrem(key, id);
    await pipeline.exec();
    msg.deliveryStatus = 'canceled';
    return msg;
  }

  /** Hydrate message IDs into full StoredMessage objects */
  private async hydrateMessages(ids: string[], options?: { includeDeleted?: boolean }): Promise<StoredMessage[]> {
    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.hgetall(MessageKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const messages: StoredMessage[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.id) continue;

      if (
        isPendingFreshnessReviewPublication(
          d.deliveryStatus as StoredMessage['deliveryStatus'],
          d.freshnessReviewPublication === '1',
        )
      ) {
        continue;
      }

      const deletedAt = d.deletedAt ? parseInt(d.deletedAt, 10) : undefined;

      // ADR-008 D3: skip soft-deleted messages unless includeDeleted
      if (deletedAt && !options?.includeDeleted) continue;

      const contentBlocks = safeParseContentBlocks(d.contentBlocks);
      const toolEvents = safeParseToolEvents(d.toolEvents);
      const parsedMetadata = safeParseMetadata(d.metadata);
      const parsedExtra = safeParseExtra(d.extra);
      const parsedSource = safeParseConnectorSource(d.source);
      const editedAt = d.editedAt ? parseInt(d.editedAt, 10) : undefined;
      messages.push({
        id: d.id,
        threadId: d.threadId || DEFAULT_THREAD_ID,
        userId: d.userId ?? 'unknown',
        catId: (d.catId || null) as CatId | null,
        content: d.content ?? '',
        ...(d.messageClass === 'status' || d.messageClass === 'substantive' ? { messageClass: d.messageClass } : {}),
        ...(d.appendWatermark && /^\d+$/.test(d.appendWatermark)
          ? { appendWatermark: d.appendWatermark as ThreadAppendWatermark }
          : {}),
        ...(contentBlocks ? { contentBlocks } : {}),
        ...(toolEvents ? { toolEvents } : {}),
        ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
        ...(parsedExtra ? { extra: parsedExtra } : {}),
        mentions: safeParseMentions(d.mentions),
        timestamp: parseInt(d.timestamp ?? '0', 10),
        ...(editedAt ? { editedAt } : {}),
        ...(deletedAt ? { deletedAt, deletedBy: d.deletedBy ?? '' } : {}),
        ...(d._tombstone === '1' ? { _tombstone: true as const } : {}),
        ...(d.thinking ? { thinking: d.thinking } : {}),
        ...(d.origin === 'stream' || d.origin === 'callback' || d.origin === 'briefing' || d.origin === 'progress'
          ? { origin: d.origin as 'stream' | 'callback' | 'briefing' | 'progress' }
          : {}),
        ...(d.visibility === 'whisper' ? { visibility: 'whisper' as const } : {}),
        ...(d.whisperTo ? { whisperTo: safeParseMentions(d.whisperTo) } : {}),
        ...(d.revealedAt ? { revealedAt: parseInt(d.revealedAt, 10) } : {}),
        ...(d.deliveredAt ? { deliveredAt: parseInt(d.deliveredAt, 10) } : {}),
        ...(d.deliveryStatus ? { deliveryStatus: d.deliveryStatus as StoredMessage['deliveryStatus'] } : {}),
        ...(parsedSource ? { source: parsedSource } : {}),
        ...(d.mentionsUser === '1' ? { mentionsUser: true } : {}),
        ...(d.replyTo ? { replyTo: d.replyTo } : {}),
      });
    }
    return messages;
  }
}
