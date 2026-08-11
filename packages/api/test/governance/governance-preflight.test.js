import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { GovernanceBootstrapService } from '../../dist/config/governance/governance-bootstrap.js';
import { GOVERNANCE_PACK_VERSION } from '../../dist/config/governance/governance-pack.js';
import { checkGovernancePreflight } from '../../dist/config/governance/governance-preflight.js';
import { GovernanceRegistry } from '../../dist/config/governance/governance-registry.js';

describe('governance-preflight', () => {
  let catCafeRoot;
  let externalProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    externalProject = await mkdtemp(join(tmpdir(), 'external-project-'));
    // Some tests use full write mode, which needs at least one skill available
    await mkdir(join(catCafeRoot, 'cat-cafe-skills', 'tdd'), { recursive: true });
    await writeFile(join(catCafeRoot, 'cat-cafe-skills', 'tdd', 'SKILL.md'), '# TDD');
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(externalProject, { recursive: true, force: true });
  });

  it('passes for cat-cafe project (not external)', async () => {
    const result = await checkGovernancePreflight(catCafeRoot, catCafeRoot);
    assert.equal(result.ready, true);
    assert.equal(result.reason, undefined);
  });

  it('returns needsBootstrap for unbootstrapped external project', async () => {
    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, false);
    assert.equal(result.needsBootstrap, true, 'Should signal bootstrap is needed');
    assert.ok(result.reason?.includes('not bootstrapped'));
  });

  it('returns needsConfirmation for unconfirmed project', async () => {
    const registry = new GovernanceRegistry(catCafeRoot);
    await registry.register(externalProject, {
      packVersion: GOVERNANCE_PACK_VERSION,
      checksum: 'abc',
      syncedAt: Date.now(),
      confirmedByUser: false,
    });

    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, false);
    assert.equal(result.needsConfirmation, true, 'Should signal confirmation is needed');
    assert.ok(result.reason?.includes('confirmation'));
  });

  it('passes for state-only bootstrapped project with zero files on disk', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false }); // default: state-only

    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, true, 'registry confirmation alone must be sufficient');
  });

  it('passes for full-mode project even after instruction files were hand-deleted', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false, writeMode: 'full' });
    await rm(join(externalProject, 'CLAUDE.md'));
    for (const dir of ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills']) {
      await rm(join(externalProject, dir), { recursive: true, force: true }).catch(() => {});
    }

    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, true, 'missing disk footprint must not block dispatch');
  });

  it('passes regardless of cat provider (no per-provider file requirements)', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false });

    const result = await checkGovernancePreflight(externalProject, catCafeRoot, 'kimi');
    assert.equal(result.ready, true);
  });

  it('provides actionable bootstrapCommand for new projects', async () => {
    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, false);
    assert.ok(result.bootstrapCommand, 'Should include a bootstrap command hint');
  });
});
