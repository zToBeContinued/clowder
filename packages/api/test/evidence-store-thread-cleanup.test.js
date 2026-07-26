// @ci-tier core reason="sqlite evidence store thread cascade"
/**
 * SqliteEvidenceStore thread cascade — cleanup on permanent thread delete.
 *
 * evidence_passages stores the message text verbatim and has no FK to evidence_docs,
 * so deleting the doc alone used to leave the conversation searchable forever.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('SqliteEvidenceStore thread cascade', () => {
  let dir;
  let store;
  let db;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../dist/domains/memory/SqliteEvidenceStore.js');
    dir = await mkdtemp(join(tmpdir(), 'evidence-thread-'));
    store = new SqliteEvidenceStore(join(dir, 'evidence.sqlite'));
    await store.initialize();
    db = store.getDb();
  });

  afterEach(async () => {
    await store?.close?.();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function seedThread(threadId, text) {
    const anchor = `thread-${threadId}`;
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, summary, source_hash, updated_at)
       VALUES (?, 'thread', 'active', ?, ?, ?, ?)`,
    ).run(anchor, `Thread ${threadId}`, 'summary', `hash-${threadId}`, new Date().toISOString());
    db.prepare(
      `INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
       VALUES (?, ?, ?, 'opus', 0, ?)`,
    ).run(anchor, `msg-${threadId}`, text, new Date().toISOString());
    db.prepare(
      `INSERT INTO summary_state (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type)
       VALUES (?, 1, 10, 0, 'concat')`,
    ).run(threadId);
    return anchor;
  }

  const countPassages = (anchor) =>
    db.prepare('SELECT COUNT(*) AS n FROM evidence_passages WHERE doc_anchor = ?').get(anchor).n;
  const countDocs = (anchor) => db.prepare('SELECT COUNT(*) AS n FROM evidence_docs WHERE anchor = ?').get(anchor).n;
  const countSummaryState = (threadId) =>
    db.prepare('SELECT COUNT(*) AS n FROM summary_state WHERE thread_id = ?').get(threadId).n;

  it('deleteByAnchor also drops the passages of that doc', async () => {
    const anchor = seedThread('t-a', 'secret message body');
    assert.equal(countPassages(anchor), 1);

    await store.deleteByAnchor(anchor);

    assert.equal(countDocs(anchor), 0);
    assert.equal(countPassages(anchor), 0, 'passages hold the message text verbatim');
  });

  it('deleteByAnchor keeps the FTS index in sync', async () => {
    const anchor = seedThread('t-a', 'zzsecretzz needle');
    const found = () =>
      db.prepare("SELECT COUNT(*) AS n FROM passage_fts WHERE passage_fts MATCH 'zzsecretzz'").get().n;
    assert.equal(found(), 1);

    await store.deleteByAnchor(anchor);

    assert.equal(found(), 0, 'a purged thread must not stay searchable');
  });

  it('deleteThreadEvidence drops doc, passages and the summary watermark', async () => {
    const anchor = seedThread('t-a', 'body');

    await store.deleteThreadEvidence('t-a');

    assert.equal(countDocs(anchor), 0);
    assert.equal(countPassages(anchor), 0);
    assert.equal(countSummaryState('t-a'), 0);
  });

  it('leaves other threads untouched', async () => {
    seedThread('t-a', 'doomed');
    const survivor = seedThread('t-b', 'keep me');

    await store.deleteThreadEvidence('t-a');

    assert.equal(countDocs(survivor), 1);
    assert.equal(countPassages(survivor), 1);
    assert.equal(countSummaryState('t-b'), 1);
  });

  it('is a no-op for a thread that was never indexed', async () => {
    await store.deleteThreadEvidence('t-never');
    assert.equal(countDocs('thread-t-never'), 0);
  });
});
