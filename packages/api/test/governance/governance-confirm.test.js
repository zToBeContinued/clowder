import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GovernanceBootstrapService } from '../../dist/config/governance/governance-bootstrap.js';
import { GOVERNANCE_PACK_VERSION, MANAGED_BLOCK_START } from '../../dist/config/governance/governance-pack.js';

describe('governance confirm flow', () => {
  let catCafeRoot;
  let externalProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    externalProject = await mkdtemp(join(tmpdir(), 'external-project-'));
    await mkdir(join(catCafeRoot, 'cat-cafe-skills'), { recursive: true });
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(externalProject, { recursive: true, force: true });
  });

  it('default confirm registers project without touching the project tree', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    const report = await service.bootstrap(externalProject, { dryRun: false });

    assert.ok(report.actions.length > 0);
    assert.equal(report.dryRun, false);

    // Verify registration
    const registry = service.getRegistry();
    const entry = await registry.get(externalProject);
    assert.ok(entry);
    assert.equal(entry.packVersion, GOVERNANCE_PACK_VERSION);
    assert.equal(entry.confirmedByUser, true);
    assert.equal(entry.writeMode, 'state-only');

    // No instruction files written by default
    await assert.rejects(readFile(join(externalProject, 'CLAUDE.md'), 'utf-8'), { code: 'ENOENT' });
  });

  it('confirm with writeFiles opt-in (writeMode full) writes managed blocks', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false, writeMode: 'full' });

    const claudeMd = await readFile(join(externalProject, 'CLAUDE.md'), 'utf-8');
    assert.ok(claudeMd.includes(MANAGED_BLOCK_START));
  });

  it('confirm is idempotent — second confirm does not break', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false });
    const report2 = await service.bootstrap(externalProject, { dryRun: false });

    const created = report2.actions.filter((a) => a.action === 'created');
    assert.equal(created.length, 0, 'second confirm should not create new files');
  });

  it('health shows healthy after confirm', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false });

    const registry = service.getRegistry();
    const health = await registry.checkHealth(externalProject);
    assert.equal(health.status, 'healthy');
  });
});
