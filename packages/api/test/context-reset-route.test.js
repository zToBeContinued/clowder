import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('POST /api/threads/:id/reset-context', () => {
  let app;
  let threadStore;
  let messageStore;
  let deliveryCursorStore;
  let invocationTracker;
  let invocationQueue;
  let resetCalls;

  beforeEach(async () => {
    const [
      { ThreadStore },
      { MessageStore },
      { DeliveryCursorStore },
      { InvocationTracker },
      { InvocationQueue },
      { threadsRoutes },
    ] = await Promise.all([
      import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
      import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
      import('../dist/routes/threads.js'),
    ]);
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    deliveryCursorStore = new DeliveryCursorStore();
    invocationTracker = new InvocationTracker();
    invocationQueue = new InvocationQueue();
    resetCalls = [];
    app = Fastify();
    await app.register(threadsRoutes, {
      threadStore,
      messageStore,
      deliveryCursorStore,
      invocationTracker,
      invocationQueue,
      async resetContextSessions(userId, threadId) {
        resetCalls.push({ userId, threadId });
        return { cleared: 2, sealed: 1 };
      },
    });
    await app.ready();
  });

  afterEach(async () => app?.close());

  it('persists the latest-message boundary, clears capsules, and skips unread', async () => {
    const thread = threadStore.create('default-user', 'Reset me');
    threadStore.addParticipants(thread.id, ['codex']);
    threadStore.setPendingContinuation(thread.id, 'codex', 'default-user', {
      capsule: { sentinel: 'old-capsule' },
      createdAt: 1,
    });
    const latest = messageStore.append({
      threadId: thread.id,
      userId: 'default-user',
      catId: null,
      content: 'old history',
      mentions: [],
      timestamp: Date.now(),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/reset-context`,
      headers: { origin: 'http://localhost:3003' },
      payload: {},
    });

    assert.equal(response.statusCode, 200, response.body);
    const body = JSON.parse(response.body);
    assert.ok(body.boundary.resetAtMessageId >= latest.id);
    assert.equal(body.boundary.contextEpoch, 1);
    assert.deepEqual(resetCalls, [{ userId: 'default-user', threadId: thread.id }]);
    assert.equal(threadStore.consumePendingContinuation(thread.id, 'codex', 'default-user'), null);
    assert.equal(
      await deliveryCursorStore.getCursor('default-user', 'codex', thread.id),
      body.boundary.resetAtMessageId,
    );
    assert.equal(
      await deliveryCursorStore.getMentionAckCursor('default-user', 'codex', thread.id),
      body.boundary.resetAtMessageId,
    );
    assert.equal(messageStore.getByThread(thread.id, 10).length, 1, 'audit history must remain');
  });

  it('rejects non-browser and callback principals without changing state', async () => {
    const thread = threadStore.create('default-user', 'Reset me');
    const noOrigin = await app.inject({ method: 'POST', url: `/api/threads/${thread.id}/reset-context`, payload: {} });
    assert.equal(noOrigin.statusCode, 401);
    const callback = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/reset-context`,
      headers: { origin: 'http://localhost:3003', 'x-agent-key-secret': 'not-a-real-key' },
      payload: {},
    });
    assert.equal(callback.statusCode, 403);
    assert.equal(threadStore.getContextResetBoundary(thread.id, 'default-user'), null);
  });

  it('uses the absolute delivered watermark even when the latest history is deleted', async () => {
    const thread = threadStore.create('default-user', 'Deleted reset boundary');
    threadStore.addParticipants(thread.id, ['codex']);
    const older = messageStore.append({
      threadId: thread.id,
      userId: 'default-user',
      catId: null,
      content: 'older visible',
      mentions: [],
      timestamp: 1,
    });
    const latest = messageStore.append({
      threadId: thread.id,
      userId: 'default-user',
      catId: null,
      content: 'latest deleted',
      mentions: [],
      timestamp: 2,
    });
    messageStore.softDelete(older.id, 'default-user');
    messageStore.softDelete(latest.id, 'default-user');

    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/reset-context`,
      headers: { origin: 'http://localhost:3003' },
      payload: {},
    });

    assert.equal(response.statusCode, 200, response.body);
    const boundaryId = JSON.parse(response.body).boundary.resetAtMessageId;
    assert.ok(boundaryId >= latest.id);
    assert.equal(await deliveryCursorStore.getCursor('default-user', 'codex', thread.id), boundaryId);
  });

  it('creates a sortable reset watermark for an empty retained-summary thread', async () => {
    const thread = threadStore.create('default-user', 'Empty reset boundary');
    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/reset-context`,
      headers: { origin: 'http://localhost:3003' },
      payload: {},
    });

    assert.equal(response.statusCode, 200, response.body);
    const boundaryId = JSON.parse(response.body).boundary.resetAtMessageId;
    assert.equal(typeof boundaryId, 'string');
    assert.ok(boundaryId.length > 0);
    const future = messageStore.append({
      threadId: thread.id,
      userId: 'default-user',
      catId: null,
      content: 'first post-reset message',
      mentions: [],
      timestamp: Date.now() + 2,
    });
    assert.ok(future.id > boundaryId);
  });

  it('returns 409 with zero mutations for active or queued work', async () => {
    const thread = threadStore.create('default-user', 'Busy reset');
    const controller = invocationTracker.start(thread.id, 'codex', 'default-user');
    const active = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/reset-context`,
      headers: { origin: 'http://localhost:3003' },
      payload: {},
    });
    assert.equal(active.statusCode, 409);
    invocationTracker.complete(thread.id, 'codex', controller);

    invocationQueue.enqueue({
      threadId: thread.id,
      userId: 'default-user',
      content: 'queued',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
    });
    const queued = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/reset-context`,
      headers: { origin: 'http://localhost:3003' },
      payload: {},
    });
    assert.equal(queued.statusCode, 409);
    assert.equal(threadStore.getContextResetBoundary(thread.id, 'default-user'), null);
    assert.equal(resetCalls.length, 0);
  });

  it('returns 409 while a callback mutation holds the shared admission lock', async () => {
    const thread = threadStore.create('default-user', 'Callback race reset');
    const callbackGuard = invocationQueue.guardCallbackMutation(thread.id);
    assert.equal(callbackGuard.acquired, true);

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/reset-context`,
      headers: { origin: 'http://localhost:3003' },
      payload: {},
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(threadStore.getContextResetBoundary(thread.id, 'default-user'), null);

    callbackGuard.release();
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/reset-context`,
      headers: { origin: 'http://localhost:3003' },
      payload: {},
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  });
});
