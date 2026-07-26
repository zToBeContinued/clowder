// @ci-tier redis reason="requires isolated Redis for summary/game/freshness-hold cascade"
/**
 * Per-thread cascade cleanup for the Redis stores wired into DELETE /api/threads/:id/purge.
 *
 * These key families carry no TTL, so a purge that skips them leaks forever — and in the
 * freshness-hold case it leaves unpublished draft text behind.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const PATTERNS = ['summary:*', 'summaries:*', 'game:*', 'freshness-hold:*'];

describe('Redis thread cascade stores', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let summaryStore;
  let gameStore;
  let holdStore;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'Redis thread cascade stores');

    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisSummaryStore } = await import('../dist/domains/cats/services/stores/redis/RedisSummaryStore.js');
    const { RedisGameStore } = await import('../dist/domains/cats/services/stores/redis/RedisGameStore.js');
    const { RedisFreshnessHoldStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisFreshnessHoldStore.js'
    );

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-thread-cascade-stores.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    summaryStore = new RedisSummaryStore(redis);
    gameStore = new RedisGameStore(redis);
    holdStore = new RedisFreshnessHoldStore(redis, { maxReviews: 2 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, PATTERNS);
  });

  describe('RedisSummaryStore.deleteByThread', () => {
    async function seedSummary(threadId, topic) {
      return summaryStore.create({ threadId, topic, conclusions: ['c'], openQuestions: [], createdBy: 'user' });
    }

    it('drops the summaries and their index', async () => {
      const first = await seedSummary('thread-A', 'one');
      await seedSummary('thread-A', 'two');

      assert.equal(await summaryStore.deleteByThread('thread-A'), 2);
      assert.deepEqual(await summaryStore.listByThread('thread-A'), []);
      assert.equal(await summaryStore.get(first.id), null);
    });

    it('leaves other threads alone and is a no-op when empty', async () => {
      const survivor = await seedSummary('thread-B', 'keep');

      assert.equal(await summaryStore.deleteByThread('thread-A'), 0);
      assert.ok(await summaryStore.get(survivor.id));
    });
  });

  describe('RedisGameStore.deleteByThread', () => {
    function runtime(gameId, threadId) {
      return { gameId, threadId, status: 'running', version: 1, updatedAt: Date.now(), players: [] };
    }

    it('drops the active game, the history and every game record', async () => {
      await gameStore.createGame(runtime('game-finished', 'thread-A'));
      await gameStore.endGame('game-finished', 'opus');
      await gameStore.createGame(runtime('game-active', 'thread-A'));

      assert.equal(await gameStore.deleteByThread('thread-A'), 2);
      assert.equal(await gameStore.getActiveGame('thread-A'), null);
      assert.equal(await gameStore.getGame('game-active'), null);
      assert.equal(await gameStore.getGame('game-finished'), null);
    });

    it('frees the thread for a new game (KD-15 single-active guard)', async () => {
      await gameStore.createGame(runtime('game-1', 'thread-A'));
      await gameStore.deleteByThread('thread-A');

      // Would throw "already has an active game" if the active pointer survived.
      await gameStore.createGame(runtime('game-2', 'thread-A'));
      assert.equal((await gameStore.getActiveGame('thread-A')).gameId, 'game-2');
    });

    it('leaves other threads alone', async () => {
      await gameStore.createGame(runtime('game-keep', 'thread-B'));

      assert.equal(await gameStore.deleteByThread('thread-A'), 0);
      assert.ok(await gameStore.getActiveGame('thread-B'));
    });
  });

  describe('RedisFreshnessHoldStore.deleteByThread', () => {
    function holdInput(suffix, threadId) {
      const now = Date.now();
      return {
        invocationId: `inv-${suffix}`,
        submissionKey: `sub-${suffix}`,
        userId: 'user-1',
        catId: 'opus',
        threadId,
        baselineWatermark: '1',
        observedWatermark: '2',
        deltaMessageIds: [],
        draft: { content: `draft ${suffix}` },
        createdAt: now,
        reviewDeadlineAt: now + 60_000,
      };
    }

    it('drops records, the submission pointers and the deadline entries', async () => {
      const created = await holdStore.createOrGet(holdInput('1', 'thread-A'));
      await holdStore.createOrGet(holdInput('2', 'thread-A'));

      assert.equal(await holdStore.deleteByThread('user-1', 'thread-A'), 2);
      assert.deepEqual(await holdStore.listActive('user-1', 'thread-A'), []);
      assert.equal(await holdStore.get(created.hold.id), null);
      // The submission pointer must go too, otherwise a retry replays a dead hold.
      assert.equal(await holdStore.getBySubmission('inv-1', 'sub-1'), null);
      assert.equal(await holdStore.expireDue(Date.now() + 120_000), 0);
    });

    it('scopes deletion to one user and one thread', async () => {
      await holdStore.createOrGet(holdInput('other-thread', 'thread-B'));
      const otherUser = { ...holdInput('other-user', 'thread-A'), userId: 'user-2' };
      await holdStore.createOrGet(otherUser);

      assert.equal(await holdStore.deleteByThread('user-1', 'thread-A'), 0);
      assert.equal((await holdStore.listActive('user-1', 'thread-B')).length, 1);
      assert.equal((await holdStore.listActive('user-2', 'thread-A')).length, 1);
    });
  });
});
