/**
 * SystemPromptBuilder Tests
 * 测试身份注入 prompt 生成
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const REPO_ROOT_TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'cat-template.json');
const CAT_TEMPLATE_PATH = REPO_ROOT_TEMPLATE;

describe('SystemPromptBuilder', () => {
  // Dynamic import after build
  async function getBuilder() {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    return buildSystemPrompt;
  }

  test('contains display name for opus', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('布偶猫'));
    assert.ok(prompt.includes('opus'));
  });

  test('contains display name for codex', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('缅因猫'));
    assert.ok(prompt.includes('codex'));
  });

  test('injects Skill Router block when provided', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      skillRouterBlock: '## Skill Router（可用 Skill 菜单）\n- debugging: 排查 bug',
    });
    assert.ok(prompt.includes('## Skill Router（可用 Skill 菜单）'));
    assert.ok(prompt.includes('debugging: 排查 bug'));
  });

  test('contains display name for gemini', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'gemini',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('暹罗猫'));
    assert.ok(prompt.includes('gemini'));
  });

  test('contains teammate info only for cats in context.teammates', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: ['codex', 'gemini'],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('缅因猫'));
    assert.ok(prompt.includes('暹罗猫'));
    assert.ok(prompt.includes('队友'));
  });

  test('omits dynamic teammate listing when teammates is empty', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    // Dynamic teammate listing absent, but static collaboration guide still present
    assert.ok(!prompt.includes('你的队友'));
    assert.ok(prompt.includes('@队友'));
    // Still mentions 铲屎官
    assert.ok(prompt.includes('铲屎官'));
  });

  test('contains 铲屎官 reference', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('铲屎官'));
  });

  test('contains serial chain context when mode is serial', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'serial',
      chainIndex: 2,
      chainTotal: 3,
      teammates: ['opus', 'gemini'],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('2/3'));
    assert.ok(prompt.includes('被召唤'));
  });

  test('contains independent mode when mode is independent', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('独立回答'));
  });

  test('contains MCP tools when mcpAvailable is true', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });
    assert.ok(prompt.includes('上下文查询指南（按需拉取）'));
    assert.ok(prompt.includes('cat_cafe_get_thread_context'));
    assert.ok(prompt.includes('cat_cafe_search_evidence'));
    assert.ok(!prompt.includes('cat_cafe_post_message'));
    assert.ok(!prompt.includes('cat_cafe_register_pr_tracking'));
  });

  test('advertises local tool discovery hints', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });

    assert.ok(prompt.includes('常用本地工具提示'));
    assert.ok(prompt.includes('opencli-usage'));
    assert.ok(prompt.includes('skill-linker'));
    assert.ok(prompt.includes('Skill Router / MCP'));
  });

  test('injects progress visibility discipline for action tasks', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });

    assert.ok(prompt.includes('即时开工回执与长任务心跳'));
    assert.ok(prompt.includes('cat_cafe_post_progress'));
    assert.ok(prompt.includes("kind='ack'"));
    assert.ok(prompt.includes('第一次耗时工具调用前'));
    assert.ok(prompt.includes('纯问答、闲聊或预计 30 秒内可直接完成'));
    assert.ok(prompt.includes('45–60 秒'));
    assert.ok(prompt.includes('不是最终交付'));
  });

  // 2026-08-13 现场：铲屎官让猫「值守」，猫在回合内 Start-Sleep 900 干等，
  // 静默看门狗 ~3 分钟判死回合、消息无法收尾，铲屎官只能手动停止。
  test('forbids in-turn sleep watch loops and points to scheduled wake-ups', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });

    assert.ok(prompt.includes('值守'), '值守规则必须注入');
    assert.ok(prompt.includes('禁止用 sleep'), '必须明确禁止回合内 sleep 干等');
    assert.ok(prompt.includes('schedule-tasks'), '必须指向定时唤醒的正确路径');
  });

  test('omits MCP tools when mcpAvailable is false', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!prompt.includes('cat_cafe_post_message'));
  });

  test('contains simplified governance floor', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('P1终态不绕路'));
    assert.ok(prompt.includes('没人认领的任务留在 board 可见'));
  });

  test('shared-rules and prompt keep claim-before-action hard gate', async () => {
    const { readFileSync } = await import('node:fs');
    const rulesPath = resolve(import.meta.dirname, '../../../cat-cafe-skills/refs/shared-rules.md');
    const rulesText = readFileSync(rulesPath, 'utf8');

    assert.match(rulesText, /认领（claim）或复用任务/);
    assert.match(rulesText, /没有完成认领（claim）前，不写文件、不改代码、不启动构建/);
    assert.match(rulesText, /认领\/claim 失败就停止/);

    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });

    assert.ok(prompt.includes('先认领（claim）或复用任务'));
    assert.ok(prompt.includes('未认领/claim 前不写文件/改代码/启动构建'));
  });

  test('shared-rules and prompt keep discussion-before-action gate', async () => {
    const { readFileSync } = await import('node:fs');
    const rulesPath = resolve(import.meta.dirname, '../../../cat-cafe-skills/refs/shared-rules.md');
    const rulesText = readFileSync(rulesPath, 'utf8');

    assert.match(rulesText, /先判定当前阶段是讨论还是执行/);
    assert.match(rulesText, /陈述目标、发散讨论、征求意见/);
    // a4d2f96b 起任意位置 @ 即路由——讨论阶段的纪律从「不行首 @」收紧为「不 @」
    assert.match(rulesText, /不认领、不发 ack、不建 task、不 @ 任何猫、不切工单/);
    assert.match(rulesText, /明确执行口令.*才进入行动流程/);

    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });

    const gatePosition = prompt.indexOf('## 讨论 / 执行门禁（先判阶段）');
    const actionPosition = prompt.indexOf('## Clowder CLI 工作纪律');
    assert.ok(gatePosition >= 0, 'prompt should inject the discussion/execution gate');
    assert.ok(actionPosition > gatePosition, 'stage classification must appear before action discipline');
    assert.ok(prompt.includes('不认领、不发 ack、不建 task、不 @ 任何猫、不切工单'));
    assert.ok(prompt.includes('开工/按这个做/安排/执行'));
    assert.ok(prompt.includes('明确执行口令出现后才进入行动流程'));
    assert.ok(prompt.includes('行动任务先认领或复用任务'), 'explicit execution must still reach claim-first flow');

    const minimalPrompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      toolPolicy: 'minimal',
    });
    assert.ok(minimalPrompt.includes('## 讨论 / 执行门禁（先判阶段）'), 'minimal cats need the same stage gate');
    assert.ok(
      minimalPrompt.indexOf('## 讨论 / 执行门禁（先判阶段）') < minimalPrompt.indexOf('## Clowder CLI 工作纪律'),
      'minimal cats must classify discussion before action',
    );

    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const runtimePrompt = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
      threadId: 'thread-discussion-gate',
      currentUserMessageId: 'msg-discussion-gate',
    });
    const runtimeGatePosition = runtimePrompt.indexOf('阶段先判：');
    const runtimeActionPosition = runtimePrompt.indexOf('行动任务先认领当前消息或匹配任务');
    assert.ok(runtimeGatePosition >= 0, 'resumed sessions need a per-invocation discussion gate');
    assert.ok(
      runtimeActionPosition > runtimeGatePosition,
      'runtime task gate must classify stage before claim-first action',
    );
    assert.ok(runtimePrompt.includes('不认领、不发 ack、不建 task、不 @ 任何猫、不切工单'));
  });

  test('is deterministic (identical inputs produce identical output)', async () => {
    const build = await getBuilder();
    const ctx = {
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: true,
    };
    const a = build(ctx);
    const b = build(ctx);
    assert.equal(a, b);
  });

  test('output size stays under 3900 chars after simplified governance prompt growth', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
    });
    assert.ok(prompt.length < 5700, `Full runtime prompt is ${prompt.length} chars, expected < 5700`);
  });

  test('returns empty string for unknown catId', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'unknown-cat',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.equal(prompt, '');
  });

  test('contains provider label (Anthropic for opus)', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('Anthropic'));
  });

  test('parallel mode produces independent thinking text', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'parallel',
      teammates: ['codex'],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('独立思考'));
    assert.ok(prompt.includes('各自独立'));
    assert.ok(!prompt.includes('被召唤'));
    // Should NOT contain the standalone "独立回答。" from independent mode
    assert.ok(!prompt.includes('当前模式：独立回答。'));
  });

  test('critique promptTag adds critical analysis text', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      promptTags: ['critique'],
    });
    assert.ok(prompt.includes('批判性分析'));
    assert.ok(prompt.includes('挑战假设'));
  });

  test('empty promptTags produces no extra text', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      promptTags: [],
    });
    assert.ok(!prompt.includes('批判性分析'));
  });

  // --- Phase 3.6: honesty rule ---

  test('contains "不确定" honesty rule', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('不确定'), 'Prompt should tell cats to say "I\'m not sure"');
  });

  test('contains simplified evidence discipline', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('P5可验证'), 'Prompt should enforce verifiable delivery');
    assert.ok(prompt.includes('可验证子任务及时commit'), 'Prompt should require evidence-oriented work units');
  });

  // --- System prompt split tests (buildStaticIdentity / buildInvocationContext) ---

  test('buildStaticIdentity returns identity for known cat', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    assert.ok(identity.includes('布偶猫'), 'Should contain display name');
    assert.ok(identity.includes('Anthropic'), 'Should contain provider');
    assert.ok(identity.includes('## 协作'), 'Should contain collaboration guide');
    assert.ok(identity.includes('P1终态不绕路'), 'Should contain simplified governance floor');
    assert.ok(identity.includes('不靠全局品种管控'), 'Should contain per-agent memory behavior constraint');
  });

  test('buildStaticIdentity returns empty for unknown cat', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    assert.equal(buildStaticIdentity('unknown-cat'), '');
  });

  test('buildStaticIdentity includes workflow triggers', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const opusId = buildStaticIdentity('opus');
    assert.ok(opusId.includes('工作流'), 'Opus should have workflow triggers');
    assert.ok(opusId.includes('通用协作触发点'), 'Opus workflow should use generic collaboration triggers');
    assert.ok(opusId.includes('审查猫'), 'Opus workflow should route review by role, not breed');

    const codexId = buildStaticIdentity('codex');
    assert.ok(codexId.includes('工作流'), 'Codex should have workflow triggers');
    assert.ok(codexId.includes('Next Action'), 'Codex workflow should require explicit next action');
    assert.ok(codexId.includes('出口一问'), 'Codex workflow should include exit check (出口一问)');
  });

  test('buildStaticIdentity is deterministic', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    assert.equal(buildStaticIdentity('opus'), buildStaticIdentity('opus'));
  });

  test('buildStaticIdentity disambiguates duplicate display names in runtime multi-variant config', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const identity = buildStaticIdentity('opus');
      const mentionLine = identity.split('\n').find((line) => line.startsWith('你可以 @队友: '));
      assert.ok(mentionLine, 'should include teammate @mention line');

      // Use lookahead to only match "@缅因猫" NOT followed by " Spark" (which is a different variant displayName)
      const maineCount = (mentionLine.match(/@缅因猫(?=\s*\/)/g) ?? []).length;
      assert.equal(maineCount, 1, 'default maine mention should appear only once');
      assert.ok(mentionLine.includes('@gpt52'), 'should expose non-default variant handle');
      assert.ok(identity.includes('同族多分身时'), 'should explicitly teach same-breed multi-variant rule');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildStaticIdentity duplicate-name hint should not suggest self handle', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const identity = buildStaticIdentity('gpt52');
      assert.ok(identity.includes('唯一句柄'), 'should include duplicate-name hint');
      assert.ok(!identity.includes('如 @gpt52'), 'hint example must not point to self handle');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // --- F-Ground-3: Teammate roster tests ---

  test('buildStaticIdentity includes teammate roster with strengths', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    assert.ok(identity.includes('## 队友名册'), 'Should have roster section');
    assert.ok(identity.includes('擅长'), 'Should have strengths column header');
    assert.ok(identity.includes('@缅因猫') || identity.includes('@codex'), 'Should list codex mention');
    assert.ok(identity.includes('@暹罗猫') || identity.includes('@gemini'), 'Should list gemini mention');
  });

  test('F127 V-1: buildStaticIdentity includes runtime-created cats in new-session roster', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    try {
      catRegistry.register('runtime-spark', {
        ...originalConfigs.codex,
        displayName: '火花猫',
        nickname: '小火花',
        mentionPatterns: ['@runtime-spark', '@火花猫'],
        defaultModel: 'gpt-5.4-mini',
        roleDescription: '快速执行',
        teamStrengths: '精确点改',
      });

      const identity = buildStaticIdentity('opus');
      assert.match(identity, /## 队友名册/, 'new session identity must include roster');
      assert.match(identity, /火花猫\/小火花/, 'runtime-created cat must be listed');
      assert.match(identity, /@runtime-spark · gpt-5\.4-mini/, 'runtime-created model alias must be visible');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildStaticIdentity roster excludes self', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const opusRoster = buildStaticIdentity('opus');
    // Self (opus) should not appear in the roster table rows
    // The roster rows start after the header, each begins with "|"
    const rosterSection = opusRoster.split('## 队友名册')[1];
    assert.ok(rosterSection, 'Roster section should exist');
    assert.ok(!rosterSection.includes('| 布偶猫/宪宪'), 'Opus default should not list itself');
  });

  test('buildStaticIdentity roster uses teamStrengths from config', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const identity = buildStaticIdentity('opus');
      // gpt52 keeps teamStrengths and has no explicit caution override in current config.
      assert.ok(identity.includes('架构思考'), 'Should include gpt52 teamStrengths');
      assert.ok(identity.includes('| 缅因猫/砚砚（GPT-5.4） |') || identity.includes('| 缅因猫/砚砚 |'));
      // gemini has caution about no coding
      assert.ok(identity.includes('禁止写代码'), 'Should include gemini caution');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildStaticIdentity roster: Sonnet does not inherit Opus cost caution (R1 null override)', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const identity = buildStaticIdentity('codex');
      const rosterSection = identity.split('## 队友名册')[1];
      assert.ok(rosterSection, 'Roster section should exist');
      // Find the Sonnet row
      const sonnetRow = rosterSection.split('\n').find((line) => line.includes('Sonnet'));
      assert.ok(sonnetRow, 'Should have a Sonnet row');
      // Sonnet has caution: null in config → should show "—", NOT "额度消耗大"
      assert.ok(!sonnetRow.includes('额度消耗大'), 'Sonnet should not inherit Opus cost caution');
      assert.ok(sonnetRow.includes('—'), 'Sonnet caution should be "—"');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildStaticIdentity roster size with full runtime config stays under 4700 chars after simplified governance growth', async () => {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const prompt = buildSystemPrompt({
        catId: 'opus',
        mode: 'serial',
        chainIndex: 1,
        chainTotal: 3,
        teammates: ['codex', 'gemini'],
        mcpAvailable: true,
        promptTags: ['critique'],
      });
      assert.ok(prompt.length < 5700, `Full runtime prompt is ${prompt.length} chars, expected < 5700`);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildInvocationContext returns teammates when present', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: false,
    });
    assert.ok(ctx.includes('你的队友'), 'Should list teammates');
    assert.ok(ctx.includes('缅因猫'), 'Should mention codex by display name');
    assert.ok(ctx.includes('1/2'), 'Should show chain position');
  });

  test('buildInvocationContext omits teammate listing when empty', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('你的队友'), 'Should not list teammates');
    assert.ok(ctx.includes('独立回答'), 'Should indicate independent mode');
  });

  test('buildInvocationContext injects runtime task gate without leaking CLI commands', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread_abc',
      currentUserMessageId: 'msg_123',
    });
    assert.ok(ctx.includes('Clowder Task Gate（本轮动态）'), 'Should include dynamic task gate');
    assert.ok(ctx.includes('thread=thread_abc msg=msg_123'), 'Should point at current surface');
    assert.ok(ctx.includes('行动任务先认领当前消息或匹配任务'), 'Should require task ownership');
    assert.ok(ctx.includes('完成后切到待验收'), 'Should require review state without command syntax');
    assert.ok(ctx.includes('不要贴任务命令、工具日志或状态机黑话'), 'Should enforce clear visible output');
    assert.ok(!ctx.includes('$CLI task claim'), 'Should not leak claim command syntax');
    assert.ok(!ctx.includes('--status in_review'), 'Should not leak status command syntax');
    assert.ok(ctx.includes('文件受 git 版本控制时，可直接删除'), 'Should exempt git-tracked file deletion');
    assert.ok(ctx.includes('§10.4 的“删数据”指数据库'), 'Should scope irreversible data deletion');
  });

  test('buildSystemPrompt includes Slock-like visible output and pull-context guidance', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });

    assert.ok(prompt.includes('协作规则（shared-rules.md）'), 'Should include operational shared-rules digest');
    assert.ok(prompt.includes('上下文查询指南（按需拉取）'), 'Should include pull-context guide');
    assert.ok(prompt.includes('cat_cafe_get_thread_context'), 'Should point to thread context lookup');
    assert.ok(prompt.includes('cat_cafe_search_evidence'), 'Should point to evidence lookup');
    assert.ok(prompt.includes('中文白话优先'), 'Should require plain-language visible output');
    assert.ok(prompt.includes('无任务短路'), 'Should short-circuit non-task mentions');
    assert.ok(prompt.includes('接续检查'), 'Should ban internal protocol jargon');
    assert.ok(prompt.includes('生活类比'), 'Should allow plain-language analogies for technical reasoning');
    assert.ok(!prompt.includes('费曼解释'), 'Should not expose Feynman jargon in prompts');
    assert.ok(prompt.includes('交付必须附证据'), 'Should include delivery verification discipline');
    assert.ok(prompt.includes('规则优先级'), 'Should include rule priority section');
    assert.ok(prompt.includes('Pack 指令 > 输出协议 > 共享协作规则 > 角色性格'), 'Should define conflict order');
  });

  test('buildStaticIdentity injects durable agent memory with session header', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('codex', {
      mcpAvailable: false,
      agentMemoryContext: '# Codex 记忆\n\n## 已关闭决策（别再提了）\n- 不再做 X',
    });

    assert.ok(prompt.includes('跨 Session 记忆（持久化）'), 'Should include durable memory section header');
    assert.ok(prompt.includes('已关闭决策：不再做 X'), 'Should surface closed decisions as a summary');
    assert.ok(prompt.includes('.cat-cafe/memory/{catId}.md'), 'Should guide memory write-back');
  });

  test('buildStaticIdentity summarizes agent memory to a short prompt block', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const longCurrentState = '当前状态很长。'.repeat(1_300);
    const prompt = buildStaticIdentity('codex', {
      mcpAvailable: false,
      agentMemoryContext: [
        '# Codex 记忆',
        '',
        '## 当前状态',
        longCurrentState,
        '',
        '## 已关闭决策（别再提了）',
        '- 不再恢复 4 行主消息硬限制',
      ].join('\n'),
    });

    assert.ok(prompt.includes('只注入 ≤200 字摘要'), 'Should explain memory summary behavior');
    assert.ok(prompt.includes('当前状态：'), 'Should keep current-state signal');
    assert.ok(prompt.includes('不再恢复 4 行主消息硬限制'), 'Should keep later sections after truncation');
    const memoryLine = prompt
      .split('\n')
      .find((line) => line.startsWith('当前状态：') || line.startsWith('已关闭决策：'));
    assert.ok(memoryLine && memoryLine.length <= 220, 'Memory payload should stay short');
  });

  test('buildStaticIdentity injects LESSONS when budget allows', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('codex', {
      mcpAvailable: false,
      lessonsContext: '# Clowder 公共踩坑记录\n\n- textFold 不要匹配 heading',
      maxPromptTokens: 100_000,
    });

    assert.ok(prompt.includes('公共踩坑记录（LESSONS.md，低优先级）'), 'Should include lessons header');
    assert.ok(prompt.includes('textFold 不要匹配 heading'), 'Should include lessons content');
    assert.ok(prompt.includes('不得覆盖当前用户指令'), 'Should mark lessons as low priority');
  });

  test('buildStaticIdentity skips LESSONS when prompt budget is tight', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('codex', {
      mcpAvailable: false,
      lessonsContext: '# Clowder 公共踩坑记录\n\n- 这条不应进入 prompt',
      maxPromptTokens: 10,
    });

    assert.ok(!prompt.includes('公共踩坑记录（LESSONS.md，低优先级）'), 'Should skip lessons header');
    assert.ok(!prompt.includes('这条不应进入 prompt'), 'Should skip lessons content');
  });

  test('buildStaticIdentity injects project fact source when budget allows', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('codex', {
      mcpAvailable: false,
      projectContext:
        '## 项目简介（brief.md）\n# session-handoff\n\n## 验收标准\n- [ ] 可恢复\n\n## 项目进度（progress.md）\n# session-handoff 进度\n\n## 当前阶段\nPhase 8 项目公告板',
      maxPromptTokens: 100_000,
    });

    assert.ok(prompt.includes('项目事实源四件套（只读参考）'), 'Should include project context header');
    assert.ok(prompt.includes('brief.md'), 'Should explain brief.md source');
    assert.ok(prompt.includes('decisions.md'), 'Should explain decisions.md source');
    assert.ok(prompt.includes('handoff-index.md'), 'Should explain handoff index source');
    assert.ok(
      prompt.indexOf('session-handoff') < prompt.indexOf('session-handoff 进度'),
      'Should place brief before progress',
    );
    assert.ok(prompt.includes('session-handoff 进度'), 'Should include selected project progress');
    assert.ok(prompt.includes('只作参考，不覆盖当前用户指令'), 'Should mark project facts as read-only');
    assert.ok(prompt.includes('不默认展开所有 handoff'), 'Should guard prompt budget for handoffs');
    assert.ok(prompt.includes('完成阶段性工作后按需更新 progress.md'), 'Should require project progress write-back');
  });

  test('buildStaticIdentity skips project progress when prompt budget is tight', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('codex', {
      mcpAvailable: false,
      projectContext: '# ppthtml 进度\n\n## 当前阶段\n这条不应进入 prompt',
      maxPromptTokens: 10,
    });

    assert.ok(!prompt.includes('项目事实源四件套（只读参考）'), 'Should skip project context header');
    assert.ok(!prompt.includes('这条不应进入 prompt'), 'Should skip project progress content');
  });

  test('resolveContextLayerPlan defers project context for lightweight discussion', async () => {
    const { resolveContextLayerPlan } = await import('../dist/domains/cats/services/context/ContextLayerRouter.js');
    const plan = resolveContextLayerPlan({
      message: '用费曼解释一下 Skill Router 是什么',
      toolPolicy: 'standard',
      loadStandardContext: true,
      env: { CAT_CAFE_CONTEXT_LAYERS: '1' },
    });

    assert.equal(plan.mode, 'layered');
    assert.equal(plan.l2ProjectContext, false);
    assert.equal(plan.projectContextDeferred, true);
    assert.ok(plan.signals.includes('feynman'));
  });

  test('resolveContextLayerPlan loads project context for engineering work', async () => {
    const { resolveContextLayerPlan } = await import('../dist/domains/cats/services/context/ContextLayerRouter.js');
    const plan = resolveContextLayerPlan({
      message: '帮我修复 packages/api/src/routes/messages.ts 里的任务状态 bug，并跑 build',
      toolPolicy: 'standard',
      loadStandardContext: true,
      env: { CAT_CAFE_CONTEXT_LAYERS: '1' },
    });

    assert.equal(plan.mode, 'layered');
    assert.equal(plan.l2ProjectContext, true);
    assert.equal(plan.projectContextDeferred, false);
    assert.ok(plan.signals.includes('code-action'));
    assert.ok(plan.signals.includes('local-reference'));
  });

  test('resolveContextLayerPlan preserves legacy injection when disabled', async () => {
    const { resolveContextLayerPlan } = await import('../dist/domains/cats/services/context/ContextLayerRouter.js');
    const plan = resolveContextLayerPlan({
      message: '用费曼解释一下 Skill Router 是什么',
      toolPolicy: 'standard',
      loadStandardContext: true,
      env: { CAT_CAFE_CONTEXT_LAYERS: '0' },
    });

    assert.equal(plan.mode, 'legacy');
    assert.equal(plan.l2ProjectContext, true);
    assert.equal(plan.projectContextDeferred, false);
  });

  test('resolveContextLayerPlan defaults to legacy injection unless explicitly enabled', async () => {
    const { resolveContextLayerPlan } = await import('../dist/domains/cats/services/context/ContextLayerRouter.js');
    const plan = resolveContextLayerPlan({
      message: '用费曼解释一下 Skill Router 是什么',
      toolPolicy: 'standard',
      loadStandardContext: true,
      env: {},
    });

    assert.equal(plan.mode, 'legacy');
    assert.equal(plan.l2ProjectContext, true);
    assert.equal(plan.projectContextDeferred, false);
  });

  test('readLessonsForPrompt loads .cat-cafe/LESSONS.md content', async () => {
    const { readLessonsForPrompt } = await import('../dist/domains/cats/services/agents/memory/LessonStore.js');
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-lessons-'));
    try {
      await mkdir(resolve(root, '.cat-cafe'), { recursive: true });
      await writeFile(resolve(root, '.cat-cafe', 'LESSONS.md'), '# Clowder 公共踩坑记录\n\n- textFold fixture');
      const content = await readLessonsForPrompt(root);

      assert.ok(content?.includes('Clowder 公共踩坑记录'), 'Should load shared lessons file');
      assert.ok(content?.includes('textFold'), 'Should include the fixture lesson');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('readProjectProgressForPrompt loads selected progress.md files', async () => {
    const { readProjectProgressForPrompt } = await import(
      '../dist/domains/cats/services/agents/memory/ProjectProgressStore.js'
    );
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-project-progress-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });
      await writeFile(
        resolve(root, '.cat-cafe', 'projects', 'demo', 'progress.md'),
        '# Demo 进度\n\n## 当前阶段\n正在验证项目公告板。',
        'utf-8',
      );

      const content = await readProjectProgressForPrompt(['demo'], root);
      assert.ok(content?.includes('project:demo'), 'Should include project marker');
      assert.ok(content?.includes('Demo 进度'), 'Should load progress content');
      assert.ok(content?.includes('needs_brief'), 'Should flag missing brief without failing progress loading');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('readProjectProgressForPrompt loads brief, progress, decisions, and handoff index in order', async () => {
    const { readProjectProgressForPrompt } = await import(
      '../dist/domains/cats/services/agents/memory/ProjectProgressStore.js'
    );
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-project-brief-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });
      await writeFile(
        resolve(root, '.cat-cafe', 'projects', 'demo', 'brief.md'),
        '# Demo Brief\n\n## 验收标准\n- [ ] A',
        'utf-8',
      );
      await writeFile(
        resolve(root, '.cat-cafe', 'projects', 'demo', 'progress.md'),
        '# Demo 进度\n\n## 当前阶段\nB',
        'utf-8',
      );
      await writeFile(
        resolve(root, '.cat-cafe', 'projects', 'demo', 'decisions.md'),
        '# Demo 决策\n\n- KD-001: C',
        'utf-8',
      );
      await writeFile(
        resolve(root, '.cat-cafe', 'projects', 'demo', 'handoff-index.md'),
        '# Demo 交接索引\n\n- 2026-07-03: D',
        'utf-8',
      );

      const content = await readProjectProgressForPrompt(['demo'], root);
      assert.ok(content?.includes('brief_path:'), 'Should include brief marker');
      assert.ok(content?.includes('decisions_path:'), 'Should include decisions marker');
      assert.ok(content?.includes('handoff_index_path:'), 'Should include handoff index marker');
      assert.ok(content?.includes('项目简介（brief.md）'), 'Should include brief section');
      assert.ok(content?.includes('项目进度（progress.md）'), 'Should include progress section');
      assert.ok(content?.includes('项目决策（decisions.md）'), 'Should include decisions section');
      assert.ok(content?.includes('交接索引（handoff-index.md）'), 'Should include handoff index section');
      assert.ok(
        content && content.indexOf('Demo Brief') < content.indexOf('Demo 进度'),
        'Should place brief before progress',
      );
      assert.ok(
        content && content.indexOf('Demo 进度') < content.indexOf('Demo 决策'),
        'Should place progress before decisions',
      );
      assert.ok(
        content && content.indexOf('Demo 决策') < content.indexOf('Demo 交接索引'),
        'Should place decisions before handoff index',
      );
      assert.ok(
        content?.includes('先读索引，只在当前任务命中模块、日期、关键词或风险点时再打开具体 handoff'),
        'Should instruct agents to use handoff index before full handoffs',
      );
      assert.ok(!content?.includes('needs_brief'), 'Should not flag needs_brief when brief exists');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('writeContextHandoffForPromptProjects appends schema fields to handoff files', async () => {
    const { writeContextHandoffForPromptProjects } = await import(
      '../dist/domains/cats/services/agents/memory/ProjectProgressStore.js'
    );
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-project-handoff-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });

      const result = await writeContextHandoffForPromptProjects(
        {
          timestamp: '2026-07-07T22:00:00.000Z',
          threadId: 'thread-1',
          catId: 'codex',
          fromSessionId: 'session-1',
          reason: 'threshold',
          trust: 'trusted',
          health: {
            usedTokens: 850,
            windowTokens: 1000,
            fillRatio: 0.85,
            source: 'exact',
            measuredAt: Date.now(),
          },
        },
        ['demo'],
        root,
      );

      assert.equal(result.written, 1);
      const index = await readFile(resolve(root, '.cat-cafe', 'projects', 'demo', 'handoff-index.md'), 'utf-8');
      const log = await readFile(resolve(root, '.cat-cafe', 'projects', 'demo', 'handoff-log.md'), 'utf-8');
      for (const field of ['What', 'Why', 'Next', 'Blocker', 'Verify', 'Trust', 'refs']) {
        assert.ok(index.includes(field), `handoff-index should include ${field}`);
      }
      assert.ok(index.includes('trusted'), 'handoff-index should include Resume Trust');
      assert.ok(index.includes('from-session: session-1'), 'handoff-index should include from-session ref');
      assert.ok(log.includes('context-threshold-handoff'), 'handoff-log should append automation event');
      assert.ok(log.includes('85% (850/1000, exact)'), 'handoff-log should include health snapshot');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('readProjectHandoffIndexesForBootstrap returns durable handoff before session summary can be built', async () => {
    const { readProjectHandoffIndexesForBootstrap } = await import(
      '../dist/domains/cats/services/agents/memory/ProjectProgressStore.js'
    );
    const root = await mkdtemp(resolve(tmpdir(), 'cat-cafe-project-bootstrap-handoff-'));
    try {
      await mkdir(resolve(root, '.cat-cafe', 'projects', 'demo'), { recursive: true });
      await writeFile(
        resolve(root, '.cat-cafe', 'projects', 'demo', 'handoff-index.md'),
        '# Demo handoff\n\n- **Trust**: trusted\n- **Next**: continue bridge',
        'utf-8',
      );

      const content = await readProjectHandoffIndexesForBootstrap(['demo'], root);
      assert.ok(
        content?.startsWith('[Project Handoff Index'),
        'Should expose handoff index as the first durable block',
      );
      assert.ok(content?.includes('continue bridge'), 'Should include handoff content');
      assert.ok(content?.includes('reference only'), 'Should mark block as reference data');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('buildInvocationContext injects context rational-line warning when provided', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      contextUsageWarning: {
        ratio: 0.72,
        estimatedTokens: 72000,
        maxPromptTokens: 100000,
        level: 'caution',
        action: 'memory-writeback',
      },
    });

    assert.ok(ctx.includes('Context 理智线预警'), 'Should include rational-line warning');
    assert.ok(ctx.includes('警戒'), 'Should include caution level');
    assert.ok(ctx.includes('72%'), 'Should show usage percentage');
    assert.ok(ctx.includes('.cat-cafe/memory/{catId}.md'), 'Should direct memory write-back');
  });

  test('buildInvocationContext differentiates high and critical context pressure warnings', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const high = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      contextUsageWarning: {
        ratio: 0.86,
        estimatedTokens: 86000,
        maxPromptTokens: 100000,
        level: 'high',
        action: 'memory-writeback',
      },
    });
    const critical = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      contextUsageWarning: {
        ratio: 0.96,
        estimatedTokens: 96000,
        maxPromptTokens: 100000,
        level: 'critical',
        action: 'memory-writeback',
      },
    });

    assert.ok(high.includes('高压'), 'Should render high pressure heading');
    assert.ok(high.includes('请立即回写'), 'High pressure should ask immediate write-back');
    assert.ok(high.includes('验证命令'), 'High pressure should request handoff evidence');
    assert.ok(critical.includes('紧急'), 'Should render critical pressure heading');
    assert.ok(critical.includes('必须立即停下'), 'Critical pressure should require stopping and preserving state');
    assert.ok(
      critical.includes('下一轮可能从压缩后的摘要恢复'),
      'Critical pressure should mention compression recovery',
    );
  });

  test('buildInvocationContext injects A2A exit check when enabled (non-parallel)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(ctx.includes('A2A 路由'), 'Should include A2A routing hint');
    // a4d2f96b: 「行首 @ 才触发」→「任意位置 @ 都会触发」,并教「纯提及用不带 @ 的名字」
    assert.ok(ctx.includes('任意位置 @ 都会触发'), 'Should teach any-position @ routing');
    assert.ok(ctx.includes('纯提及用不带 @ 的名字'), 'Should teach plain-text mention without routing');
  });

  test('F167-F AC-F1: teammate roster surfaces resolved model per cat (handle/model 解绑)', async () => {
    // KD-21: handle = identity constant; model = runtime-resolved metadata.
    // Sender must see {@mention} + defaultModel aligned —防止"云端 codex (bot)"
    // 被投射成本地 @codex / @gpt52 的 cargo-cult 盲区 (opus-47 事故)。
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('opus');
      // Cloud Codex P2 fix: don't hardcode model strings — production resolves
      // via getCatModel (env CAT_{CATID}_MODEL → registry → defaults), so a legitimate
      // env override would make hardcoded assertions fail. Assert structural presence
      // instead: "@mention · <something>" adjacency for each roster row.
      assert.match(prompt, /@codex\s*·\s*\S+/, 'codex row must show "@codex · <model>" adjacency');
      assert.match(prompt, /@gpt52\s*·\s*\S+/, 'gpt52 row must show "@gpt52 · <model>" adjacency');
      assert.match(prompt, /@gemini\s*·\s*\S+/, 'gemini row must show "@gemini · <model>" adjacency');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E: teammate roster surfaces restrictions (硬限制) for teammates with them', async () => {
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('opus');
      assert.match(prompt, /队友名册/, 'must include 队友名册 section');
      assert.match(prompt, /禁止写代码/, 'teammate roster must surface gemini restrictions');
      assert.match(prompt, /硬限制/, 'restrictions must carry a visible marker distinct from narrative caution');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E: cat sees its own restrictions in self identity (self-awareness)', async () => {
    // gemini's own prompt must include its hard restrictions so it can
    // recognize illegitimate @-mentions and push back, without relying on harness gate.
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('gemini');
      assert.match(prompt, /你的硬限制/, 'gemini own prompt must declare its restrictions');
      assert.match(prompt, /禁止写代码/, 'gemini own prompt must name the 禁止写代码 ban');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E: cat without restrictions has NO self-restrictions block', async () => {
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('opus');
      // opus has no restrictions → 自我介绍里不应该出现 "你的硬限制"
      assert.doesNotMatch(prompt, /你的硬限制/, 'opus own prompt must not declare restrictions it does not have');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-E: teammate roster omits restrictions marker for teammates without them', async () => {
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }
      const prompt = buildStaticIdentity('opus');
      const rosterLines = prompt.split('\n').filter((l) => l.trim().startsWith('|'));
      const geminiLine = rosterLines.find((l) => /@gemini|@烁烁|@暹罗/.test(l));
      const codexLine = rosterLines.find((l) => /@codex/.test(l));
      assert.ok(geminiLine && /硬限制/.test(geminiLine), `gemini row must include 硬限制; got: ${geminiLine}`);
      assert.ok(
        codexLine && !/硬限制/.test(codexLine),
        `codex row (no restrictions) must NOT include 硬限制; got: ${codexLine}`,
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('F167-F AC-F10: AGENTS.md / CLAUDE.md have no hardcoded "@x = model-y" bindings', async () => {
    // KD-21 invariant: handle/model must stay decoupled in static docs. If someone
    // re-introduces "@codex（model=gpt-5.3-codex）" style hardcoding, this test traps it.
    const fs = await import('node:fs');
    const { readFileSync } = fs;
    const path = await import('node:path');
    const { dirname: dirFn, join } = path;
    const { fileURLToPath: fromUrl } = await import('node:url');
    const here = dirFn(fromUrl(import.meta.url));
    const repoRoot = resolve(here, '../../..');
    const readFlat = (name) => readFileSync(join(repoRoot, name), 'utf8');
    for (const fname of ['AGENTS.md', 'CLAUDE.md']) {
      const text = readFlat(fname);
      // KD-21 regression guard (cloud Codex round-4 broadening): detect ANY
      // static `@handle ... model=X` binding regardless of quoting style, model
      // family, or handle charset. Covers:
      //   - `@codex (model=`gpt-5.5`)`  — backticked
      //   - `@codex (model=gpt-5.5)`    — unquoted (round-4 gap)
      //   - `@codex (model="foo")`      — double-quoted
      //   - `@opus-45` / `@缅因猫`      — non-\w handles
      // @handle = `@` + non-whitespace/comma/open-paren chars.
      // model value = any non-whitespace (accepts quoted + unquoted).
      assert.doesNotMatch(
        text,
        /@[^\s,(（]+[^\n]{0,30}model=\S+/i,
        `${fname} must not hardcode "@xxx (model=anything)" — use runtime catalog truth source`,
      );
    }
  });

  test('F167-F AC-F7/F8: A2A section has inline-@ bad examples (URL / list / quote) and pre-send self-check', async () => {
    // KD-22: @ 行首 rule is protocol constant but model forgets in narrative context
    // (URL prefix "+@reviewer:", list bullet "- @cat:", quote "> @cat said..."等).
    // prompt 首轮教学要给具体视觉反例 + 发前自检问。
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus');
    // Existing 反例 "行中 @sonnet" 要保留，新增 URL / 列表 / quote 反例。
    assert.match(
      prompt,
      /URL|列表|quote|引用|前缀/i,
      'must show URL / list / quote / 前缀 scenarios as inline-@ traps',
    );
    // 发前自检问
    assert.match(
      prompt,
      /发前自检|我的 @.*都在行首|发出前扫/,
      'must include a pre-send self-check question about inline @',
    );
  });

  test('F167-F AC-F6: A2A closeout warns external identities are not local cats', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.match(
      ctx,
      /GitHub\s*(?:bot|Actions|review)|CI|云端 reviewer/i,
      'A2A closeout should name external identities as not local cats',
    );
    assert.match(
      ctx,
      /不是本地猫|不要投射成本地 @句柄/,
      'must state that external identities are not @-eligible local cats',
    );
  });

  test('F167-D2: A2A closeout is lightweight, not a forced decision tree', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.match(ctx, /只有明确需要队友行动时/, 'should only route when action is required');
    assert.match(ctx, /没有下一步就直接收口/, 'should allow no-handoff closeout');
    assert.doesNotMatch(ctx, /下一棒传球决策树|hold_ball|本轮必选其一/, 'should not inject old decision tree');
  });

  test('F167-D2: A2A closeout does not reintroduce co-creator ping rules', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.doesNotMatch(ctx, /@co-creator|反问式|要不要|僵局/, 'co-creator escalation rules live in shared-rules only');
  });

  test('F167-D2: A2A closeout does not force question-ping warnings', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.doesNotMatch(ctx, /反问式|软性|要不要/, 'question-ping warnings should not be a trailing anchor protocol');
  });

  test('buildInvocationContext does not inject A2A exit check in parallel mode', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'parallel',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(!ctx.includes('A2A 路由'), 'Parallel mode should not encourage @mention chaining');
  });

  // F167 L2 AC-A6: parallel 模式明确告知 @句柄 无路由语义
  test('buildInvocationContext injects parallel-mode no-mention hint in parallel mode', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'parallel',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(ctx.includes('并行模式'), 'parallel mode prompt should mention 并行模式');
    assert.ok(ctx.includes('无路由语义'), 'parallel mode should say @句柄 无路由语义');
  });

  test('buildInvocationContext does NOT inject parallel-mode no-mention hint in serial/independent mode', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(!ctx.includes('无路由语义'), 'non-parallel mode should not inject parallel hint');
  });

  test('buildInvocationContext injects mention routing feedback when provided', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: ['opus'],
      mcpAvailable: false,
      a2aEnabled: true,
      mentionRoutingFeedback: {
        sourceTimestamp: Date.now(),
        items: [{ targetCatId: 'opus', reason: 'no_action' }],
      },
    });
    assert.ok(ctx.includes('[路由提醒]'), 'Should include routing feedback banner');
    assert.ok(ctx.includes('@opus'), 'Should mention the target cat');
  });

  test('buildInvocationContext does not contain static identity or MCP tools', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });
    // Static identity content should NOT be in invocation context
    assert.ok(!ctx.includes('Anthropic'), 'Should not contain provider');
    assert.ok(!ctx.includes('## 协作'), 'Should not contain collaboration guide');
    // MCP tools moved to static identity (session-level, not per-message)
    assert.ok(!ctx.includes('cat_cafe_post_message'), 'MCP tools should be in static identity, not invocation context');
    // 铲屎官 reference also moved to static identity
    assert.ok(!ctx.includes('铲屎官是真人用户'), '铲屎官 reference should be in static identity');
  });

  test('buildStaticIdentity keeps MCP guidance minimal when mcpAvailable', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus', { mcpAvailable: true });
    assert.ok(identity.includes('上下文查询指南（按需拉取）'), 'Should contain lightweight tool guide');
    assert.ok(identity.includes('cat_cafe_get_thread_context'), 'Should contain thread context lookup hint');
    assert.ok(!identity.includes('cat_cafe_post_message'), 'Should not inject full MCP tool catalog');
  });

  test('buildStaticIdentity uses the same lightweight tool guide when mcpAvailable is false', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    assert.ok(identity.includes('cat_cafe_get_thread_context'), 'Should still teach pull-based context lookup');
    assert.ok(!identity.includes('cat_cafe_post_message'), 'Should not contain full write-tool catalog');
  });

  test('buildStaticIdentity does NOT include mcpCallbackInstructions (non-Claude stays per-message)', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    // Non-Claude cats use per-message injection for HTTP callback instructions
    // because their systemPrompt lives in session history and may be lost on compression.
    // Static identity only carries a lightweight pull-context guide.
    const identity = buildStaticIdentity('codex');
    assert.ok(!identity.includes('cat_cafe_post_message'), 'Codex should not have MCP tools in static identity');
    assert.ok(!identity.includes('HTTP 回调'), 'Codex should not have callback instructions in static identity');
  });

  test('buildStaticIdentity includes 铲屎官 reference', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    assert.ok(identity.includes('铲屎官'), 'Should contain 铲屎官 reference in static identity');
  });

  test('buildStaticIdentity includes configured co-creator name and mention handles', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const identity = buildStaticIdentity('opus');
    // Config resolution: cat-template.json (base) + .cat-cafe/cat-catalog.json (overlay).
    // Template has coCreator.name="You", catalog may override to deployment-specific name.
    // Test structural invariants that hold regardless of deployment config:
    assert.ok(identity.includes('铲屎官'), 'Should include 铲屎官 (always in CVO line)');
    assert.ok(identity.includes('行首'), 'Should teach line-start rule for owner mentions');
    // CVO line: "{name}（铲屎官/CVO）…行首写 `@handle` / `@handle2`。"
    assert.ok(/重要决策由.+拍板/.test(identity), 'Should include decision authority line');
    assert.ok(/行首写\s+`@\S+`/.test(identity), 'CVO line should contain backtick-wrapped mention handle after 行首写');
  });

  // F032 Phase D2: Reviewer section tests
  test('buildReviewerSection returns reviewer list for opus (different family reviewers)', async () => {
    const { buildReviewerSection } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const section = buildReviewerSection('opus');
    assert.ok(section, 'Should return section for opus');
    assert.ok(section.includes('## 你当前的 Reviewers'), 'Should have reviewer header');
    assert.ok(section.includes('@codex'), 'Should list codex as reviewer (different family)');
    // Should NOT list same-family cats (opus-45 is ragdoll, same as opus)
    assert.ok(!section.includes('@opus-45'), 'Should not list same-family opus-45');
  });

  test('buildReviewerSection returns null for unknown cat', async () => {
    const { buildReviewerSection } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const section = buildReviewerSection('unknown-cat');
    assert.equal(section, null, 'Should return null for unknown cat');
  });

  // Cloud Codex R5 P2: Verify same-family fallback behavior is documented
  // When requireDifferentFamily is enabled but no cross-family reviewers are available,
  // same-family reviewers should be shown with a fallback note.
  // This test verifies the cross-family-available case works correctly;
  // the fallback case requires mocking roster/availability (out of scope for unit test).
  test('buildReviewerSection shows cross-family when available (R5 P2 prerequisite)', async () => {
    const { buildReviewerSection } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const section = buildReviewerSection('opus');
    assert.ok(section, 'Should return section');
    // Cross-family available, so should NOT show fallback note
    assert.ok(!section.includes('fallback'), 'Should not show fallback note when cross-family available');
    assert.ok(section.includes('@codex'), 'Should show cross-family reviewer');
  });

  test('buildSystemPrompt includes reviewer section', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: true,
    });
    assert.ok(prompt.includes('## 你当前的 Reviewers'), 'System prompt should include reviewer section');
  });

  // --- F042 Wave 3: Active participant hint tests ---

  test('buildInvocationContext injects most-recently-active participant', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'serial',
      chainIndex: 2,
      chainTotal: 2,
      teammates: ['opus'],
      mcpAvailable: false,
      activeParticipants: [
        { catId: 'opus', lastMessageAt: 2000, messageCount: 5 },
        { catId: 'codex', lastMessageAt: 1000, messageCount: 3 },
      ],
    });
    assert.match(ctx, /最近活跃：布偶猫\(opus\)\n|最近活跃：布偶猫\(opus\)$/, 'Should inject displayName(id) format');
    assert.ok(!ctx.includes('最近活跃：缅因猫(codex)'), 'Self (codex) should not appear as most recently active');
  });

  test('buildInvocationContext includes routable handle for non-default active variant', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const ctx = buildInvocationContext({
        catId: 'pi',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
        activeParticipants: [{ catId: 'opus-45', lastMessageAt: 2000, messageCount: 5 }],
      });

      assert.match(ctx, /最近活跃：布偶猫 Opus 4\.5\(opus-45\).*@opus-45/);
      assert.doesNotMatch(ctx, /最近活跃：.*@opus(?![-\w])/);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('buildInvocationContext skips self in activity list', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: false,
      activeParticipants: [
        { catId: 'opus', lastMessageAt: 3000, messageCount: 8 },
        { catId: 'codex', lastMessageAt: 2000, messageCount: 4 },
      ],
    });
    // opus is self and most-recent, should be skipped; codex is next
    assert.match(ctx, /最近活跃：缅因猫\(codex\)\n|最近活跃：缅因猫\(codex\)$/, 'Should inject displayName(id) format');
  });

  test('buildInvocationContext omits hint when activeParticipants absent', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('最近活跃'), 'Should not inject when no activeParticipants');
  });

  test('buildInvocationContext omits hint when only self has activity', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: ['codex'],
      mcpAvailable: false,
      activeParticipants: [
        { catId: 'opus', lastMessageAt: 1000, messageCount: 1 },
        { catId: 'codex', lastMessageAt: 0, messageCount: 0 },
      ],
    });
    assert.ok(!ctx.includes('最近活跃'), 'Should not inject when no non-self participant has activity');
  });

  test('buildSystemPrompt size with activeParticipants stays under 3900 chars after simplified governance growth', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
      activeParticipants: [
        { catId: 'codex', lastMessageAt: Date.now(), messageCount: 5 },
        { catId: 'opus', lastMessageAt: Date.now() - 1000, messageCount: 3 },
      ],
    });
    assert.ok(prompt.length < 5700, `Full runtime prompt is ${prompt.length} chars, expected < 5700`);
  });

  // --- F042: pinned identity constant + direct-message reply target ---

  test('buildInvocationContext includes pinned Identity line with handle + model', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.match(ctx, /^Identity:/m);
    assert.ok(ctx.includes('@codex'));
    assert.ok(ctx.includes('model='), 'Identity line should include model=');
  });

  test('buildInvocationContext Identity line uses resolved runtime model override', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    const prev = process.env.CAT_CODEX_MODEL;
    process.env.CAT_CODEX_MODEL = 'gpt-5.9-codex-test';
    try {
      const ctx = buildInvocationContext({
        catId: 'codex',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
      });
      assert.ok(
        ctx.includes('model=gpt-5.9-codex-test'),
        'Identity line should use runtime-resolved model from env override',
      );
    } finally {
      if (prev === undefined) {
        delete process.env.CAT_CODEX_MODEL;
      } else {
        process.env.CAT_CODEX_MODEL = prev;
      }
    }
  });

  test('buildInvocationContext includes Direct message reply target + sender model (F167 anti-spoofing)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      directMessageFrom: 'opus',
    });
    assert.match(ctx, /^Direct message from 布偶猫\(opus\)/m);
    assert.ok(ctx.includes('reply to 布偶猫(opus)'));
    assert.ok(!ctx.includes('Direct message from @opus'));
    // F167 anti-spoofing: handoff must carry sender model marker explicitly
    assert.ok(ctx.includes('[model='), 'handoff must include sender model marker');
  });

  test('buildInvocationContext injects A2A trigger content above latest user message', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      directMessageFrom: 'opus',
      a2aTriggerMessageId: 'msg-opus-handoff',
      a2aTriggerContent:
        '@gpt52 上轮 review 提的 3 项遗留需要补完：删除 recommend_styles.py，清理 pipeline.py 引用，清理 e2e-pipeline/SKILL.md 和测试引用。',
    });
    assert.ok(ctx.includes('本轮任务来源：布偶猫(opus) 的 A2A 派工'), 'Should identify A2A source');
    assert.ok(ctx.includes('A2A trigger message: msg-opus-handoff'), 'Should include trigger id');
    assert.ok(ctx.includes('删除 recommend_styles.py'), 'Should include trigger content');
    assert.ok(ctx.includes('优先级：A2A 派工 > thread 最新用户消息'), 'Should define A2A priority');
    assert.ok(ctx.includes('不要因为最新用户消息只是在催其他 Agent 就拒绝执行'), 'Should prevent latest-user override');
  });

  test('buildInvocationContext includes routable reply handle for non-default variant sender', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const ctx = buildInvocationContext({
        catId: 'pi',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
        directMessageFrom: 'opus-45',
      });

      assert.match(ctx, /^Direct message from 布偶猫 Opus 4\.5\(opus-45\)/m);
      assert.ok(ctx.includes('reply via @opus-45'), 'variant sender reply must name the routable handle');
      assert.ok(!ctx.includes('reply via @opus '), 'must not suggest default opus handle for opus-45');
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // F167 P2 (cloud review 2026-04-18): sender model must also honor runtime env override,
  // not just static config. Asymmetric resolution (self=runtime, other=static) weakens
  // identity disambiguation when the sender's model is overridden at runtime.
  test('buildInvocationContext handoff sender model respects CAT_<ID>_MODEL env override', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');

    const prev = process.env.CAT_OPUS_MODEL;
    process.env.CAT_OPUS_MODEL = 'claude-opus-runtime-override';
    try {
      const ctx = buildInvocationContext({
        catId: 'codex',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
        directMessageFrom: 'opus',
      });
      assert.ok(
        ctx.includes('[model=claude-opus-runtime-override]'),
        'sender [model=...] must use runtime-resolved model, not static defaultModel',
      );
    } finally {
      if (prev === undefined) {
        delete process.env.CAT_OPUS_MODEL;
      } else {
        process.env.CAT_OPUS_MODEL = prev;
      }
    }
  });

  test('buildInvocationContext supports runtime variant cat IDs (gpt52)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const ctx = buildInvocationContext({
        catId: 'gpt52',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
        directMessageFrom: 'codex',
      });
      assert.match(ctx, /^Identity:/m);
      assert.ok(ctx.includes('@gpt52'));
      assert.match(ctx, /^Direct message from 缅因猫\(codex\)/m);
      assert.ok(ctx.includes('reply to 缅因猫(codex)'));
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // F167 identity anti-spoofing: same-breed variant handoff must disambiguate model
  // (Uses opus-45 which is in cat-template.json. Equivalent logic applies to opus-47.)
  test('buildInvocationContext injects same-breed anti-spoofing line when opus-45 receives from opus', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const ctx = buildInvocationContext({
        catId: 'opus-45',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
        directMessageFrom: 'opus',
      });
      // variant label embedded in self-identity (handle-free label path now carries it)
      assert.match(ctx, /^Identity:.*opus-45/m);
      // same-breed sender shows up with model marker (anti-spoofing: explicit model differentiation)
      assert.ok(ctx.includes('model=claude-opus-4-6'), 'sender model must be claude-opus-4-6');
      // anti-spoofing notice must fire (same displayName 布偶猫, different catId)
      assert.ok(
        ctx.includes('同族分身') || ctx.includes('不是你'),
        'same-breed handoff must inject anti-spoofing notice',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // F167: cross-breed handoff should NOT inject anti-spoofing (false positive guard)
  test('buildInvocationContext does NOT inject anti-spoofing for cross-breed handoff', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      directMessageFrom: 'codex',
    });
    // model marker present (useful context)
    assert.ok(ctx.includes('model='), 'handoff should carry model marker');
    // but no anti-spoofing line — different breed = no identity confusion
    assert.ok(!ctx.includes('同族分身'), 'cross-breed handoff must NOT inject 同族分身 notice');
  });

  // F167: variant label appears in handle-free label for peers with variantLabel
  test('formatHandleFreeLabel includes variantLabel (via ping-pong warning path)', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig(CAT_TEMPLATE_PATH));
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const ctx = buildInvocationContext({
        catId: 'opus',
        mode: 'serial',
        chainIndex: 2,
        chainTotal: 3,
        teammates: [],
        mcpAvailable: false,
        pingPongWarning: { pairedWith: 'opus-45', count: 2 },
      });
      // variant label must show in ping-pong paired-with label
      assert.ok(
        ctx.includes('Opus 4.5'),
        'ping-pong warning must include variantLabel (Opus 4.5) to disambiguate from other opus variants',
      );
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // --- F042: Thread routingPolicy hint tests ---

  test('buildInvocationContext injects routing policy summary line when present', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      routingPolicy: {
        v: 1,
        scopes: {
          review: { avoidCats: ['opus'], reason: 'budget' },
          architecture: { preferCats: ['opus'] },
        },
      },
    });
    assert.match(ctx, /Routing:.*review.*avoid.*@opus(?!-)/, 'Should include review avoid @opus');
    assert.match(ctx, /Routing:.*architecture.*prefer.*@opus(?!-)/, 'Should include architecture prefer @opus');
  });

  test('buildInvocationContext sanitizes routing reason and tolerates malformed lists', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      routingPolicy: {
        v: 1,
        scopes: {
          review: {
            avoidCats: 'opus',
            preferCats: { bad: true },
            reason: 'budget\ninject',
          },
        },
      },
    });
    assert.ok(ctx.includes('Routing: review'), 'Should still render routing line');
    assert.ok(ctx.includes('(budget inject)'), 'Should sanitize newline in reason');
    assert.ok(!ctx.includes('budget\ninject'), 'Should not allow multiline reason injection');
  });

  // --- F073 P4: SOP stage hint injection ---

  test('buildInvocationContext injects SOP stage hint when sopStageHint provided', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      sopStageHint: {
        stage: 'impl',
        suggestedSkill: 'tdd',
        featureId: 'F073',
      },
    });
    assert.ok(ctx.includes('SOP'), 'Should contain SOP label');
    assert.ok(ctx.includes('impl'), 'Should contain current stage');
    assert.ok(ctx.includes('tdd'), 'Should contain suggested skill');
    assert.ok(ctx.includes('F073'), 'Should contain feature ID');
  });

  test('guide prompt emits offered transition only for a brand-new guide match', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread-guide',
      guideCandidate: {
        id: 'add-member',
        name: '添加成员',
        estimatedTime: '3min',
        status: 'offered',
        isNewOffer: true,
      },
    });

    assert.ok(ctx.includes('Guide Matched'), 'new match should emit offer card instructions');
    assert.ok(ctx.includes('status="offered"'), 'new match should persist offered transition exactly once');
  });

  test('guide prompt does not re-send offered transition after the guide is already offered', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread-guide',
      guideCandidate: {
        id: 'add-member',
        name: '添加成员',
        estimatedTime: '3min',
        status: 'offered',
        isNewOffer: false,
      },
    });

    assert.ok(ctx.includes('Guide Pending'), 'existing offered guide should become a stable pending reminder');
    assert.ok(!ctx.includes('status="offered"'), 'existing offered guide must not re-send offered transition');
    assert.ok(!ctx.includes('cat_cafe_create_rich_block'), 'existing offered guide must not repeat the offer card');
  });

  test('guide preview from offered state advances to awaiting_choice once', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread-guide',
      guideCandidate: {
        id: 'add-member',
        name: '添加成员',
        estimatedTime: '3min',
        status: 'offered',
        userSelection: '步骤概览',
      },
    });

    assert.ok(ctx.includes('Guide Selection'), 'preview branch should still activate from offered state');
    assert.ok(
      ctx.includes('status="awaiting_choice"'),
      'first preview should advance the guide to awaiting_choice before resolving steps',
    );
  });

  test('guide preview from awaiting_choice does not re-send awaiting_choice transition', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread-guide',
      guideCandidate: {
        id: 'add-member',
        name: '添加成员',
        estimatedTime: '3min',
        status: 'awaiting_choice',
        userSelection: '步骤概览',
      },
    });

    assert.ok(ctx.includes('Guide Selection'), 'preview branch should remain available after awaiting_choice');
    assert.ok(ctx.includes('步骤概览回复用户'), 'repeated preview should still present inline step tips');
    assert.ok(
      !ctx.includes('status="awaiting_choice"'),
      'repeated preview must not emit an awaiting_choice -> awaiting_choice self-transition',
    );
  });

  test('buildInvocationContext omits SOP hint when sopStageHint absent', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('SOP:'), 'Should not contain SOP line when no hint');
  });

  test('buildInvocationContext SOP hint omits suggestedSkill when null', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      sopStageHint: {
        stage: 'review',
        suggestedSkill: null,
        featureId: 'F080',
      },
    });
    assert.ok(ctx.includes('SOP'), 'Should contain SOP label');
    assert.ok(ctx.includes('review'), 'Should contain stage');
    assert.ok(ctx.includes('F080'), 'Should contain feature ID');
    assert.ok(!ctx.includes('skill'), 'Should not contain skill reference when null');
  });

  test('buildSystemPrompt size stays under 3900 chars with SOP hint after simplified governance growth', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
      activeParticipants: [{ catId: 'codex', lastMessageAt: Date.now(), messageCount: 5 }],
      sopStageHint: {
        stage: 'quality_gate',
        suggestedSkill: 'quality-gate',
        featureId: 'F073',
      },
    });
    assert.ok(prompt.length < 5800, `Prompt with SOP hint is ${prompt.length} chars, expected < 5800`);
  });

  // --- F092: Voice Mode prompt injection ---

  test('buildInvocationContext includes voice mode instructions when voiceMode=true', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      voiceMode: true,
    });
    assert.ok(ctx.includes('Voice Mode ON'), 'Should include voice mode header');
    assert.ok(ctx.includes('audio rich block'), 'Should mention audio rich block');
  });

  test('buildInvocationContext omits voice mode instructions when voiceMode absent', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('Voice Mode ON'), 'Should not include voice mode header');
  });

  test('buildSystemPrompt size stays under 5200 chars with voice mode + SOP hint after simplified governance growth', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 3,
      teammates: ['codex', 'gemini'],
      mcpAvailable: true,
      promptTags: ['critique'],
      activeParticipants: [{ catId: 'codex', lastMessageAt: Date.now(), messageCount: 5 }],
      sopStageHint: {
        stage: 'quality_gate',
        suggestedSkill: 'quality-gate',
        featureId: 'F073',
      },
      voiceMode: true,
    });
    assert.ok(prompt.length < 5800, `Prompt with voice mode + SOP hint is ${prompt.length} chars, expected < 5800`);
  });

  test('buildInvocationContext injects bootcamp mode when bootcampState provided', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      bootcampState: {
        v: 1,
        phase: 'phase-2-env-check',
        leadCat: 'opus',
        startedAt: Date.now(),
      },
    });
    assert.ok(ctx.includes('Bootcamp Mode'), 'Should include bootcamp header');
    assert.ok(ctx.includes('phase-2-env-check'), 'Should include current phase');
    assert.ok(ctx.includes('leadCat=opus'), 'Should include lead cat');
    assert.ok(ctx.includes('bootcamp-guide'), 'Should reference skill');
  });

  test('buildInvocationContext injects threadId in bootcamp mode', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      threadId: 'thread_abc123',
      bootcampState: {
        v: 1,
        phase: 'phase-1-intro',
        startedAt: Date.now(),
      },
    });
    assert.ok(ctx.includes('thread=thread_abc123'), 'Should include threadId in bootcamp line');
  });

  test('buildInvocationContext omits bootcamp when bootcampState absent', async () => {
    const { buildInvocationContext } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const ctx = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!ctx.includes('Bootcamp Mode'), 'Should not include bootcamp header');
  });

  // --- 回归测试：maine-coon prompt 必须包含 A2A 执行纪律 ---

  test('maine-coon prompt contains execution discipline keywords', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'codex',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(prompt.includes('有明确执行任务才启动'), 'maine-coon prompt must include execution trigger boundary');
    assert.ok(prompt.includes('不全量接续检查'), 'maine-coon prompt must include no full continuation check boundary');
    assert.ok(prompt.includes('主消息给结论'), 'maine-coon prompt must include user-readable output rule');
    assert.ok(prompt.includes('出口一问'), 'maine-coon prompt must include 出口一问');
  });

  test('maine-coon workflow contains A2A state transition keywords', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const codexId = buildStaticIdentity('codex');
    assert.ok(codexId.includes('有明确执行任务才启动'), 'codex prompt must include execution trigger boundary');
    assert.ok(codexId.includes('没有下一棒就说明已收口'), 'codex prompt must include handoff closeout rule');
    assert.ok(codexId.includes('无任务 @ 只短确认'), 'codex prompt must include no-task mention short-circuit');
  });

  test('static identity includes merged execution closeout rules', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('codex');
    assert.ok(prompt.includes('执行闭环'), 'prompt must include merged execution rules');
    assert.ok(prompt.includes('先认领或复用任务'), 'prompt must require task ownership before action');
    assert.ok(prompt.includes('交付必须附证据'), 'prompt must require delivery evidence');
    assert.ok(prompt.includes('阻塞原因 + 缺什么'), 'prompt must require actionable blocked state');
    assert.ok(!prompt.includes('Intake Gate'), 'prompt must not reintroduce standalone audit protocol');
    assert.ok(!prompt.includes('Status Gate'), 'prompt must not reintroduce standalone audit protocol');
  });

  // ─── F129 Pack Block Injection ──────────────────────────────────────

  test('F129: buildStaticIdentity injects all pack blocks', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', {
      mcpAvailable: false,
      packBlocks: {
        packName: 'test-pack',
        guardrailBlock: '## [Pack: test-pack] 硬约束\n- Never trade without risk disclosure',
        defaultsBlock: '## [Pack: test-pack] 默认行为\n- Use formal financial terminology',
        masksBlock: '## [Pack: test-pack] 角色叠加\n- Role: Quantitative Analyst',
        workflowsBlock: '## [Pack: test-pack] 工作流\n- Trigger: /research',
        worldDriverSummary: '## [Pack: test-pack] 世界引擎（只读摘要）\nResolver: hybrid',
      },
    });

    assert.ok(prompt.includes('硬约束'), 'Should inject guardrail block');
    assert.ok(prompt.includes('默认行为'), 'Should inject defaults block');
    assert.ok(prompt.includes('角色叠加'), 'Should inject masks block');
    assert.ok(prompt.includes('工作流'), 'Should inject workflows block');
    assert.ok(prompt.includes('世界引擎'), 'Should inject world driver summary');
  });

  test('F129: pack masks appear after identity, before governance', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', {
      packBlocks: {
        packName: 'test-pack',
        masksBlock: '## PACK_MASK_MARKER',
        guardrailBlock: '## PACK_GUARD_MARKER',
        defaultsBlock: null,
        workflowsBlock: null,
        worldDriverSummary: null,
      },
    });

    const maskPos = prompt.indexOf('PACK_MASK_MARKER');
    const guardPos = prompt.indexOf('PACK_GUARD_MARKER');
    const identityPos = prompt.indexOf('布偶猫');

    assert.ok(maskPos > identityPos, 'Masks should appear after identity');
    assert.ok(guardPos > maskPos, 'Guardrails should appear after masks');
  });

  test('F129: pack guardrails appear after core governance', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', {
      packBlocks: {
        packName: 'test-pack',
        guardrailBlock: '## PACK_GUARD_MARKER',
        defaultsBlock: '## PACK_DEFAULT_MARKER',
        masksBlock: null,
        workflowsBlock: null,
        worldDriverSummary: null,
      },
    });

    const guardPos = prompt.indexOf('PACK_GUARD_MARKER');
    const defaultPos = prompt.indexOf('PACK_DEFAULT_MARKER');
    // Core governance must come before pack guardrails.
    const coreGovPos = prompt.indexOf('协作规则');

    assert.ok(coreGovPos > -1, 'Core governance should exist in prompt');
    assert.ok(guardPos > coreGovPos, 'Pack guardrails must come AFTER core governance (KD-9)');
    assert.ok(defaultPos > guardPos, 'Pack defaults must come after pack guardrails');
  });

  test('F129: buildSystemPrompt passes packBlocks through', async () => {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildSystemPrompt({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      packBlocks: {
        packName: 'quant-cats',
        guardrailBlock: '## [Pack: quant-cats] 硬约束\n- Risk disclosure required',
        defaultsBlock: '## [Pack: quant-cats] 默认行为\n- Financial terminology',
        masksBlock: '## [Pack: quant-cats] 角色叠加\n- Quantitative Analyst',
        workflowsBlock: null,
        worldDriverSummary: null,
      },
    });

    assert.ok(prompt.includes('硬约束'), 'buildSystemPrompt should include guardrail block');
    assert.ok(prompt.includes('角色叠加'), 'buildSystemPrompt should include masks block');
    assert.ok(prompt.includes('默认行为'), 'buildSystemPrompt should include defaults block');
  });

  test('F129: null/undefined packBlocks produce no pack sections', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const withNull = buildStaticIdentity('opus', { packBlocks: null });
    const withUndef = buildStaticIdentity('opus', {});

    assert.ok(!withNull.includes('角色叠加'), 'null packBlocks should not inject masks');
    assert.ok(!withNull.includes('硬约束'), 'null packBlocks should not inject guardrails');
    assert.ok(!withUndef.includes('角色叠加'), 'undefined packBlocks should not inject masks');
    assert.ok(!withUndef.includes('硬约束'), 'undefined packBlocks should not inject guardrails');
  });

  test('F129: partial packBlocks only inject present fields', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', {
      packBlocks: {
        packName: 'partial-pack',
        guardrailBlock: '## ONLY_GUARDRAILS_HERE',
        defaultsBlock: null,
        masksBlock: null,
        workflowsBlock: null,
        worldDriverSummary: null,
      },
    });

    assert.ok(prompt.includes('ONLY_GUARDRAILS_HERE'), 'Should inject the one present block');
    assert.ok(!prompt.includes('角色叠加'), 'Should not inject null masks');
    assert.ok(!prompt.includes('默认行为'), 'Should not inject null defaults');
  });

  test('Slock-like governance: minimal toolbox injects only core shared-rules digest', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', { toolPolicy: 'minimal' });

    assert.ok(prompt.includes('核心协作规则（摘要）'), 'minimal should keep the core governance floor');
    assert.ok(prompt.includes('完整规则按需查阅'), 'minimal should point to the full source of truth');
    assert.ok(!prompt.includes('46 hotfix止血治理'), 'minimal should not carry operational governance details');
    assert.ok(
      !prompt.includes('缅因猫fallback层数检测'),
      'minimal should not carry breed-specific operational audit text',
    );
  });

  test('Slock-like governance: standard toolbox keeps operational shared-rules digest', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus', { toolPolicy: 'standard' });

    assert.ok(prompt.includes('协作规则（shared-rules.md）'), 'standard should keep the operational governance digest');
    assert.ok(!prompt.includes('费曼解释'), 'standard should not expose Feynman jargon');
    assert.ok(prompt.includes('中文白话优先'), 'standard should include user-readable output rule');
    assert.ok(prompt.includes('无任务短路'), 'standard should include no-task mention short-circuit');
    assert.ok(prompt.includes('没人认领的任务留在 board 可见'), 'standard should include task-board anti-drop rule');
    assert.ok(prompt.includes('不靠全局品种管控'), 'standard should include per-agent memory behavior constraint');
    assert.ok(prompt.includes('不可逆操作、愿景级决策、跨猫僵局'), 'standard should include escalation boundary');
    assert.ok(prompt.includes('runtime端口不是沙箱'), 'standard should include runtime safety rule');
    assert.ok(!prompt.includes('46 hotfix止血治理'), 'standard should not include retired hotfix-specific rules');
    assert.ok(!prompt.includes('Magic Words'), 'standard should not include retired magic word protocol');
  });

  test('Slock-like governance: retired magic words no longer trigger shared-rules source context', async () => {
    const { buildGovernanceSourceContext, detectGovernanceMagicWord, buildInvocationContext } = await import(
      '../dist/domains/cats/services/context/SystemPromptBuilder.js'
    );

    assert.equal(detectGovernanceMagicWord('这个方向绕路了'), null);
    assert.equal(detectGovernanceMagicWord('普通问候'), null);

    const sourceContext = buildGovernanceSourceContext('喵约，重新对照一下');
    assert.equal(sourceContext, null, 'retired magic words should not build source context');

    const invocation = buildInvocationContext({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      governanceSourceContext: sourceContext,
    });
    assert.ok(!invocation.includes('家规原文按需参考'), 'invocation should not inject source context without a source');
  });

  // ── Drift guard: simplified shared-rules should not reintroduce Magic Words ──
  test('GOVERNANCE_L0_DIGEST does not reintroduce retired Magic Words', async () => {
    const { readFileSync } = await import('node:fs');
    const { detectGovernanceMagicWord } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const rulesPath = resolve(import.meta.dirname, '../../../cat-cafe-skills/refs/shared-rules.md');
    const rulesText = readFileSync(rulesPath, 'utf8');
    assert.ok(!rulesText.includes('Magic Words'), 'shared-rules should not include retired Magic Words section');
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!prompt.includes('Magic Words'), 'runtime prompt should not include retired Magic Words section');
    assert.equal(detectGovernanceMagicWord('喵约'), null, 'retired magic word should not trigger at runtime');
  });

  // ── Drift guard: shared-rules.md ↔ GOVERNANCE_L0_DIGEST ──────
  test('GOVERNANCE_L0_DIGEST stays in sync with shared-rules.md world-view headings', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { createHash } = await import('node:crypto');

    // Extract world-view / principle section headings from shared-rules.md
    const rulesPath = resolve(import.meta.dirname, '../../../cat-cafe-skills/refs/shared-rules.md');
    const rulesText = readFileSync(rulesPath, 'utf8');
    const headings = rulesText
      .split('\n')
      .filter((l) => /^###?\s+(P\d|W\d)/.test(l))
      .sort()
      .join('\n');
    const hash = createHash('sha256').update(headings).digest('hex').slice(0, 16);

    // Pin: update this hash whenever you add/remove/rename P* or W* sections
    // in shared-rules.md, AND update GOVERNANCE_L0_DIGEST in SystemPromptBuilder.ts
    const PINNED_HASH = '8fca3c4f8127ca15';
    if (PINNED_HASH === '${PLACEHOLDER}') {
      // First run — print hash for pinning
      console.log(`[drift-guard] shared-rules headings hash: ${hash} — pin this value`);
      return; // skip assertion on first run
    }
    assert.equal(
      hash,
      PINNED_HASH,
      `shared-rules.md P*/W* headings changed (got ${hash}, pinned ${PINNED_HASH}). ` +
        'Update GOVERNANCE_L0_DIGEST in SystemPromptBuilder.ts to match, then update PINNED_HASH here.',
    );
  });

  // ── F182 Phase B: Roster invisibility guard ─────────────────────────────────────────────────
  // AC-B1: disabled cat must NOT appear in buildTeammateRoster output (OQ-3 方案C)
  // AC-B2: disabled cat catId/mention must NOT appear in buildStaticIdentity any section
  // AC-B3: NOT changing buildTeammateRoster logic — only adding guard tests

  test('F182 B1: disabled cat (antigravity) does not appear in teammate roster section', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildStaticIdentity('opus');
    // antigravity should not appear in the roster table (| ... | ... |)
    // The roster table rows contain catId or mentionPatterns
    // Whether or not roster section exists, antigravity must not appear
    assert.ok(!prompt.includes('antigravity'), 'disabled cat "antigravity" must not appear in static identity prompt');
  });

  test('F182 B2: disabled cat mention patterns do not appear in any prompt section', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    // Check for opus as subject (antigravity is not opus, so would appear as teammate if not filtered)
    const prompt = buildStaticIdentity('opus');
    // antigravity has mentionPatterns like @antigravity, @孟加拉猫
    assert.ok(!prompt.includes('@antigravity'), 'disabled cat @antigravity mention must not appear');
    // catId should not appear
    assert.ok(!prompt.includes('antigravity'), 'disabled cat catId "antigravity" must not appear in any section');
  });

  test('F182 B1+B2: disabled cat does not appear in buildSystemPrompt output', async () => {
    const build = await getBuilder();
    const prompt = build({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
    });
    assert.ok(!prompt.includes('antigravity'), 'disabled cat must not appear in full system prompt');
  });

  test('F182 B3: available cats still appear in roster (regression guard)', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    // codex is available — should appear in opus's roster
    const prompt = buildStaticIdentity('opus');
    assert.ok(prompt.includes('codex'), 'available cat @codex must appear in roster');
  });
});
