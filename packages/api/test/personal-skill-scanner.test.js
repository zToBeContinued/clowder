import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const { buildPersonalSkillIndex, rebuildPersonalSkillIndexFromEnv } = await import(
  '../dist/config/skills/personal-skill-scanner.js'
);

async function writeSkill(path, frontmatter, body = '# Skill Body\n') {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\n${frontmatter.trim()}\n---\n\n${body}`, 'utf-8');
}

describe('PersonalSkillScanner', () => {
  it('builds a canonical personal skill index and records duplicate mirrors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-skills-'));
    const skillsRoot = join(root, 'skills');
    try {
      await writeSkill(
        join(skillsRoot, 'create-prd'),
        `
name: create-prd
description: Create a PRD from product context
category: product
triggers:
  - PRD
  - 需求文档
`,
      );
      await writeSkill(
        join(skillsRoot, 'gstack', 'create-prd'),
        `
name: create-prd
description: Duplicate PRD mirror
`,
      );
      await writeSkill(
        join(skillsRoot, 'gstack', 'review'),
        `
name: review
description: Review work before shipping
triggers:
  - review
`,
      );
      await writeSkill(
        join(skillsRoot, 'gstack', '.agents', 'skills', 'gstack-review'),
        `
name: review
description: Hidden adapter copy
`,
      );

      const index = await buildPersonalSkillIndex({
        roots: [skillsRoot],
        visibleNames: ['create-prd'],
      });

      assert.equal(index.version, 1);
      assert.equal(index.skills.length, 2);
      assert.deepEqual(index.skills.map((skill) => skill.name).sort(), ['create-prd', 'review']);

      const createPrd = index.skills.find((skill) => skill.name === 'create-prd');
      assert.ok(createPrd);
      assert.equal(createPrd.relativePath, 'create-prd/SKILL.md');
      assert.equal(createPrd.visible, true);
      assert.equal(createPrd.category, 'product');
      assert.ok(createPrd.triggers.includes('PRD'));
      assert.match(createPrd.contentHash, /^[a-f0-9]{16}$/);

      const review = index.skills.find((skill) => skill.name === 'review');
      assert.ok(review);
      assert.equal(review.relativePath, 'gstack/review/SKILL.md');
      assert.equal(review.visible, false);

      assert.equal(index.duplicates.length, 1);
      assert.equal(index.duplicates[0].name, 'create-prd');
      assert.equal(index.duplicates[0].keptPath, 'create-prd/SKILL.md');
      assert.deepEqual(index.duplicates[0].skippedPaths, ['gstack/create-prd/SKILL.md']);
      assert.ok(index.ignoredPaths.some((path) => path.includes('gstack/.agents')));
      assert.ok(index.skills.every((skill) => !skill.sourcePath.includes('/.agents/')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('expands tilde roots and writes the index from env', async () => {
    const home = await mkdtemp(join(tmpdir(), 'personal-skills-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'personal-skills-project-'));
    try {
      await writeSkill(
        join(home, '.claude', 'skills', 'review'),
        `
name: review
description: Review work before shipping
`,
      );

      const result = await rebuildPersonalSkillIndexFromEnv(projectRoot, {
        HOME: home,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_ROOTS: '~/.claude/skills',
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'review',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: '.cat-cafe/personal-skills-index.json',
      });

      assert.equal(result.enabled, true);
      assert.equal(result.total, 1);
      assert.equal(result.visible, 1);
      assert.equal(result.duplicates, 0);
      assert.equal(result.indexPath, join(projectRoot, '.cat-cafe', 'personal-skills-index.json'));

      const raw = await readFile(result.indexPath, 'utf-8');
      const index = JSON.parse(raw);
      assert.equal(index.skills[0].name, 'review');
      assert.equal(index.skills[0].relativePath, 'review/SKILL.md');
      assert.equal(index.skills[0].visible, true);
      assert.ok(index.roots[0].endsWith('/.claude/skills'));
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks every indexed skill visible when visible-all env is enabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'personal-skills-visible-all-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'personal-skills-visible-all-project-'));
    try {
      await writeSkill(
        join(home, '.claude', 'skills', 'create-prd'),
        `
name: create-prd
description: Create a PRD
`,
      );
      await writeSkill(
        join(home, '.claude', 'skills', 'hidden-route'),
        `
name: hidden-route
description: Hidden route
`,
      );

      const result = await rebuildPersonalSkillIndexFromEnv(projectRoot, {
        HOME: home,
        CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
        CAT_CAFE_PERSONAL_SKILL_ROOTS: '~/.claude/skills',
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'create-prd',
        CAT_CAFE_PERSONAL_SKILL_VISIBLE_ALL: '1',
        CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: '.cat-cafe/personal-skills-index.json',
      });

      assert.equal(result.enabled, true);
      assert.equal(result.total, 2);
      assert.equal(result.visible, 2);

      const raw = await readFile(result.indexPath, 'utf-8');
      const index = JSON.parse(raw);
      assert.deepEqual(index.skills.map((skill) => [skill.name, skill.visible]).sort(), [
        ['create-prd', true],
        ['hidden-route', true],
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('skips skill symlinks that escape the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-skills-symlink-'));
    const skillsRoot = join(root, 'skills');
    const outsideRoot = join(root, 'outside');
    try {
      await writeSkill(
        join(outsideRoot, 'escaped'),
        `
name: escaped
description: Should not be indexed
`,
      );
      await mkdir(skillsRoot, { recursive: true });
      await symlink(join(outsideRoot, 'escaped'), join(skillsRoot, 'escaped'), 'dir');

      const index = await buildPersonalSkillIndex({
        roots: [skillsRoot],
        visibleNames: ['escaped'],
      });

      assert.equal(index.skills.length, 0);
      assert.equal(index.duplicates.length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
