import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const scriptPath = resolve(import.meta.dirname, 'live-worktree-build-gate.mjs');

function run(command, cwd) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-live-gate-'));
  run(['git', 'init'], dir);
  run(['git', 'config', 'user.email', 'test@example.com'], dir);
  run(['git', 'config', 'user.name', 'Test User'], dir);
  mkdirSync(join(dir, 'packages', 'api', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(join(dir, 'packages', 'api', 'src.txt'), 'clean\n');
  writeFileSync(join(dir, 'packages', 'api', 'dist', 'index.js'), 'good\n');
  run(['git', 'add', '.'], dir);
  run(['git', 'commit', '-m', 'init'], dir);
  return dir;
}

function gate(cwd, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('runs build command when worktree is clean', () => {
  const repo = initRepo();
  try {
    const marker = join(repo, 'packages', 'api', 'dist', 'rebuilt.txt');
    const result = gate(join(repo, 'packages', 'api'), [
      '--artifact',
      'dist/index.js',
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'rebuilt')`,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('uses Clowder repo root markers instead of nested package git metadata', () => {
  const repo = initRepo();
  try {
    const packageDir = join(repo, 'packages', 'api');
    run(['git', 'init'], packageDir);
    writeFileSync(join(repo, 'packages', 'api', 'src.txt'), 'dirty\n');

    const result = gate(packageDir, ['--artifact', 'dist/index.js', '--check-only']);

    assert.equal(result.status, 10, result.stderr);
    assert.match(result.stderr, /packages\/api\/src\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('skips build command on tracked dirty source when previous artifact exists', () => {
  const repo = initRepo();
  try {
    const marker = join(repo, 'packages', 'api', 'dist', 'rebuilt.txt');
    writeFileSync(join(repo, 'packages', 'api', 'src.txt'), 'dirty\n');

    const result = gate(join(repo, 'packages', 'api'), [
      '--artifact',
      'dist/index.js',
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'rebuilt')`,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /skipping live rebuild/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('fails dirty startup when no previous good artifact exists', () => {
  const repo = initRepo();
  try {
    rmSync(join(repo, 'packages', 'api', 'dist'), { recursive: true, force: true });
    writeFileSync(join(repo, 'packages', 'api', 'src.txt'), 'dirty\n');

    const result = gate(join(repo, 'packages', 'api'), ['--artifact', 'dist/index.js', '--check-only']);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /required good artifact/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('ignores untracked docs but blocks untracked runtime-sensitive files', () => {
  const repo = initRepo();
  try {
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'note.md'), 'local note\n');
    let result = gate(join(repo, 'packages', 'api'), ['--artifact', 'dist/index.js', '--check-only']);
    assert.equal(result.status, 0, result.stderr);

    writeFileSync(join(repo, 'packages', 'api', 'new-runtime-file.ts'), 'export {};\n');
    result = gate(join(repo, 'packages', 'api'), ['--artifact', 'dist/index.js', '--check-only']);
    assert.equal(result.status, 10, result.stderr);
    assert.match(result.stderr, /new-runtime-file/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
