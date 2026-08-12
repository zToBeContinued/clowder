/**
 * process-tree-kill Tests
 *
 * 2026-08-12 quant「幽灵写手」事故回归：Windows 上 child.kill() 只杀直接子进程，
 * CLI 经 .ps1/.cmd/git-bash 包装进程启动时，超时击杀只杀掉包装层，真正的
 * CLI 孙进程沦为孤儿继续写文件；槽位释放后同一只猫又被拉起第二个进程。
 * 树击杀（taskkill /T /F）必须覆盖整棵进程树。
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const { killProcessTree, killProcessTreeSync } = await import('../dist/utils/process-tree-kill.js');

test('killProcessTree on win32 runs taskkill /pid <pid> /T /F', async () => {
  const calls = [];
  const execFileFn = mock.fn((cmd, args, _options, callback) => {
    calls.push({ cmd, args });
    callback(null);
  });

  const ok = await killProcessTree(4321, { platform: 'win32', execFileFn });

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '4321', '/T', '/F']);
});

test('killProcessTree resolves false when taskkill fails (caller falls back to direct kill)', async () => {
  const execFileFn = mock.fn((_cmd, _args, _options, callback) => {
    callback(new Error('taskkill: process not found'));
  });

  const ok = await killProcessTree(4321, { platform: 'win32', execFileFn });

  assert.equal(ok, false);
});

test('killProcessTree is a no-op on non-Windows platforms', async () => {
  const execFileFn = mock.fn((_cmd, _args, _options, callback) => callback(null));

  const ok = await killProcessTree(4321, { platform: 'linux', execFileFn });

  assert.equal(ok, false);
  assert.equal(execFileFn.mock.callCount(), 0, 'POSIX 直接子进程即 agent 本体，走原信号路径');
});

test('killProcessTreeSync on win32 runs taskkill synchronously (process-exit handler path)', () => {
  const calls = [];
  const spawnSyncFn = mock.fn((cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0 };
  });

  const ok = killProcessTreeSync(9876, { platform: 'win32', spawnSyncFn });

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '9876', '/T', '/F']);
});

test('killProcessTreeSync returns false on non-zero exit and on non-Windows', () => {
  const failingSpawnSync = mock.fn(() => ({ status: 128 }));
  assert.equal(killProcessTreeSync(9876, { platform: 'win32', spawnSyncFn: failingSpawnSync }), false);

  const untouchedSpawnSync = mock.fn(() => ({ status: 0 }));
  assert.equal(killProcessTreeSync(9876, { platform: 'darwin', spawnSyncFn: untouchedSpawnSync }), false);
  assert.equal(untouchedSpawnSync.mock.callCount(), 0);
});

test('killProcessTreeSync swallows spawnSync throw (exit handler must never crash shutdown)', () => {
  const throwingSpawnSync = mock.fn(() => {
    throw new Error('EPERM');
  });
  assert.equal(killProcessTreeSync(9876, { platform: 'win32', spawnSyncFn: throwingSpawnSync }), false);
});
