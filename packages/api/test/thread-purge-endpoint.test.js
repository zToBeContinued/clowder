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

  beforeEach(async () => {
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { threadsRoutes } = await import('../dist/routes/threads.js');

    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    app = Fastify();
    await app.register(threadsRoutes, { threadStore, messageStore });
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
