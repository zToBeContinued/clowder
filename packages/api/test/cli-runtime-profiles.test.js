// @ts-check
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };

const {
  createCliRuntimeProfile,
  getCliRuntimeProfile,
  mergeCliRuntimeProfileEnv,
  normalizeCliRuntimeCommand,
  patchCliRuntimeProfile,
  resolveCliRuntimeCommand,
  resolveCliRuntimeProfilesPath,
  toCliRuntimeProfileView,
} = await import('../dist/config/cli-runtime-profile-store.js');

async function withIsolatedRoot(run) {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-cli-runtime-profile-'));
  const previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
    else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
    await rm(root, { recursive: true, force: true });
  }
}

describe('CLI runtime profile store and routes', { concurrency: false }, () => {
  it('stores profiles under the machine config root and exposes write-only metadata', async () => {
    await withIsolatedRoot(async (root) => {
      const secretProxy = 'http://proxy-user:proxy-password@127.0.0.1:7890';
      const created = createCliRuntimeProfile({
        id: 'kiro-proxy-local',
        displayName: 'Kiro 本机代理',
        command: 'kiro-cli',
        envSet: {
          HTTP_PROXY: secretProxy,
          NO_PROXY: 'localhost,127.0.0.1,::1',
        },
      });

      assert.equal(created.envVars.HTTP_PROXY, secretProxy);
      const filePath = resolveCliRuntimeProfilesPath();
      assert.equal(filePath, resolve(root, '.cat-cafe', 'cli-runtime-profiles.local.json'));
      assert.equal(existsSync(filePath), true);
      assert.deepEqual(
        readdirSync(dirname(filePath)).filter((name) => name.includes('.tmp-')),
        [],
        'atomic temp files must be cleaned up',
      );
      if (process.platform !== 'win32') {
        assert.equal(statSync(filePath).mode & 0o777, 0o600);
      }

      const view = toCliRuntimeProfileView(created);
      assert.deepEqual(view.envKeys, ['HTTP_PROXY', 'NO_PROXY']);
      assert.deepEqual(view.envStatus, [
        { key: 'HTTP_PROXY', isSet: true },
        { key: 'NO_PROXY', isSet: true },
      ]);
      assert.equal(JSON.stringify(view).includes('proxy-password'), false);
      assert.equal(Object.hasOwn(view, 'envVars'), false);

      const patched = patchCliRuntimeProfile('kiro-proxy-local', {
        command: null,
        envSet: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
        envRemove: ['HTTP_PROXY'],
      });
      assert.equal(patched.command, undefined);
      assert.equal(patched.envVars.HTTP_PROXY, undefined);
      assert.equal(patched.envVars.HTTPS_PROXY, 'http://127.0.0.1:7890');
      assert.equal(patched.envVars.NO_PROXY, 'localhost,127.0.0.1,::1');

      assert.deepEqual(
        mergeCliRuntimeProfileEnv(
          { HTTP_PROXY: 'runtime', SHARED: 'runtime' },
          { HTTPS_PROXY: 'legacy', SHARED: 'legacy' },
        ),
        { HTTP_PROXY: 'runtime', HTTPS_PROXY: 'legacy', SHARED: 'legacy' },
      );
      assert.equal(resolveCliRuntimeCommand({ command: 'profile-cli' }, 'member-cli', 'default-cli'), 'profile-cli');
      assert.equal(resolveCliRuntimeCommand(undefined, 'member-cli', 'default-cli'), 'member-cli');
      assert.throws(() => normalizeCliRuntimeCommand('kiro-cli --trust-all-tools'), /must not include arguments/i);
      assert.throws(
        () => createCliRuntimeProfile({ displayName: 'bad env', envSet: { CAT_CAFE_TOKEN: 'nope' } }),
        /reserved CAT_CAFE_/i,
      );
    });
  });

  it('supports write-only CRUD and refuses deletion while a member references the profile', async () => {
    await withIsolatedRoot(async (root) => {
      const Fastify = (await import('fastify')).default;
      const { cliRuntimeProfilesRoutes } = await import('../dist/routes/cli-runtime-profiles.js');
      const app = Fastify();
      await app.register(cliRuntimeProfilesRoutes);
      await app.ready();

      try {
        const unauthorized = await app.inject({ method: 'GET', url: '/api/cli-runtime-profiles' });
        assert.equal(unauthorized.statusCode, 401);

        const secretProxy = 'http://route-user:route-password@127.0.0.1:7890';
        const createRes = await app.inject({
          method: 'POST',
          url: '/api/cli-runtime-profiles',
          headers: AUTH_HEADERS,
          payload: {
            id: 'route-profile',
            displayName: 'Route Profile',
            command: 'kiro-cli',
            envSet: { HTTP_PROXY: secretProxy, NO_PROXY: 'localhost' },
          },
        });
        assert.equal(createRes.statusCode, 201, createRes.body);
        assert.equal(createRes.body.includes('route-password'), false);
        assert.deepEqual(createRes.json().profile.envStatus, [
          { key: 'HTTP_PROXY', isSet: true },
          { key: 'NO_PROXY', isSet: true },
        ]);

        const listRes = await app.inject({
          method: 'GET',
          url: '/api/cli-runtime-profiles',
          headers: { 'x-cat-cafe-user': 'test-user' },
        });
        assert.equal(listRes.statusCode, 200, listRes.body);
        assert.equal(listRes.body.includes('route-password'), false);
        assert.equal(listRes.json().configRoot, resolve(root, '.cat-cafe'));
        assert.deepEqual(listRes.json().profiles[0].envKeys, ['HTTP_PROXY', 'NO_PROXY']);

        const patchRes = await app.inject({
          method: 'PATCH',
          url: '/api/cli-runtime-profiles/route-profile',
          headers: AUTH_HEADERS,
          payload: {
            envSet: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
            envRemove: ['HTTP_PROXY'],
          },
        });
        assert.equal(patchRes.statusCode, 200, patchRes.body);
        const stored = getCliRuntimeProfile('route-profile');
        assert.equal(stored?.envVars.HTTP_PROXY, undefined);
        assert.equal(stored?.envVars.HTTPS_PROXY, 'http://127.0.0.1:7890');
        assert.equal(stored?.envVars.NO_PROXY, 'localhost');

        const invalidRes = await app.inject({
          method: 'PATCH',
          url: '/api/cli-runtime-profiles/route-profile',
          headers: AUTH_HEADERS,
          payload: { command: 'kiro-cli && echo unsafe' },
        });
        assert.equal(invalidRes.statusCode, 400);

        const catalogDir = join(root, '.cat-cafe');
        mkdirSync(catalogDir, { recursive: true });
        const catalogPath = join(catalogDir, 'cat-catalog.json');
        writeFileSync(
          catalogPath,
          JSON.stringify({
            version: 2,
            breeds: [
              {
                catId: 'kiro-cat',
                variants: [{ id: 'kiro-default', cliRuntimeProfileRef: 'route-profile' }],
              },
            ],
          }),
        );

        const blockedDelete = await app.inject({
          method: 'DELETE',
          url: '/api/cli-runtime-profiles/route-profile',
          headers: { 'x-cat-cafe-user': 'test-user' },
        });
        assert.equal(blockedDelete.statusCode, 409, blockedDelete.body);
        assert.deepEqual(blockedDelete.json().boundCatIds, ['kiro-cat']);

        writeFileSync(catalogPath, JSON.stringify({ version: 2, breeds: [] }));
        const deleteRes = await app.inject({
          method: 'DELETE',
          url: '/api/cli-runtime-profiles/route-profile',
          headers: { 'x-cat-cafe-user': 'test-user' },
        });
        assert.equal(deleteRes.statusCode, 200, deleteRes.body);
        assert.equal(getCliRuntimeProfile('route-profile'), undefined);
        assert.equal(readFileSync(resolveCliRuntimeProfilesPath(), 'utf-8').includes('route-password'), false);
      } finally {
        await app.close();
      }
    });
  });
});
