#!/usr/bin/env node
/**
 * Delete Redis keys that belong to threads which no longer exist.
 *
 * Why this exists: DELETE /api/threads/:id/purge did not cascade into every
 * thread-scoped key family, so threads purged before that gap was closed left
 * permanent orphans behind (session chains, idempotency pointers, ...). This script
 * cleans up retroactively. It is not needed for threads purged after the fix.
 *
 * Safety model:
 * - Dry-run by default. Nothing is deleted without --apply.
 * - A key is only a deletion candidate when its thread id is absent from Redis.
 *   Live threads are never touched, whatever the key family.
 * - Two key families are deliberately NEVER deleted:
 *     msg:freshness:seq:{threadId}  ABA tombstone — a still-running old invocation
 *                                   must not become fresh again on a reused thread id
 *     thread:{threadId}:tombstone   resurrection guard for hard-deleted threads
 *
 * Usage:
 *   node scripts/purge-orphan-thread-keys.mjs                     # dry run
 *   node scripts/purge-orphan-thread-keys.mjs --apply              # delete
 *   node scripts/purge-orphan-thread-keys.mjs --thread <id>        # limit to one thread
 *
 * Defaults: --redis-url $REDIS_URL or redis://127.0.0.1:6399
 *           --key-prefix $REDIS_KEY_PREFIX or cat-cafe:
 */

import { Redis } from 'ioredis';

const DEFAULT_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6399';
const DEFAULT_PREFIX = process.env.REDIS_KEY_PREFIX ?? 'cat-cafe:';

/** Never delete these, even when the thread is gone. */
const PROTECTED = [/^msg:freshness:seq:/, /^thread:[^:]+:tombstone$/];

/**
 * Thread-scoped key families. `threadIdAt` is the 0-based segment index holding the
 * thread id; `fromField` instead reads the thread id out of a hash field.
 */
const FAMILIES = [
  // Scanned on purpose so the PROTECTED guard is exercised and reported, rather than
  // these keys surviving merely because no pattern happens to reach them.
  { pattern: 'msg:freshness:seq:*', threadIdAt: 3 },
  { pattern: 'thread:*:tombstone', threadIdAt: 1 },
  { pattern: 'msg:thread:*', threadIdAt: 2 },
  { pattern: 'msg:idem:*', threadIdAt: 3 },
  { pattern: 'msg:freshness:public:*', threadIdAt: 3 },
  { pattern: 'msg:freshness:whisper:*', threadIdAt: 3 },
  { pattern: 'thread:*:participants', threadIdAt: 1 },
  { pattern: 'thread:*:activity', threadIdAt: 1 },
  { pattern: 'thread:*:mention-routing-feedback', threadIdAt: 1 },
  { pattern: 'session-chain:*', threadIdAt: 2 },
  { pattern: 'session-active:*', threadIdAt: 2 },
  { pattern: 'sessions:*', threadIdAt: 3 },
  { pattern: 'session:*', fromField: 'threadId' },
  { pattern: 'delivery-cursor:*', threadIdAt: 3 },
  { pattern: 'mention-ack:*', threadIdAt: 3 },
  { pattern: 'read-state:*', threadIdAt: 2 },
  { pattern: 'tasks:thread:*', threadIdAt: 2 },
  { pattern: 'task-progress:*', threadIdAt: 1 },
  { pattern: 'summaries:thread:*', threadIdAt: 2 },
  { pattern: 'memory:*', threadIdAt: 1 },
  { pattern: 'cat-cafe:memory:*', threadIdAt: 2 },
  { pattern: 'drafts:idx:*', threadIdAt: 3 },
  { pattern: 'draft:*', threadIdAt: 2 },
  { pattern: 'game:thread:*', threadIdAt: 2 },
  { pattern: 'connector-binding-rev:*', threadIdAt: 1 },
  { pattern: 'freshness-hold:user-thread:*', threadIdAt: 3 },
  { pattern: 'guide-session:*', threadIdAt: 1 },
];

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, prefix: DEFAULT_PREFIX, apply: false, threads: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--redis-url') out.url = argv[++i] ?? out.url;
    else if (arg === '--key-prefix') out.prefix = argv[++i] ?? out.prefix;
    else if (arg === '--thread') out.threads.push(argv[++i]);
    else throw new Error(`未知参数：${arg}`);
  }
  return out;
}

/** SCAN a prefixed pattern, returning bare (unprefixed) keys. */
async function scan(redis, prefix, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}${pattern}`, 'COUNT', 500);
    cursor = next;
    for (const key of batch) keys.push(key.startsWith(prefix) ? key.slice(prefix.length) : key);
  } while (cursor !== '0');
  return keys;
}

/** Thread ids that still exist. A thread detail key is a hash carrying an `id` field. */
async function loadLiveThreadIds(redis, prefix) {
  const live = new Set(['default']);
  for (const key of await scan(redis, prefix, 'thread:*')) {
    const parts = key.split(':');
    if (parts.length !== 2) continue; // skip thread:{id}:participants and friends
    if (await redis.hget(key, 'id')) live.add(parts[1]);
  }
  return live;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const redis = new Redis(args.url, { keyPrefix: args.prefix, maxRetriesPerRequest: 3 });

  try {
    await redis.ping();
    const live = await loadLiveThreadIds(redis, args.prefix);
    console.log(`[orphan-purge] redis=${args.url} prefix=${args.prefix}`);
    console.log(`[orphan-purge] 存活 thread：${live.size - 1} 条（不含 default）`);

    const wanted = args.threads.length > 0 ? new Set(args.threads) : null;
    const seen = new Set();
    /** @type {Map<string, string[]>} family pattern → orphan keys */
    const plan = new Map();
    let protectedCount = 0;

    for (const family of FAMILIES) {
      for (const key of await scan(redis, args.prefix, family.pattern)) {
        if (seen.has(key)) continue; // overlapping patterns (e.g. msg:thread:* vs msg:*)
        seen.add(key);

        if (PROTECTED.some((re) => re.test(key))) {
          protectedCount += 1;
          continue;
        }

        const threadId = family.fromField ? await redis.hget(key, family.fromField) : key.split(':')[family.threadIdAt];
        if (!threadId || live.has(threadId)) continue;
        if (wanted && !wanted.has(threadId)) continue;

        const bucket = plan.get(family.pattern) ?? [];
        bucket.push(key);
        plan.set(family.pattern, bucket);
      }
    }

    const total = [...plan.values()].reduce((sum, keys) => sum + keys.length, 0);
    if (total === 0) {
      console.log(`[orphan-purge] 没有孤儿键（受保护键 ${protectedCount} 个已跳过）`);
      return;
    }

    console.log(`[orphan-purge] 孤儿键 ${total} 个（受保护键 ${protectedCount} 个已跳过）：`);
    for (const [pattern, keys] of [...plan].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(keys.length).padStart(5)}  ${pattern}`);
    }

    if (!args.apply) {
      console.log('[orphan-purge] dry-run，未删除任何东西。加 --apply 才会真删。');
      return;
    }

    let deleted = 0;
    for (const keys of plan.values()) {
      for (let i = 0; i < keys.length; i += 200) {
        deleted += await redis.del(...keys.slice(i, i + 200));
      }
    }
    console.log(`[orphan-purge] 已删除 ${deleted} 个键`);
  } finally {
    await redis.quit().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[orphan-purge] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
