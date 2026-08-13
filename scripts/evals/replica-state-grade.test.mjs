#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const script = join(root, 'scripts', 'evals', 'replica-state-grade.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'replica-state-grade-'));

try {
  const realRepo = join(tmp, 'RealRepo');
  const linkRepo = join(tmp, 'repo-link');
  const target = join(realRepo, 'index.html');
  const reference = join(tmp, 'reference.html');

  execFileSync('git', ['init', realRepo], { stdio: 'ignore' });
  writeFileSync(target, '<html><body>Alpha Tool 505 tools</body></html>');
  execFileSync('git', ['-C', realRepo, 'add', 'index.html'], { stdio: 'ignore' });
  execFileSync(
    'git',
    ['-C', realRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial'],
    { stdio: 'ignore' },
  );

  writeFileSync(reference, '<script>{"name":"Alpha Tool","total":505}</script>');
  symlinkSync(realRepo, linkRepo, 'dir');

  const output = execFileSync(
    'node',
    [script, '--target', target, '--reference', reference, '--repo', linkRepo, '--expected-total', '505', '--json'],
    { encoding: 'utf8' },
  );
  const result = JSON.parse(output);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.checks.find((check) => check.id === 'target_bound_to_commit')?.ok, true);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
