/**
 * GET /api/threads/:id/branches
 *
 * Deleting a parent thread does not cascade to its branches (each branch holds a full
 * copy of the messages). This endpoint lets the UI say so instead of leaving the user
 * to wonder why an orphaned project group reappeared.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('Thread branches endpoint', () => {
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

  async function getBranches(threadId) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/${threadId}/branches`,
      headers: { 'x-cat-cafe-user': 'alice' },
    });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  }

  it('returns an empty list for a thread without branches', async () => {
    const parent = await threadStore.create('alice', 'Parent');
    const { status, body } = await getBranches(parent.id);
    assert.equal(status, 200);
    assert.deepEqual(body.branches, []);
  });

  it('404s for an unknown thread', async () => {
    const { status } = await getBranches('thread_does_not_exist');
    assert.equal(status, 404);
  });

  it('lists branches recorded via parentThreadId', async () => {
    const parent = await threadStore.create('alice', 'Parent');
    const branch = await threadStore.create('alice', 'Parent (分支)');
    await threadStore.updateParentThread(branch.id, parent.id);

    const { body } = await getBranches(parent.id);
    assert.equal(body.branches.length, 1);
    assert.equal(body.branches[0].id, branch.id);
    assert.equal(body.branches[0].title, 'Parent (分支)');
  });

  it('omits soft-deleted branches', async () => {
    const parent = await threadStore.create('alice', 'Parent');
    const branch = await threadStore.create('alice', 'Parent (分支)');
    await threadStore.updateParentThread(branch.id, parent.id);
    await threadStore.softDelete(branch.id);

    const { body } = await getBranches(parent.id);
    assert.deepEqual(body.branches, []);
  });

  it('falls back to legacy slockThread links when parentThreadId is absent', async () => {
    // Branches created before parentThreadId existed only recorded provenance on the
    // parent message, so historical threads must still resolve without a migration.
    const parent = await threadStore.create('alice', 'Legacy parent');
    const branch = await threadStore.create('alice', 'Legacy branch');
    const message = await messageStore.append({
      userId: 'alice',
      content: 'branch point',
      mentions: [],
      threadId: parent.id,
    });
    await messageStore.updateExtra(message.id, { slockThread: { branchThreadId: branch.id, replyCount: 0 } });

    const { body } = await getBranches(parent.id);
    assert.equal(body.branches.length, 1);
    assert.equal(body.branches[0].id, branch.id);
  });

  it('prefers parentThreadId over the legacy scan when both exist', async () => {
    const parent = await threadStore.create('alice', 'Parent');
    const tracked = await threadStore.create('alice', 'Tracked branch');
    const legacyOnly = await threadStore.create('alice', 'Legacy branch');
    await threadStore.updateParentThread(tracked.id, parent.id);
    const message = await messageStore.append({
      userId: 'alice',
      content: 'branch point',
      mentions: [],
      threadId: parent.id,
    });
    await messageStore.updateExtra(message.id, { slockThread: { branchThreadId: legacyOnly.id, replyCount: 0 } });

    const { body } = await getBranches(parent.id);
    assert.deepEqual(
      body.branches.map((branch) => branch.id),
      [tracked.id],
    );
  });

  it('clears the parent pointer when set to null', async () => {
    const parent = await threadStore.create('alice', 'Parent');
    const branch = await threadStore.create('alice', 'Branch');
    await threadStore.updateParentThread(branch.id, parent.id);
    await threadStore.updateParentThread(branch.id, null);

    assert.equal((await threadStore.get(branch.id)).parentThreadId, undefined);
    const { body } = await getBranches(parent.id);
    assert.deepEqual(body.branches, []);
  });
});
