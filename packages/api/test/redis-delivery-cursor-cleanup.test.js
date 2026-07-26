// @ci-tier redis reason="requires isolated Redis session store for cursor cleanup"
/**
 * DeliveryCursorStore cascade cleanup against Redis.
 *
 * Cursor keys carry a 7-day TTL, so a missed cleanup is not a permanent leak — but the
 * cleanup used to enumerate the cat roster, which silently skipped every cat that had
 * been removed from the roster. Discovery is SCAN-based now.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('DeliveryCursorStore.deleteByThreadForUser (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let sessionStore;
  let store;
  let connected = false;

  const CURSOR_PATTERNS = ['delivery-cursor:*', 'mention-ack:*'];
  // 'retired-cat' is intentionally absent from the registry: roster enumeration would
  // skip it and leave its cursors behind.
  const CATS = ['opus', 'retired-cat'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'DeliveryCursorStore cleanup');

    const { createRedisClient, SessionStore } = await import('@cat-cafe/shared/utils');
    const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-delivery-cursor-cleanup.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    sessionStore = new SessionStore(redis);
    store = new DeliveryCursorStore(sessionStore);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, CURSOR_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, CURSOR_PATTERNS);
  });

  async function seed(userId, threadId) {
    for (const catId of CATS) {
      await sessionStore.setDeliveryCursor(userId, catId, threadId, 'msg-0001');
      await sessionStore.setMentionAckCursor(userId, catId, threadId, 'msg-0001');
    }
  }

  it('clears cursors of every cat, including cats missing from the roster', async () => {
    await seed('user-1', 'thread-A');

    const deleted = await store.deleteByThreadForUser('user-1', 'thread-A');

    assert.equal(deleted, 4, 'two cats × (delivery + mention-ack)');
    for (const catId of CATS) {
      assert.equal(await sessionStore.getDeliveryCursor('user-1', catId, 'thread-A'), null);
      assert.equal(await sessionStore.getMentionAckCursor('user-1', catId, 'thread-A'), null);
    }
  });

  it('leaves other threads and other users untouched', async () => {
    await seed('user-1', 'thread-A');
    await seed('user-1', 'thread-B');
    await seed('user-2', 'thread-A');

    await store.deleteByThreadForUser('user-1', 'thread-A');

    assert.equal(await sessionStore.getDeliveryCursor('user-1', 'opus', 'thread-B'), 'msg-0001');
    assert.equal(await sessionStore.getMentionAckCursor('user-1', 'retired-cat', 'thread-B'), 'msg-0001');
    assert.equal(await sessionStore.getDeliveryCursor('user-2', 'opus', 'thread-A'), 'msg-0001');
  });

  it('is a no-op for a thread without cursors', async () => {
    assert.equal(await store.deleteByThreadForUser('user-1', 'thread-never-existed'), 0);
  });
});
