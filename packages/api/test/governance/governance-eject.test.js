import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GovernanceBootstrapService } from '../../dist/config/governance/governance-bootstrap.js';
import { GovernanceEjectService, stripManagedBlocks } from '../../dist/config/governance/governance-eject.js';
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START } from '../../dist/config/governance/governance-pack.js';

describe('GovernanceEjectService', () => {
  let catCafeRoot;
  let targetProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    targetProject = await mkdtemp(join(tmpdir(), 'target-project-'));
    const skillsRoot = join(catCafeRoot, 'cat-cafe-skills');
    await mkdir(skillsRoot, { recursive: true });
    for (const name of ['tdd', 'quality-gate']) {
      await mkdir(join(skillsRoot, name));
      await writeFile(join(skillsRoot, name, 'SKILL.md'), `# ${name}`);
    }
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(targetProject, { recursive: true, force: true });
  });

  async function fullBootstrap() {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false, writeMode: 'full', skillTier: 'all' });
    return svc;
  }

  it('removes created-from-scratch instruction files entirely', async () => {
    await fullBootstrap();
    const eject = new GovernanceEjectService(catCafeRoot);
    await eject.eject(targetProject);

    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'KIMI.md']) {
      await assert.rejects(lstat(join(targetProject, f)), { code: 'ENOENT' }, `${f} should be deleted`);
    }
  });

  it('strips managed block but preserves user content', async () => {
    await writeFile(join(targetProject, 'CLAUDE.md'), '# My Project\n\nMy own rules.\n', 'utf-8');
    await fullBootstrap();

    const withBlock = await readFile(join(targetProject, 'CLAUDE.md'), 'utf-8');
    assert.ok(withBlock.includes(MANAGED_BLOCK_START));

    const eject = new GovernanceEjectService(catCafeRoot);
    await eject.eject(targetProject);

    const content = await readFile(join(targetProject, 'CLAUDE.md'), 'utf-8');
    assert.ok(content.includes('# My Project'), 'user content preserved');
    assert.ok(content.includes('My own rules.'), 'user content preserved');
    assert.ok(!content.includes(MANAGED_BLOCK_START), 'managed block removed');
    assert.ok(!content.includes('Cat Cafe'), 'no cat cafe residue');
  });

  it('removes cat-cafe skill symlinks but keeps user-owned skills', async () => {
    await fullBootstrap();

    // A user-owned REAL skill dir next to the symlinks
    const userSkill = join(targetProject, '.claude', 'skills', 'my-own-skill');
    await mkdir(userSkill, { recursive: true });
    await writeFile(join(userSkill, 'SKILL.md'), '# mine');
    // A user symlink pointing elsewhere (not cat cafe)
    const elsewhere = await mkdtemp(join(tmpdir(), 'elsewhere-'));
    await mkdir(join(elsewhere, 'foreign-skill'));
    const foreignLink = join(targetProject, '.claude', 'skills', 'foreign-skill');
    await symlink(join(elsewhere, 'foreign-skill'), foreignLink, 'junction');

    const eject = new GovernanceEjectService(catCafeRoot);
    await eject.eject(targetProject);

    // cat-cafe links gone
    await assert.rejects(lstat(join(targetProject, '.claude', 'skills', 'tdd')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(targetProject, '.codex', 'skills', 'quality-gate')), { code: 'ENOENT' });
    // user assets survive
    assert.ok((await lstat(userSkill)).isDirectory(), 'real user skill dir preserved');
    assert.ok((await lstat(foreignLink)).isSymbolicLink(), 'foreign symlink preserved');

    await rm(elsewhere, { recursive: true, force: true });
  });

  it('prunes provider dirs that end up empty', async () => {
    await fullBootstrap();
    const eject = new GovernanceEjectService(catCafeRoot);
    await eject.eject(targetProject);

    // .codex had only cat-cafe symlinks — whole dir should be pruned
    await assert.rejects(lstat(join(targetProject, '.codex')), { code: 'ENOENT' });
  });

  it('removes governance state files and registry entry', async () => {
    const svc = await fullBootstrap();
    assert.ok(await svc.getRegistry().get(targetProject), 'registered after bootstrap');

    const eject = new GovernanceEjectService(catCafeRoot);
    await eject.eject(targetProject);

    await assert.rejects(lstat(join(targetProject, '.cat-cafe', 'governance-bootstrap-report.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(lstat(join(targetProject, '.cat-cafe', 'skills-state.json')), { code: 'ENOENT' });
    assert.equal(await svc.getRegistry().get(targetProject), undefined, 'registry entry removed');
  });

  it('purgeTemplates removes untouched templates but keeps modified ones', async () => {
    await fullBootstrap();

    // Modify BACKLOG.md (user started using it)
    const backlogPath = join(targetProject, 'BACKLOG.md');
    const backlog = await readFile(backlogPath, 'utf-8');
    await writeFile(backlogPath, `${backlog}| F001 | My feature | idea | me | — |\n`, 'utf-8');

    const eject = new GovernanceEjectService(catCafeRoot);
    await eject.eject(targetProject, { purgeTemplates: true });

    // Modified template survives
    assert.ok((await lstat(backlogPath)).isFile(), 'modified BACKLOG.md preserved');
    // Untouched template removed
    await assert.rejects(lstat(join(targetProject, 'docs', 'SOP.md')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(targetProject, 'docs', 'features', 'TEMPLATE.md')), { code: 'ENOENT' });
  });

  it('default eject leaves methodology templates in place', async () => {
    await fullBootstrap();
    const eject = new GovernanceEjectService(catCafeRoot);
    await eject.eject(targetProject);

    assert.ok((await lstat(join(targetProject, 'BACKLOG.md'))).isFile());
    assert.ok((await lstat(join(targetProject, 'docs', 'SOP.md'))).isFile());
  });

  it('full bootstrap → eject(purgeTemplates) leaves an empty project tree', async () => {
    await fullBootstrap();
    const eject = new GovernanceEjectService(catCafeRoot);
    await eject.eject(targetProject, { purgeTemplates: true });

    const entries = await readdir(targetProject);
    assert.deepStrictEqual(entries, [], `project should be empty, found: ${entries.join(', ')}`);
  });

  it('dry run reports actions without touching anything', async () => {
    await fullBootstrap();
    const eject = new GovernanceEjectService(catCafeRoot);
    const report = await eject.eject(targetProject, { dryRun: true });

    assert.ok(
      report.actions.some((a) => a.action !== 'skipped'),
      'reports pending removals',
    );
    // Everything still on disk
    assert.ok((await lstat(join(targetProject, 'CLAUDE.md'))).isFile());
    assert.ok((await lstat(join(targetProject, '.claude', 'skills', 'tdd'))).isSymbolicLink());
  });

  it('is safe on a project that was never bootstrapped', async () => {
    const eject = new GovernanceEjectService(catCafeRoot);
    const report = await eject.eject(targetProject);
    assert.ok(report.actions.every((a) => a.action === 'skipped' || a.file.includes('registry')));
  });

  describe('stripManagedBlocks', () => {
    it('returns null when no block present', () => {
      assert.equal(stripManagedBlocks('# Hello\n'), null);
    });

    it('strips multiple blocks (historic append duplicates)', () => {
      const block = `${MANAGED_BLOCK_START}\nstuff\n${MANAGED_BLOCK_END}`;
      const content = `# Title\n\n${block}\n\nmiddle\n\n${block}\n`;
      const result = stripManagedBlocks(content);
      assert.ok(result.includes('# Title'));
      assert.ok(result.includes('middle'));
      assert.ok(!result.includes(MANAGED_BLOCK_START));
    });

    it('returns empty string when file is only the block', () => {
      const block = `${MANAGED_BLOCK_START}\nstuff\n${MANAGED_BLOCK_END}\n`;
      assert.equal(stripManagedBlocks(block), '');
    });
  });
});
