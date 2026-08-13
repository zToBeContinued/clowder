import type { RedisClient } from '@cat-cafe/shared/utils';
import type { InvocationQueuePersistence, QueueEntry } from './InvocationQueue.js';

const ENTRY_HASH = 'invocation-queue:durable:entries';
const EXPIRY_ZSET = 'invocation-queue:durable:expiry';

/** Redis journal for the canonical InvocationQueue; this is persistence, not a second scheduler. */
export class RedisInvocationQueuePersistence implements InvocationQueuePersistence {
  constructor(private readonly redis: RedisClient) {}

  async save(entry: QueueEntry): Promise<void> {
    await this.redis
      .multi()
      .hset(ENTRY_HASH, entry.id, JSON.stringify(entry))
      .zadd(EXPIRY_ZSET, entry.expiresAt ?? Date.now() + 7 * 24 * 60 * 60 * 1000, entry.id)
      .exec();
  }

  async delete(entryId: string): Promise<void> {
    await this.redis.multi().hdel(ENTRY_HASH, entryId).zrem(EXPIRY_ZSET, entryId).exec();
  }

  async list(): Promise<QueueEntry[]> {
    const now = Date.now();
    const expiredIds = await this.redis.zrangebyscore(EXPIRY_ZSET, '-inf', now);
    if (expiredIds.length > 0) {
      await this.redis
        .multi()
        .hdel(ENTRY_HASH, ...expiredIds)
        .zrem(EXPIRY_ZSET, ...expiredIds)
        .exec();
    }
    const rawEntries = await this.redis.hvals(ENTRY_HASH);
    const entries: QueueEntry[] = [];
    for (const raw of rawEntries) {
      try {
        const parsed = JSON.parse(raw) as QueueEntry;
        if (parsed?.id && parsed.threadId && parsed.userId) entries.push(parsed);
      } catch {
        // Corrupt journal rows are ignored; valid entries remain recoverable.
      }
    }
    return entries;
  }
}
