/**
 * 2026-08-13 现场回归:服务运行中偶发弹出 Windows「选择应用以打开 clowder」。
 * 根因:resolveClowderCliEnv 把 CLOWDER_CLI_PATH 指向无扩展名的 Node 脚本
 * bin/clowder——Windows cmd 对存在但不可执行的文件转交 ShellExecute,无关联
 * 即弹系统选择器;且 PATH 用 ':' 拼接,Windows 分隔符是 ';',子进程 PATH 被拼坏。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const { resolveClowderCliEnv } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');

const repoRoot = resolve(import.meta.dirname, '../../..');

test('win32:CLI 指向 clowder.cmd 垫片,PATH 用分号拼接', () => {
  const env = resolveClowderCliEnv(repoRoot, 'win32');
  assert.ok(env.CLOWDER_CLI_PATH, 'bin/clowder.cmd 必须存在(Windows 可执行垫片)');
  assert.ok(env.CLOWDER_CLI_PATH.endsWith('clowder.cmd'), `不能把无扩展名脚本喂给 Windows:${env.CLOWDER_CLI_PATH}`);
  assert.ok(env.PATH.includes(';'), 'Windows PATH 分隔符是分号');
  assert.ok(!env.PATH.startsWith(`${env.CLOWDER_CLI_PATH}:`), '不得用冒号拼 Windows PATH');
});

test('POSIX:CLI 指向 shebang 脚本本体,PATH 用冒号拼接', () => {
  const env = resolveClowderCliEnv(repoRoot, 'linux');
  assert.ok(env.CLOWDER_CLI_PATH.endsWith('clowder'), 'POSIX 直接用 shebang 脚本');
  assert.ok(!env.CLOWDER_CLI_PATH.endsWith('.cmd'));
  const binDir = env.CLOWDER_CLI_PATH.slice(0, -'/clowder'.length);
  assert.ok(env.PATH.startsWith(binDir), 'binDir 应前置进 PATH');
});

test('bin 目录缺失时返回空对象', () => {
  const env = resolveClowderCliEnv(resolve(repoRoot, 'definitely-not-a-dir'), 'win32');
  assert.deepEqual(env, {});
});

test('仓库里必须存在 bin/clowder.cmd 垫片文件本体', () => {
  assert.ok(existsSync(resolve(repoRoot, 'bin', 'clowder.cmd')), 'bin/clowder.cmd 缺失');
});
