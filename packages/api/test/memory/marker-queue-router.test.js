/**
 * Marker 的项目归属路由
 *
 * thread 可以挂在任意外部项目上。retain-memory 产出的知识 marker 必须写回该项目
 * 自己的 docs/markers/，而不是全部堆进 Clowder 的知识库（一个 git 跟踪的目录）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { MarkerQueueRouter } = await import('../../dist/domains/memory/MarkerQueueRouter.js');

function createRouter(repoRoot, { isSameRepoResult = false } = {}) {
  const created = [];
  const localQueue = { id: 'local', submit: async () => {}, list: async () => [], transition: async () => {} };
  // createQueue 注入，避免在测试里真的往磁盘建目录
  const router = new MarkerQueueRouter(localQueue, repoRoot, (dir) => {
    const queue = { id: 'external', dir, submit: async () => {}, list: async () => [], transition: async () => {} };
    created.push(queue);
    return queue;
  });
  return { router, localQueue, created, isSameRepoResult };
}

describe('MarkerQueueRouter', () => {
  const tempDirs = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('routes an unbound project to the local queue', () => {
    const { router, localQueue, created } = createRouter('/clowder');
    assert.strictEqual(router.resolve(undefined), localQueue);
    assert.strictEqual(router.resolve(''), localQueue);
    assert.strictEqual(router.resolve('   '), localQueue);
    assert.strictEqual(router.resolve('default'), localQueue);
    assert.equal(created.length, 0, 'must not create external queues for unbound projects');
  });

  it('routes the repo itself to the local queue', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clowder-marker-repo-'));
    tempDirs.push(repoRoot);
    const { router, localQueue, created } = createRouter(repoRoot);

    assert.strictEqual(router.resolve(repoRoot), localQueue);
    assert.equal(created.length, 0);
  });

  it('routes an external project to its own docs/markers', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clowder-marker-repo-'));
    const external = mkdtempSync(join(tmpdir(), 'clowder-marker-ext-'));
    tempDirs.push(repoRoot, external);
    const { router, localQueue, created } = createRouter(repoRoot);

    const queue = router.resolve(external);

    assert.notStrictEqual(queue, localQueue, 'external project must not share the repo knowledge base');
    assert.equal(created.length, 1);
    assert.equal(queue.dir, resolve(external, 'docs', 'markers'));
  });

  it('reuses one queue per external project', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'clowder-marker-repo-'));
    const external = mkdtempSync(join(tmpdir(), 'clowder-marker-ext-'));
    tempDirs.push(repoRoot, external);
    const { router, created } = createRouter(repoRoot);

    const first = router.resolve(external);
    const second = router.resolve(external);

    assert.strictEqual(first, second);
    assert.equal(created.length, 1, 'must cache per markers dir');
  });
});

describe('retain-memory marker routing', () => {
  let app;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  function createMockRegistry(threadId) {
    return {
      verify: async () => ({
        ok: true,
        record: {
          invocationId: 'inv-1',
          catId: 'opus48-implementer',
          userId: 'user-1',
          threadId,
          callbackToken: 'tok-1',
        },
      }),
    };
  }

  async function post(deps, threadId) {
    const mod = await import('../../dist/routes/callback-memory-routes.js');
    const authMod = await import('../../dist/routes/callback-auth-prehandler.js');
    app = Fastify();
    authMod.registerCallbackAuthHook(app, createMockRegistry(threadId));
    await mod.registerCallbackMemoryRoutes(app, deps);
    await app.ready();
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/retain-memory',
      headers: { 'x-invocation-id': 'inv-1', 'x-callback-token': 'tok-1' },
      payload: { content: 'QMT responder 收口裁决记录' },
    });
  }

  function makeQueue(sink) {
    return {
      submit: async (marker) => {
        sink.push(marker);
        return { ...marker, id: 'mk-1', createdAt: new Date().toISOString() };
      },
      list: async () => [],
      transition: async () => {},
    };
  }

  it("sends an external project's marker to that project, not the repo knowledge base", async () => {
    const local = [];
    const external = [];
    const externalQueue = makeQueue(external);
    const res = await post(
      {
        markerQueue: makeQueue(local),
        markerQueueRouter: { resolve: (projectPath) => (projectPath === 'D:\\project\\quant' ? externalQueue : null) },
        threadStore: { get: async () => ({ projectPath: 'D:\\project\\quant' }) },
      },
      'thread-quant',
    );

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'ok');
    assert.equal(local.length, 0, 'repo knowledge base must stay clean');
    assert.equal(external.length, 1);
  });

  it('falls back to the local queue when the thread cannot be resolved', async () => {
    const local = [];
    const res = await post(
      {
        markerQueue: makeQueue(local),
        markerQueueRouter: {
          resolve: (projectPath) => {
            assert.equal(projectPath, undefined, 'unresolvable thread yields no projectPath');
            return makeQueue(local);
          },
        },
        threadStore: {
          get: async () => {
            throw new Error('thread store down');
          },
        },
      },
      'thread-gone',
    );

    assert.equal(res.statusCode, 200);
    assert.equal(local.length, 1, 'marker must not be dropped when routing info is missing');
  });

  it('keeps the legacy single-queue behavior when no router is wired', async () => {
    const local = [];
    const res = await post({ markerQueue: makeQueue(local) }, 'thread-1');

    assert.equal(res.statusCode, 200);
    assert.equal(local.length, 1);
  });
});
