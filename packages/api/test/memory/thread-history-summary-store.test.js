import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { SqliteThreadHistorySummaryStore } from '../../dist/domains/memory/ThreadHistorySummaryStore.js';

describe('SqliteThreadHistorySummaryStore', () => {
  it('returns latest thread summary segments in chronological order', async () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const insert = db.prepare(`INSERT INTO summary_segments
      (id, thread_id, level, from_message_id, to_message_id, message_count,
       summary, topic_key, topic_label, boundary_reason, boundary_confidence,
       model_id, prompt_version, generated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'high', ?, ?, ?)
    `);

    insert.run(
      'seg-old',
      'thread-1',
      'm1',
      'm3',
      3,
      'old',
      'old',
      'Old',
      'old boundary',
      'haiku',
      'v1',
      '2026-07-03T10:00:00.000Z',
    );
    insert.run(
      'seg-mid',
      'thread-1',
      'm4',
      'm6',
      3,
      'mid',
      'mid',
      'Mid',
      'mid boundary',
      'haiku',
      'v1',
      '2026-07-03T11:00:00.000Z',
    );
    insert.run(
      'seg-new',
      'thread-1',
      'm7',
      'm9',
      3,
      'new',
      'new',
      'New',
      'new boundary',
      'haiku',
      'v1',
      '2026-07-03T12:00:00.000Z',
    );
    insert.run(
      'seg-other',
      'thread-2',
      'x1',
      'x2',
      2,
      'other',
      'other',
      'Other',
      'other boundary',
      'haiku',
      'v1',
      '2026-07-03T13:00:00.000Z',
    );

    const store = new SqliteThreadHistorySummaryStore(db);
    const result = await store.listLatestByThread('thread-1', 2);

    assert.deepEqual(
      result.map((segment) => segment.id),
      ['seg-mid', 'seg-new'],
    );
    assert.equal(result[0].fromMessageId, 'm4');
    assert.equal(result[1].toMessageId, 'm9');
  });
});
