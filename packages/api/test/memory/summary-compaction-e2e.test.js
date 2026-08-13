import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('SummaryCompaction e2e', () => {
  let db;
  let processThread;
  let buildSummaryCompactionBatch;
  const SUMMARY_CONFIG_OVERRIDE = {
    pendingMessageThreshold: 20,
    pendingTokenThreshold: 1500,
    cooldownHours: 2,
    quietWindowMinutes: 10,
    perTickBudget: 5,
    backfillIntervalMs: 2000,
    driftAlertTokenThreshold: 800,
    maxTopicSegments: 3,
    minSplitMessageCount: 8,
    minSplitTokenCount: 600,
    schedulerIntervalMs: 30 * 60 * 1000,
  };

  function makeMsgs(count, startId = 1) {
    return Array.from({ length: count }, (_, i) => ({
      id: `msg-${startId + i}`,
      content: `Message ${startId + i} about project decisions`,
      catId: 'opus',
      timestamp: Date.now() - (count - i) * 60_000,
    }));
  }

  function makeBatch(messages, excludedPrivateCount = 0, scannedThroughMessageId = messages.at(-1)?.id ?? null) {
    return { messages, scannedThroughMessageId, excludedPrivateCount };
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);

    const mod = await import('../../dist/domains/memory/SummaryCompactionTask.js');
    processThread = mod.processThread;
    buildSummaryCompactionBatch = mod.buildSummaryCompactionBatch;

    // Seed evidence_docs with a thread
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('thread-test-thread', 'thread', 'active', 'Test Thread', 'Old concat summary', new Date().toISOString());

    // Seed summary_state as eligible: 25 msgs, 2000 tokens, no cooldown
    db.prepare(
      `INSERT INTO summary_state (thread_id, pending_message_count, pending_token_count, pending_signal_flags, summary_type)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('test-thread', 25, 2000, 0, 'concat');
  });

  it('e2e: mock Opus → inserts segment → submits candidate → updates watermark', async () => {
    const candidates = [];
    const msgs = makeMsgs(25);

    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000, // 20 min idle
      }),
      getMessagesAfterWatermark: async (_tid, _after, _limit) => makeBatch(msgs),
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Discussed memory architecture decisions and lesson about Redis isolation',
            topicKey: 'memory-architecture',
            topicLabel: 'Memory Architecture Decisions',
            boundaryReason: 'single batch',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
            candidates: [
              {
                kind: 'decision',
                title: 'Knowledge Feed uses YAML files as truth source',
                claim: 'YAML files are truth source for git-trackability',
                confidence: 'explicit',
              },
            ],
          },
        ],
      }),
      reEmbed: async () => {},
      submitCandidate: async (c) => {
        candidates.push(c);
      },
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true);

    // Verify summary_segments inserted
    const segments = db.prepare('SELECT * FROM summary_segments WHERE thread_id = ?').all('test-thread');
    assert.equal(segments.length, 1);
    assert.equal(segments[0].level, 1); // L1
    assert.ok(segments[0].summary.includes('memory architecture'));
    assert.equal(segments[0].prompt_version, 'g2-thread-abstract-v2');

    // Verify evidence_docs.summary updated (read model)
    const doc = db.prepare('SELECT summary FROM evidence_docs WHERE anchor = ?').get('thread-test-thread');
    assert.ok(doc.summary.includes('memory architecture'));

    // Verify watermark advanced
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.last_summarized_message_id, msgs[msgs.length - 1].id);
    assert.equal(state.summary_type, 'abstractive');
    assert.ok(state.last_abstractive_at);

    // Verify candidate submitted
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, 'decision');
    assert.ok(candidates[0].title.includes('YAML'));
  });

  it('starts after a reset boundary and never carries the pre-reset summary forward', async () => {
    db.prepare('UPDATE evidence_docs SET summary = ? WHERE anchor = ?').run(
      'OLD_SENTINEL must not survive reset',
      'thread-test-thread',
    );
    const postResetMessages = [
      { id: 'msg-003', content: 'POST_RESET_ONLY', catId: 'opus', timestamp: Date.now() - 20 * 60 * 1000 },
    ];
    const requestedAfter = [];
    let modelInput;
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getContextResetBoundary: async () => ({ contextEpoch: 1, resetAtMessageId: 'msg-002', resetAt: 2 }),
      getMessagesAfterWatermark: async (_threadId, afterMessageId) => {
        requestedAfter.push(afterMessageId);
        return makeBatch(postResetMessages);
      },
      generateAbstractive: async (input) => {
        modelInput = input;
        return {
          segments: [
            {
              summary: 'POST_RESET_SUMMARY',
              topicKey: 'post-reset',
              topicLabel: 'Post Reset',
              boundaryReason: 'context reset',
              boundaryConfidence: 'high',
              fromMessageId: 'msg-003',
              toMessageId: 'msg-003',
              messageCount: 1,
            },
          ],
        };
      },
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: 'msg-001',
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'abstractive',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true);
    assert.equal(requestedAfter[0], 'msg-002');
    assert.equal(modelInput.previousSummary, null);
    assert.deepEqual(
      modelInput.messages.map((message) => message.content),
      ['POST_RESET_ONLY'],
    );
    const segment = db.prepare('SELECT summary FROM summary_segments WHERE thread_id = ?').get('test-thread');
    assert.equal(segment.summary, 'POST_RESET_SUMMARY');
    const doc = db.prepare('SELECT summary FROM evidence_docs WHERE anchor = ?').get('thread-test-thread');
    assert.equal(doc.summary, 'POST_RESET_SUMMARY');
    assert.ok(!JSON.stringify({ modelInput, segment, doc }).includes('OLD_SENTINEL'));
  });

  it('discards a generated result when reset advances during the model call', async () => {
    db.prepare(
      `UPDATE summary_state SET
       invalid_format_batch_key = 'old-epoch-key',
       invalid_format_streak = 2,
       invalid_format_latched = 1
       WHERE thread_id = 'test-thread'`,
    ).run();
    const postResetBoundary = { contextEpoch: 1, resetAtMessageId: 'msg-002', resetAt: 2 };
    let boundary = null;
    let releaseModel;
    let signalModelStarted;
    const modelStarted = new Promise((resolve) => {
      signalModelStarted = resolve;
    });
    const modelRelease = new Promise((resolve) => {
      releaseModel = resolve;
    });
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getContextResetBoundary: async () => boundary,
      getMessagesAfterWatermark: async () =>
        makeBatch([{ id: 'msg-001', content: 'OLD_MODEL_INPUT', catId: 'opus', timestamp: 1 }]),
      generateAbstractive: async () => {
        signalModelStarted();
        await modelRelease;
        return {
          segments: [
            {
              summary: 'STALE_GENERATED_SUMMARY',
              topicKey: 'stale',
              topicLabel: 'Stale',
              boundaryReason: 'old generation',
              boundaryConfidence: 'high',
              fromMessageId: 'msg-001',
              toMessageId: 'msg-001',
              messageCount: 1,
            },
          ],
        };
      },
      logger: { info: () => {}, error: () => {} },
    };
    const state = {
      thread_id: 'test-thread',
      last_summarized_message_id: null,
      pending_message_count: 25,
      pending_token_count: 2000,
      pending_signal_flags: 0,
      summary_type: 'concat',
      last_abstractive_at: null,
      abstractive_token_count: null,
      carry_over: 0,
    };

    const processing = processThread(state, deps, SUMMARY_CONFIG_OVERRIDE);
    await modelStarted;
    boundary = postResetBoundary;
    releaseModel();
    assert.equal(await processing, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM summary_segments').get().n, 0);
    assert.equal(
      db.prepare('SELECT summary FROM evidence_docs WHERE anchor = ?').get('thread-test-thread').summary,
      'Old concat summary',
    );
    assert.equal(
      db.prepare('SELECT last_summarized_message_id FROM summary_state WHERE thread_id = ?').get('test-thread')
        .last_summarized_message_id,
      null,
    );
    const failureState = db
      .prepare(
        'SELECT invalid_format_batch_key, invalid_format_streak, invalid_format_latched FROM summary_state WHERE thread_id = ?',
      )
      .get('test-thread');
    assert.equal(failureState.invalid_format_batch_key, null);
    assert.equal(failureState.invalid_format_streak, 0);
    assert.equal(failureState.invalid_format_latched, 0);
  });

  it('clears a stale invalid-format latch when reset leaves no post-reset batch', async () => {
    db.prepare(
      `UPDATE summary_state SET
       invalid_format_batch_key = 'old-epoch-key',
       invalid_format_streak = 3,
       invalid_format_latched = 1
       WHERE thread_id = 'test-thread'`,
    ).run();
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getContextResetBoundary: async () => ({ contextEpoch: 1, resetAtMessageId: 'msg-999', resetAt: 2 }),
      getMessagesAfterWatermark: async () => makeBatch([], 0, null),
      generateAbstractive: async () => {
        throw new Error('must not generate without a post-reset batch');
      },
      logger: { info: () => {}, error: () => {} },
    };
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');

    assert.equal(await processThread(state, deps, SUMMARY_CONFIG_OVERRIDE), false);
    const failureState = db
      .prepare(
        'SELECT invalid_format_batch_key, invalid_format_streak, invalid_format_latched FROM summary_state WHERE thread_id = ?',
      )
      .get('test-thread');
    assert.deepEqual(failureState, {
      invalid_format_batch_key: null,
      invalid_format_streak: 0,
      invalid_format_latched: 0,
    });
  });

  it('creates evidence_docs read model when the thread row is missing', async () => {
    db.prepare('DELETE FROM evidence_docs WHERE anchor = ?').run('thread-test-thread');
    const msgs = makeMsgs(25);

    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => makeBatch(msgs),
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Thread summary created without an existing evidence row',
            topicKey: 'missing-evidence-row',
            topicLabel: 'Missing Evidence Row',
            boundaryReason: 'single batch',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
          },
        ],
      }),
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true);
    const doc = db
      .prepare('SELECT kind, status, title, summary FROM evidence_docs WHERE anchor = ?')
      .get('thread-test-thread');
    assert.equal(doc.kind, 'thread');
    assert.equal(doc.status, 'active');
    assert.equal(doc.title, 'Thread test-thread');
    assert.match(doc.summary, /without an existing evidence row/);
  });

  it('filters private/noise input, includes revealed whisper, and marks every generated segment', async () => {
    const now = Date.now();
    const stored = [
      {
        id: 'public-1',
        threadId: 'test-thread',
        userId: 'default-user',
        catId: null,
        content: 'public decision',
        mentions: [],
        timestamp: now - 8,
        deliveryStatus: 'delivered',
      },
      {
        id: 'queued-1',
        threadId: 'test-thread',
        userId: 'default-user',
        catId: null,
        content: 'QUEUED SECRET',
        mentions: [],
        timestamp: now - 7,
        deliveryStatus: 'queued',
      },
      {
        id: 'system-1',
        threadId: 'test-thread',
        userId: 'system',
        catId: 'system',
        content: 'SYSTEM NOISE',
        mentions: [],
        timestamp: now - 6,
      },
      {
        id: 'progress-1',
        threadId: 'test-thread',
        userId: 'default-user',
        catId: 'opus',
        content: 'PROGRESS NOISE',
        mentions: [],
        timestamp: now - 5,
        origin: 'progress',
      },
      {
        id: 'briefing-1',
        threadId: 'test-thread',
        userId: 'default-user',
        catId: 'opus',
        content: 'BRIEFING NOISE',
        mentions: [],
        timestamp: now - 4,
        origin: 'briefing',
      },
      {
        id: 'revealed-1',
        threadId: 'test-thread',
        userId: 'default-user',
        catId: 'opus',
        content: 'revealed decision',
        mentions: [],
        timestamp: now - 3,
        visibility: 'whisper',
        whisperTo: ['opus'],
        revealedAt: now - 2,
      },
      {
        id: 'private-1',
        threadId: 'test-thread',
        userId: 'default-user',
        catId: 'opus',
        content: 'UNREVEALED PRIVATE SECRET',
        mentions: [],
        timestamp: now - 1,
        visibility: 'whisper',
        whisperTo: ['opus'],
      },
    ];
    const safeBatch = buildSummaryCompactionBatch(stored);
    assert.deepEqual(
      safeBatch.messages.map((message) => message.id),
      ['public-1', 'revealed-1'],
    );
    assert.equal(safeBatch.scannedThroughMessageId, 'private-1');
    assert.equal(safeBatch.excludedPrivateCount, 1);

    let modelInput;
    let getterCalls = 0;
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => (getterCalls++ === 0 ? safeBatch : makeBatch([])),
      generateAbstractive: async (input) => {
        modelInput = input.messages;
        return {
          segments: [
            {
              summary: 'First public segment',
              topicKey: 'first',
              topicLabel: 'First',
              boundaryReason: 'topic change',
              boundaryConfidence: 'high',
              fromMessageId: 'public-1',
              toMessageId: 'public-1',
              messageCount: 1,
            },
            {
              summary: 'Revealed segment',
              topicKey: 'revealed',
              topicLabel: 'Revealed',
              boundaryReason: 'topic change',
              boundaryConfidence: 'high',
              fromMessageId: 'revealed-1',
              toMessageId: 'revealed-1',
              messageCount: 1,
            },
          ],
        };
      },
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: stored.length,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true);
    assert.deepEqual(
      modelInput.map((message) => message.content),
      ['public decision', 'revealed decision'],
    );
    assert.ok(!JSON.stringify(modelInput).includes('UNREVEALED PRIVATE SECRET'));
    const segments = db
      .prepare('SELECT summary FROM summary_segments WHERE thread_id = ? ORDER BY from_message_id')
      .all('test-thread');
    assert.equal(segments.length, 2);
    for (const segment of segments) {
      assert.match(segment.summary, /\n\n（部分私密消息未纳入摘要）$/);
    }
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.last_summarized_message_id, 'private-1', 'watermark follows raw scan, not model input');
  });

  it('advances through consecutive all-private batches and clears carry-over without invoking the model', async () => {
    const firstPrivateBatch = makeBatch([], 200, 'private-200');
    const secondPrivateBatch = makeBatch([], 25, 'private-225');
    const batches = [
      firstPrivateBatch,
      makeBatch([], 1, 'private-201'),
      secondPrivateBatch,
      secondPrivateBatch,
      makeBatch([]),
    ];
    let modelCalls = 0;
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => batches.shift() ?? makeBatch([]),
      generateAbstractive: async () => {
        modelCalls += 1;
        return null;
      },
      logger: { info: () => {}, error: () => {} },
    };
    const initialState = {
      thread_id: 'test-thread',
      last_summarized_message_id: null,
      pending_message_count: 225,
      pending_token_count: 2000,
      pending_signal_flags: 0,
      summary_type: 'concat',
      last_abstractive_at: null,
      abstractive_token_count: null,
      carry_over: 0,
    };

    assert.equal(await processThread(initialState, deps, SUMMARY_CONFIG_OVERRIDE), true);
    const afterFirst = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(afterFirst.last_summarized_message_id, 'private-200');
    assert.equal(afterFirst.carry_over, 1);
    assert.equal(afterFirst.pending_message_count, 25);

    assert.equal(await processThread(afterFirst, deps, SUMMARY_CONFIG_OVERRIDE), true);
    const afterSecond = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(afterSecond.last_summarized_message_id, 'private-225');
    assert.equal(afterSecond.carry_over, 0);
    assert.equal(afterSecond.pending_message_count, 0);
    assert.equal(modelCalls, 0);
    assert.equal(batches.length, 0);
  });

  it('sets carry_over=1 when messages remain after batch', async () => {
    const batch1 = makeMsgs(200, 1);
    const remaining = makeMsgs(50, 201);
    let callCount = 0;

    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async (_tid, afterId, _limit) => {
        callCount++;
        // First call: return batch of 200
        if (callCount === 1) return makeBatch(batch1);
        // Second/third call (remaining check): return 50 remaining
        return makeBatch(remaining);
      },
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Large batch summary',
            topicKey: 'large-batch',
            topicLabel: 'Large Batch',
            boundaryReason: 'single batch',
            boundaryConfidence: 'high',
            fromMessageId: batch1[0].id,
            toMessageId: batch1[batch1.length - 1].id,
            messageCount: 200,
          },
        ],
      }),
      logger: { info: () => {}, error: () => {} },
    };

    // Update state to reflect 250 messages
    db.prepare(
      'UPDATE summary_state SET pending_message_count = 250, pending_token_count = 10000 WHERE thread_id = ?',
    ).run('test-thread');

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 250,
        pending_token_count: 10000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true);
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.carry_over, 1, 'carry_over should be 1 when messages remain');
    assert.equal(state.pending_message_count, 50, 'pending_message_count should reflect remaining');
  });

  it('returns false when Opus API returns null (fail-open)', async () => {
    const msgs = makeMsgs(25);
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => makeBatch(msgs),
      generateAbstractive: async () => null,
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, false);
    // No segments inserted
    const segments = db.prepare('SELECT count(*) as n FROM summary_segments').get();
    assert.equal(segments.n, 0);
    // Watermark unchanged
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.last_summarized_message_id, null);
  });

  it('continues when submitCandidate throws (fail-open)', async () => {
    const msgs = makeMsgs(25);
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => makeBatch(msgs),
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Summary with failing candidate',
            topicKey: 'fail-candidate',
            topicLabel: 'Fail Candidate',
            boundaryReason: 'test',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
            candidates: [{ kind: 'lesson', title: 'Test lesson', claim: 'test', confidence: 'inferred' }],
          },
        ],
      }),
      submitCandidate: async () => {
        throw new Error('MarkerQueue unavailable');
      },
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true, 'should succeed despite submitCandidate failure');
    const segments = db.prepare('SELECT count(*) as n FROM summary_segments').get();
    assert.equal(segments.n, 1, 'segment should still be inserted');
  });

  it('full pipeline: gate → execute → segment + candidate', async () => {
    const { createSummaryCompactionTaskSpec } = await import('../../dist/domains/memory/SummaryCompactionTaskSpec.js');

    const msgs = makeMsgs(25);
    const candidates = [];

    const spec = createSummaryCompactionTaskSpec({
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => makeBatch(msgs),
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Full pipeline test summary',
            topicKey: 'pipeline-test',
            topicLabel: 'Pipeline Test',
            boundaryReason: 'single batch',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
            candidates: [
              {
                kind: 'decision',
                title: 'Pipeline verification is essential for runtime trust',
                claim: 'Must verify full pipeline before declaring Phase G complete',
                confidence: 'explicit',
              },
            ],
          },
        ],
      }),
      reEmbed: async () => {},
      submitCandidate: async (c) => {
        candidates.push(c);
      },
      logger: { info: () => {}, error: () => {} },
    });

    // Step 1: Gate should find eligible thread
    const gateResult = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gateResult.run, true, 'gate should find eligible thread');
    assert.ok(gateResult.workItems.length > 0);

    // Step 2: Execute with the work item
    const workItem = gateResult.workItems[0];
    await spec.run.execute(workItem.signal, workItem.subjectKey, {
      taskId: spec.id,
      runId: 'test-run',
      startedAt: Date.now(),
    });

    // Verify segment inserted
    const segments = db.prepare('SELECT * FROM summary_segments WHERE thread_id = ?').all('test-thread');
    assert.equal(segments.length, 1);
    assert.ok(segments[0].summary.includes('pipeline'));

    // Verify candidate submitted
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, 'decision');

    // Verify watermark advanced
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.summary_type, 'abstractive');
    assert.ok(state.last_abstractive_at);
  });

  it('skips candidate submission when submitCandidate is undefined (F102_DURABLE_CANDIDATES=off)', async () => {
    const msgs = makeMsgs(25);
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => makeBatch(msgs),
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Summary with candidates but no submission',
            topicKey: 'no-submit',
            topicLabel: 'No Submit',
            boundaryReason: 'test',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
            candidates: [{ kind: 'decision', title: 'Should not be submitted', claim: 'test', confidence: 'explicit' }],
          },
        ],
      }),
      // submitCandidate intentionally undefined — simulates F102_DURABLE_CANDIDATES=off
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true, 'should succeed without submitCandidate');
    // Segment still inserted even without candidate submission
    const segments = db.prepare('SELECT count(*) as n FROM summary_segments').get();
    assert.equal(segments.n, 1);
    // Watermark still advanced
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.summary_type, 'abstractive');
  });

  it('continues when reEmbed throws (fail-open)', async () => {
    const msgs = makeMsgs(25);
    const deps = {
      db,
      enabled: () => true,
      getThreadLastActivity: async () => ({
        threadId: 'test-thread',
        lastMessageAt: Date.now() - 20 * 60 * 1000,
      }),
      getMessagesAfterWatermark: async () => makeBatch(msgs),
      generateAbstractive: async () => ({
        segments: [
          {
            summary: 'Summary with failing re-embed',
            topicKey: 'fail-embed',
            topicLabel: 'Fail Embed',
            boundaryReason: 'test',
            boundaryConfidence: 'high',
            fromMessageId: msgs[0].id,
            toMessageId: msgs[msgs.length - 1].id,
            messageCount: msgs.length,
          },
        ],
      }),
      reEmbed: async () => {
        throw new Error('Embedding service down');
      },
      logger: { info: () => {}, error: () => {} },
    };

    const result = await processThread(
      {
        thread_id: 'test-thread',
        last_summarized_message_id: null,
        pending_message_count: 25,
        pending_token_count: 2000,
        pending_signal_flags: 0,
        summary_type: 'concat',
        last_abstractive_at: null,
        abstractive_token_count: null,
        carry_over: 0,
      },
      deps,
      SUMMARY_CONFIG_OVERRIDE,
    );

    assert.equal(result, true, 'should succeed despite reEmbed failure');
    const state = db.prepare('SELECT * FROM summary_state WHERE thread_id = ?').get('test-thread');
    assert.equal(state.summary_type, 'abstractive');
  });
});
