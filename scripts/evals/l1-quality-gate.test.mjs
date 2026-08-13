#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const script = resolve(__dirname, 'l1-quality-gate.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'l1-quality-gate-'));

// 模拟一个干净的 git 仓库（有 pnpm-workspace.yaml 和 ecosystem.config.cjs）
const fakeRepo = join(tmp, 'fake-repo');
mkdirSync(fakeRepo, { recursive: true });
writeFileSync(join(fakeRepo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
writeFileSync(join(fakeRepo, 'ecosystem.config.cjs'), 'module.exports = {};\n');

// 初始化 git + commit 所有文件
execFileSync('git', ['init', fakeRepo], { stdio: 'ignore' });
execFileSync('git', ['-C', fakeRepo, 'add', '.'], { stdio: 'ignore' });
execFileSync(
  'git',
  ['-C', fakeRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'],
  { stdio: 'ignore' },
);

try {
  // 测试：用 execFileSync 的 { stdio: 'pipe' } 捕获 stdout 和 exit code
  const child = execFileSync('node', [script, '--json'], {
    cwd: fakeRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: process.env.PATH },
  });

  const result = JSON.parse(child);

  // 结构检查
  assert.equal(typeof result.allPassed, 'boolean', 'should have allPassed boolean');
  assert.ok(Array.isArray(result.results), 'should have results array');
  assert.equal(result.results.length, 4, 'should have 4 assertions');

  // worktree-clean 应该通过（因为仓库是干净的）
  const worktreeCheck = result.results.find((r) => r.name.includes('Worktree'));
  assert.ok(worktreeCheck, 'should have worktree check');
  assert.equal(worktreeCheck.passed, true, 'clean worktree should pass');

  // build 应该失败（因为不是真实 monorepo，没有 packages）
  const buildCheck = result.results.find((r) => r.name.includes('Build'));
  assert.ok(buildCheck, 'should have build check');
  assert.equal(buildCheck.passed, false, 'build should fail in fake repo');

  // 整体应该失败（因为 build/tsc/test 会挂）
  assert.equal(result.allPassed, false, 'overall should fail in fake repo');

  console.log('✅ l1-quality-gate.mjs test passed');
} catch (e) {
  // 如果脚本返回非 0 exit code，execFileSync 会抛异常，但 stdout 在 e.stdout 里
  if (e.stdout) {
    const result = JSON.parse(e.stdout);

    assert.equal(typeof result.allPassed, 'boolean', 'should have allPassed boolean');
    assert.ok(Array.isArray(result.results), 'should have results array');
    assert.equal(result.results.length, 4, 'should have 4 assertions');

    const worktreeCheck = result.results.find((r) => r.name.includes('Worktree'));
    assert.ok(worktreeCheck, 'should have worktree check');
    assert.equal(worktreeCheck.passed, true, 'clean worktree should pass');

    console.log('✅ l1-quality-gate.mjs test passed (script returned exit 1 as expected)');
  } else {
    throw e;
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
