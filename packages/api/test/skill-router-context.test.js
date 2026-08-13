import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PERSONAL_ENV_KEYS = [
  'CAT_CAFE_PERSONAL_SKILLS_ENABLED',
  'CAT_CAFE_PERSONAL_SKILL_ROOTS',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES',
  'CAT_CAFE_PERSONAL_SKILL_VISIBLE_ALL',
  'CAT_CAFE_PERSONAL_SKILL_INDEX_PATH',
];

async function withPersonalSkillEnv(overrides, fn) {
  const previous = new Map(PERSONAL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PERSONAL_ENV_KEYS) {
    if (Object.hasOwn(overrides, key)) process.env[key] = overrides[key];
    else delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writePersonalSkill(root, name, frontmatter, body) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter.trim()}\n---\n\n${body}`, 'utf-8');
  return join(dir, 'SKILL.md');
}

function writePersonalIndex(indexPath, skills) {
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(
    indexPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        roots: [],
        ignoredGlobs: [],
        visibleNames: skills.filter((skill) => skill.visible).map((skill) => skill.name),
        skills: skills.map((skill) => ({
          id: `personal:${skill.name}`,
          name: skill.name,
          description: skill.description ?? skill.name,
          triggers: skill.triggers ?? [],
          category: skill.category ?? 'personal',
          source: 'personal',
          sourcePath: skill.sourcePath,
          relativePath: `${skill.name}/SKILL.md`,
          visible: skill.visible ?? true,
          contentHash: `${skill.name}-hash`,
        })),
        duplicates: [],
        ignoredPaths: [],
      },
      null,
      2,
    ),
    'utf-8',
  );
}

describe('SkillRouter', () => {
  test('loads cat-cafe skill menu and matches triggers to SKILL.md', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-'));
    const skillPath = resolve(REPO_ROOT, 'cat-cafe-skills/debugging/SKILL.md');
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          skills: [
            {
              id: 'cat-cafe:debugging',
              name: 'debugging',
              description: '>',
              triggers: ['报错', '排查'],
              source: 'cat-cafe',
              risk_level: '中',
              source_path: skillPath,
              clowder_available: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const context = resolveSkillRouterContext('页面报错了，请排查根因并修复');
    assert.ok(context);
    assert.deepEqual(context.matchedSkillNames, ['debugging']);
    assert.ok(context.menuSkillCount >= 1);
    assert.match(context.promptBlock, /## Skill Router/);
    assert.match(context.promptBlock, /本轮根据用户消息命中 skill: debugging/);
    assert.match(context.promptBlock, /cat_cafe_read_skill/);
  });

  test('falls back to repo manifest for project-workflow when external manifest omits it', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-repo-manifest-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=repo-${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const context = resolveSkillRouterContext('继续推进 Clowder，先接手项目状态');
    assert.ok(context);
    assert.ok(context.matchedSkillNames.includes('project-workflow'));
    assert.match(context.promptBlock, /本轮根据用户消息命中 skill: project-workflow/);

    const progressContext = resolveSkillRouterContext('看下当前进度，再判断下一步');
    assert.ok(progressContext);
    assert.ok(progressContext.matchedSkillNames.includes('project-workflow'));

    const statusContext = resolveSkillRouterContext('项目状态现在是什么？');
    assert.ok(statusContext);
    assert.ok(statusContext.matchedSkillNames.includes('project-workflow'));
  });

  test('WI-12B routes common natural Chinese utterances before semantic fallback', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-natural-utterances-'));
    const skillDir = resolve(REPO_ROOT, 'cat-cafe-skills', `.router-content-writer-${Date.now()}`);
    const skillPath = join(skillDir, 'SKILL.md');
    const manifestPath = join(workDir, 'skills-manifest.json');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      skillPath,
      [
        '---',
        'name: content-research-writer',
        'description: Hermetic router fixture for research-backed writing.',
        '---',
        '',
        '# Content Research Writer',
      ].join('\n'),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          skills: [
            {
              id: 'cat-cafe:content-research-writer',
              name: 'content-research-writer',
              description: 'Hermetic router fixture for research-backed writing.',
              source: 'cat-cafe',
              source_path: skillPath,
              clowder_available: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    try {
      process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
      const moduleUrl = new URL(
        `../dist/domains/cats/services/context/SkillRouter.js?case=natural-${Date.now()}`,
        import.meta.url,
      );
      const { resolveSkillRouterContext } = await import(moduleUrl.href);

      const cases = [
        ['帮我发散一下思路', 'collaborative-thinking'],
        ['帮我分析需求', 'writing-plans'],
        ['帮我做个PPT', 'ppt-forge'],
        ['跑一下代码', 'tdd'],
        ['review 代码', 'request-review'],
        ['帮我写个报告', 'content-research-writer'],
      ];

      for (const [utterance, expectedSkill] of cases) {
        const context = resolveSkillRouterContext(utterance);
        assert.ok(context, `${utterance}: context should exist`);
        assert.ok(
          context.matchedSkillNames.includes(expectedSkill),
          `${utterance}: expected ${expectedSkill}, got ${context.matchedSkillNames.join(', ')}`,
        );
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
      rmSync(skillDir, { recursive: true, force: true });
    }
  });

  test('WI-12B strips CJK-adjacent spaces without collapsing pure English word boundaries', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-space-normalization-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    const skillPath = resolve(REPO_ROOT, 'cat-cafe-skills/request-review/SKILL.md');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          skills: [
            {
              id: 'cat-cafe:request-review',
              name: 'request-review',
              description: 'review',
              triggers: ['code review', 'review 代码'],
              source: 'cat-cafe',
              source_path: skillPath,
              clowder_available: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=space-${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const mixed = resolveSkillRouterContext('帮我review代码');
    assert.ok(mixed);
    assert.ok(mixed.matchedSkillNames.includes('request-review'));

    const pureEnglish = resolveSkillRouterContext('please codereview this branch');
    assert.ok(pureEnglish);
    assert.ok(!pureEnglish.matchedSkillNames.includes('request-review'));
  });

  test('loads SKILL.md entries from cat-cafe-skills/external symlinks', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-external-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    const sourceRoot = join(workDir, 'external-probe-skill');
    const externalRoot = resolve(REPO_ROOT, 'cat-cafe-skills', 'external');
    const externalName = `external-probe-${Date.now()}`;
    const linkPath = resolve(externalRoot, externalName);
    mkdirSync(sourceRoot, { recursive: true });
    mkdirSync(externalRoot, { recursive: true });
    writeFileSync(
      join(sourceRoot, 'SKILL.md'),
      `---
name: ${externalName}
description: External probe skill
triggers:
  - external-probe-trigger
---

# External Probe
`,
      'utf-8',
    );
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));

    try {
      symlinkSync(sourceRoot, linkPath, 'dir');
      process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
      const moduleUrl = new URL(
        `../dist/domains/cats/services/context/SkillRouter.js?case=external-${Date.now()}`,
        import.meta.url,
      );
      const { resolveSkillRouterContext } = await import(moduleUrl.href);

      const context = resolveSkillRouterContext('请用 external-probe-trigger 处理');
      assert.ok(context);
      assert.ok(context.matchedSkillNames.includes(externalName));
      assert.match(context.promptBlock, new RegExp(externalName));
    } finally {
      // Windows 上目录符号链接不能按文件 unlink(EISDIR),要用 rmdir 删链接本身
      // (不动目标)。此前 rmSync(force) 在 Windows 清理失败,每跑一次就往
      // cat-cafe-skills/external/ 里漏一个 external-probe-* 死链。
      try {
        unlinkSync(linkPath);
      } catch {
        try {
          rmdirSync(linkPath);
        } catch {
          /* 清理尽力而为,不影响断言结果 */
        }
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('matches project-workflow slash aliases without fast lane', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-slash-alias-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=slash-${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const continueContext = resolveSkillRouterContext('/continue-project clowder');
    assert.ok(continueContext);
    assert.ok(continueContext.matchedSkillNames.includes('project-workflow'));

    const statusContext = resolveSkillRouterContext('/project-status clowder');
    assert.ok(statusContext);
    assert.ok(statusContext.matchedSkillNames.includes('project-workflow'));
  });

  test('injects reuse gate for matched skills and exploration fallback for new work', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'skill-router-reuse-gate-'));
    const manifestPath = join(workDir, 'skills-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));

    process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
    const moduleUrl = new URL(
      `../dist/domains/cats/services/context/SkillRouter.js?case=reuse-${Date.now()}`,
      import.meta.url,
    );
    const { resolveSkillRouterContext } = await import(moduleUrl.href);

    const matched = resolveSkillRouterContext('继续推进 Clowder，先接手项目状态');
    assert.ok(matched);
    assert.match(matched.promptBlock, /优先复用已命中的 workflow\/skill/);
    assert.match(matched.promptBlock, /project-workflow/);

    const exploratory = resolveSkillRouterContext('实现一个从未沉淀过的水晶球排班玩法');
    assert.ok(exploratory);
    assert.deepEqual(exploratory.matchedSkillNames, []);
    assert.match(exploratory.promptBlock, /未命中明确 skill/);
    assert.match(exploratory.promptBlock, /探索模式/);
    assert.match(exploratory.promptBlock, /重复、高频、步骤稳定、异常可枚举/);
  });

  test('routes visible personal skills by intent without injecting personal SKILL.md content', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'skill-router-personal-project-'));
    const personalRoot = mkdtempSync(join(tmpdir(), 'skill-router-personal-root-'));
    const manifestPath = join(projectRoot, 'skills-manifest.json');
    const indexPath = join(projectRoot, '.cat-cafe', 'personal-skills-index.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
    const createPrdPath = writePersonalSkill(
      personalRoot,
      'personal-create-prd-test',
      `
name: personal-create-prd-test
description: Create a PRD from product context
triggers:
  - PRD
`,
      'SECRET FULL PERSONAL BODY SHOULD NEVER ENTER ROUTER PROMPT',
    );
    const hiddenPath = writePersonalSkill(
      personalRoot,
      'hidden-route',
      `
name: hidden-route
description: Hidden personal route
triggers:
  - hidden-intent-token
`,
      'HIDDEN FULL PERSONAL BODY SHOULD NEVER ENTER ROUTER PROMPT',
    );
    writePersonalIndex(indexPath, [
      {
        name: 'personal-create-prd-test',
        description: 'Create a PRD from product context',
        triggers: ['PRD'],
        sourcePath: createPrdPath,
        visible: true,
      },
      {
        name: 'hidden-route',
        description: 'Hidden personal route',
        triggers: ['hidden-intent-token'],
        sourcePath: hiddenPath,
        visible: false,
      },
    ]);

    try {
      await withPersonalSkillEnv(
        {
          CAT_CAFE_PERSONAL_SKILLS_ENABLED: '1',
          CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
          CAT_CAFE_PERSONAL_SKILL_VISIBLE_NAMES: 'personal-create-prd-test',
          CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        },
        async () => {
          process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
          const moduleUrl = new URL(
            `../dist/domains/cats/services/context/SkillRouter.js?case=personal-${Date.now()}`,
            import.meta.url,
          );
          const { resolveSkillRouterContext } = await import(moduleUrl.href);

          const visible = resolveSkillRouterContext('帮我写一份 PRD');
          assert.ok(visible);
          assert.deepEqual(visible.matchedSkillNames, ['personal-create-prd-test']);
          assert.match(visible.promptBlock, /personal-create-prd-test/);
          assert.doesNotMatch(visible.promptBlock, /SECRET FULL PERSONAL BODY/);
          assert.doesNotMatch(visible.promptBlock, /HIDDEN FULL PERSONAL BODY/);

          const hiddenFuzzy = resolveSkillRouterContext('hidden-intent-token');
          assert.ok(hiddenFuzzy);
          assert.deepEqual(hiddenFuzzy.matchedSkillNames, []);

          const hiddenExplicit = resolveSkillRouterContext('/hidden-route');
          assert.ok(hiddenExplicit);
          assert.deepEqual(hiddenExplicit.matchedSkillNames, ['hidden-route']);
          assert.doesNotMatch(hiddenExplicit.promptBlock, /HIDDEN FULL PERSONAL BODY/);
        },
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(personalRoot, { recursive: true, force: true });
    }
  });

  test('keeps personal skill routing disabled by default', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'skill-router-personal-disabled-'));
    const personalRoot = mkdtempSync(join(tmpdir(), 'skill-router-personal-disabled-root-'));
    const manifestPath = join(projectRoot, 'skills-manifest.json');
    const indexPath = join(projectRoot, '.cat-cafe', 'personal-skills-index.json');
    writeFileSync(manifestPath, JSON.stringify({ skills: [] }, null, 2));
    const createPrdPath = writePersonalSkill(
      personalRoot,
      'create-prd',
      'name: create-prd\ntriggers:\n  - PRD',
      'disabled body',
    );
    writePersonalIndex(indexPath, [
      { name: 'create-prd', description: 'Create PRD', triggers: ['PRD'], sourcePath: createPrdPath, visible: true },
    ]);

    try {
      await withPersonalSkillEnv(
        {
          CAT_CAFE_PERSONAL_SKILL_ROOTS: personalRoot,
          CAT_CAFE_PERSONAL_SKILL_INDEX_PATH: indexPath,
        },
        async () => {
          process.env.CAT_CAFE_SKILL_MANIFEST_PATH = manifestPath;
          const moduleUrl = new URL(
            `../dist/domains/cats/services/context/SkillRouter.js?case=personal-disabled-${Date.now()}`,
            import.meta.url,
          );
          const { resolveSkillRouterContext } = await import(moduleUrl.href);
          const context = resolveSkillRouterContext('帮我写 PRD');
          assert.ok(context);
          assert.deepEqual(context.matchedSkillNames, []);
        },
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(personalRoot, { recursive: true, force: true });
    }
  });
});
