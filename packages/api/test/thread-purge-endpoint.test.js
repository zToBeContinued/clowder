/**
 * DELETE /api/threads/:id/purge and DELETE /api/threads/trash
 *
 * Purge is the only irreversible path, so it is gated twice: the thread must already be
 * in the trash bin (soft-deleted), and the caller must send the dangerous-action
 * confirmation header.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const CONFIRM_HEADERS = {
  'x-cat-cafe-user': 'alice',
  'x-clowder-dangerous-action-confirmed': 'thread.purge',
};

describe('Thread purge endpoints', () => {
  let app;
  let threadStore;
  let messageStore;
  let sessionChainStore;
  let taskProgressStore;
  let summaryStore;
  let freshnessHoldStore;
  let connectorBindingStore;
  let transcriptWriter;

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { SummaryStore } = await import('../dist/domains/cats/services/stores/ports/SummaryStore.js');
    const { FreshnessHoldStore } = await import('../dist/domains/cats/services/stores/ports/FreshnessHoldStore.js');
    const { MemoryConnectorThreadBindingStore } = await import(
      '../dist/infrastructure/connectors/ConnectorThreadBindingStore.js'
    );
    const { MemoryTaskProgressStore } = await import(
      '../dist/domains/cats/services/agents/invocation/MemoryTaskProgressStore.js'
    );
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    sessionChainStore = new SessionChainStore();
    taskProgressStore = new MemoryTaskProgressStore();
    summaryStore = new SummaryStore();
    freshnessHoldStore = new FreshnessHoldStore();
    connectorBindingStore = new MemoryConnectorThreadBindingStore();
    transcriptWriter = {
      deletedThreads: [],
      async deleteThread(threadId) {
        this.deletedThreads.push(threadId);
        return true;
      },
    };
    app = Fastify();
    await app.register(threadsRoutes, {
      threadStore,
      messageStore,
      sessionChainStore,
      taskProgressStore,
      summaryStore,
      freshnessHoldStore,
      connectorBindingStore,
      transcriptWriter,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  async function seedTrashedThread(title = 'Doomed') {
    const thread = await threadStore.create('alice', title);
    await messageStore.append({ userId: 'alice', content: 'hello', mentions: [], threadId: thread.id });
    await threadStore.softDelete(thread.id);
    return thread;
  }

  function purge(threadId, headers = CONFIRM_HEADERS) {
    return app.inject({ method: 'DELETE', url: `/api/threads/${threadId}/purge`, headers });
  }

  it('permanently removes a trashed thread and its messages', async () => {
    const thread = await seedTrashedThread();
    assert.equal((await messageStore.getByThread(thread.id)).length, 1);

    const res = await purge(thread.id);
    assert.equal(res.statusCode, 204);
    assert.equal(await threadStore.get(thread.id), null);
    assert.equal((await messageStore.getByThread(thread.id)).length, 0);
  });

  it('cascades into session chains and task progress snapshots', async () => {
    const thread = await seedTrashedThread();
    // Session records hold continuity capsules, so a purge that skips them would not
    // actually erase the conversation.
    await sessionChainStore.create({
      cliSessionId: 'cli-sess-1',
      threadId: thread.id,
      catId: 'opus',
      userId: 'alice',
    });
    await taskProgressStore.setSnapshot({ threadId: thread.id, catId: 'opus', updatedAt: Date.now() });

    const res = await purge(thread.id);

    assert.equal(res.statusCode, 204);
    assert.deepEqual(await sessionChainStore.getChainByThread(thread.id), []);
    assert.equal(await sessionChainStore.getByCliSessionId('cli-sess-1'), null);
    assert.deepEqual(await taskProgressStore.getThreadSnapshots(thread.id), {});
  });

  it('cascades into summaries, freshness holds, connector bindings and transcripts', async () => {
    const thread = await seedTrashedThread();
    await summaryStore.create({
      threadId: thread.id,
      topic: 'topic',
      conclusions: ['c1'],
      openQuestions: [],
      createdBy: 'user',
    });
    // Holds carry unpublished draft text, so they must not outlive a permanent delete.
    await freshnessHoldStore.createOrGet({
      invocationId: 'inv-1',
      submissionKey: 'sub-1',
      userId: 'alice',
      catId: 'opus',
      threadId: thread.id,
      baselineWatermark: '1',
      observedWatermark: '2',
      deltaMessageIds: [],
      draft: { content: 'secret draft' },
      createdAt: Date.now(),
      reviewDeadlineAt: Date.now() + 60_000,
    });
    await connectorBindingStore.bind('feishu', 'chat-1', thread.id, 'alice');

    const res = await purge(thread.id);

    assert.equal(res.statusCode, 204);
    assert.deepEqual(await summaryStore.listByThread(thread.id), []);
    assert.deepEqual(await freshnessHoldStore.listActive('alice', thread.id), []);
    assert.equal(await freshnessHoldStore.getBySubmission('inv-1', 'sub-1'), null);
    assert.deepEqual(await connectorBindingStore.getByThread(thread.id), []);
    assert.equal(await connectorBindingStore.getByExternal('feishu', 'chat-1'), null);
    assert.deepEqual(transcriptWriter.deletedThreads, [thread.id]);
  });

  it('finishes the purge even when a side store throws', async () => {
    const thread = await seedTrashedThread();
    transcriptWriter.deleteThread = async () => {
      throw new Error('disk on fire');
    };

    const res = await purge(thread.id);

    // Orphaned transcripts are bad, but a thread stuck in the trash bin is worse.
    assert.equal(res.statusCode, 204);
    assert.equal(await threadStore.get(thread.id), null);
    assert.equal((await messageStore.getByThread(thread.id)).length, 0);
  });

  it('keeps session chains of a thread that survives a refused purge', async () => {
    const thread = await threadStore.create('alice', 'Still active');
    await sessionChainStore.create({
      cliSessionId: 'cli-sess-keep',
      threadId: thread.id,
      catId: 'opus',
      userId: 'alice',
    });

    const res = await purge(thread.id);

    assert.equal(res.statusCode, 409);
    assert.equal((await sessionChainStore.getChainByThread(thread.id)).length, 1);
  });

  it('refuses to purge a thread that is not in the trash bin', async () => {
    const thread = await threadStore.create('alice', 'Still active');

    const res = await purge(thread.id);
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'THREAD_NOT_DELETED');
    assert.ok(await threadStore.get(thread.id), 'thread must survive a refused purge');
  });

  it('requires the dangerous-action confirmation for browser callers', async () => {
    const thread = await seedTrashedThread();

    // The guard only enforces confirmation when Origin is present — non-browser callers
    // stay backward-compatible (see requireDangerousActionConfirmation).
    const res = await purge(thread.id, { 'x-cat-cafe-user': 'alice', origin: 'http://localhost:3003' });
    assert.equal(res.statusCode, 428);
    assert.ok(await threadStore.get(thread.id), 'thread must survive an unconfirmed purge');
  });

  it('404s for an unknown thread', async () => {
    const res = await purge('thread_missing');
    assert.equal(res.statusCode, 404);
  });

  it('never purges the default thread', async () => {
    const res = await purge('default');
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, 'THREAD_NOT_PURGEABLE');
  });

  it('empties the trash bin and leaves active threads untouched', async () => {
    const trashedA = await seedTrashedThread('Trash A');
    const trashedB = await seedTrashedThread('Trash B');
    const active = await threadStore.create('alice', 'Keep me');

    const res = await app.inject({ method: 'DELETE', url: '/api/threads/trash', headers: CONFIRM_HEADERS });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).purged, 2);
    assert.equal(await threadStore.get(trashedA.id), null);
    assert.equal(await threadStore.get(trashedB.id), null);
    assert.ok(await threadStore.get(active.id), 'active thread must not be purged');
  });

  it('reports zero when the trash bin is already empty', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/threads/trash', headers: CONFIRM_HEADERS });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).purged, 0);
  });

  it('requires confirmation to empty the trash bin for browser callers', async () => {
    const trashed = await seedTrashedThread();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/trash',
      headers: { 'x-cat-cafe-user': 'alice', origin: 'http://localhost:3003' },
    });
    assert.equal(res.statusCode, 428);
    assert.ok(await threadStore.get(trashed.id), 'thread must survive an unconfirmed empty');
  });
});
