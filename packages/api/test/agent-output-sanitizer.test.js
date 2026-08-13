import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('agent output sanitizer', () => {
  async function getSanitizer() {
    const mod = await import('../dist/domains/cats/services/agents/routing/agent-output-sanitizer.js');
    return mod.sanitizeAgentVisibleOutput;
  }

  test('removes internal task protocol and citation markers', async () => {
    const sanitize = await getSanitizer();
    const output = sanitize('Task claim 00017799 已更新到 in_review，cite:turn0view0');

    assert.equal(output, '');
    assert.ok(!output.includes('Task claim'));
    assert.ok(!output.includes('in_review'));
    assert.ok(!output.includes('cite:turn0view0'));
  });

  test('keeps final conclusion while stripping citations and temp paths', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '结论：PilotDeck 适合借鉴架构，不适合直接作为稳定底座。citeturn0view0',
      '',
      '本地 clone 在 /tmp/pilotdeck-research，仅用于只读调研。',
    ].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('结论：PilotDeck 适合借鉴架构，不适合直接作为稳定底座。'));
    assert.ok(!output.includes('cite'));
    assert.ok(!output.includes('/tmp/pilotdeck-research'));
  });

  test('drops only protocol blocks, not adjacent useful blocks', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '我接球做 OpenBMB/PilotDeck 调研。当前 $CLI 未注入，inbox 标记 requiresTask: no。',
      '',
      '建议：只抽取 WorkSpace 隔离、可审计记忆、显式子 agent harness 三块给 Clowder。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '建议：只抽取 WorkSpace 隔离、可审计记忆、显式子 agent harness 三块给 Clowder。');
  });

  test('drops internal progress jargon lines while keeping conclusions', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '🔍 我先取上下文',
      '我会先按家规查当前任务记忆和可用工具，再快速扫本地 skill 目录。',
      '',
      '📊 初步结果',
      '本地三个主要 skill 根目录里扫到 399 个 SKILL.md。',
      '',
      '结论：你的 skill 不是缺数量，而是缺触发和应用闭环。',
      '建议：先做 manifest + dashboard，再接入 Clowder router。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(
      output,
      '结论：你的 skill 不是缺数量，而是缺触发和应用闭环。\n建议：先做 manifest + dashboard，再接入 Clowder router。',
    );
  });

  test('removes continuation and memory-hit implementation chatter', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '接续检查：读取最近 thread 与 MEMORY.md。',
      '记忆命中：发现 PilotDeck 已调研。',
      '全量扫描完成，开始整理。',
      '结论：这里应该只输出用户可用的判断。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：这里应该只输出用户可用的判断。');
  });

  test('drops markdown progress sections before final delivery', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '**🔍 我开始做指南**',
      '',
      '**📌 证据不够细**',
      '',
      '搜索只确认了同一条线程的大方向，具体可执行内容要以本地文件为准。我现在认领当前消息，再并行读源文件和目标目录。',
      '',
      '**⚠️ 真相源路径有偏差**',
      '',
      '导航给的路径不存在。我会先重新定位真实文件，再继续写入目标目录。',
      '',
      '**🛠️ 准备落盘**',
      '',
      '我已经确认目标目录和索引位置，现在开始写文件、补索引、回写记忆。',
      '',
      '**✅ 已完成**',
      '',
      '已沉淀 `design-compiler-guide.md`，并补充 `README.md` 索引。',
      '',
      '**验证证据**',
      '',
      '- 目标文件存在',
      '- API build 通过',
      '',
      '**费曼版**',
      '',
      '这份 skill 是把设计风格翻译成可复用操作手册。',
    ].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('**✅ 已完成**'));
    assert.ok(output.includes('design-compiler-guide.md'));
    assert.ok(output.includes('**验证证据**'));
    assert.ok(output.includes('**白话解释**'));
    assert.ok(!output.includes('费曼'));
    assert.ok(!output.includes('我开始做指南'));
    assert.ok(!output.includes('证据不够细'));
    assert.ok(!output.includes('我现在认领当前消息'));
    assert.ok(!output.includes('准备落盘'));
    assert.ok(!output.includes('回写记忆'));
  });

  test('preserves markdown conclusion after progress chatter', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '**🔍 我先独立看问题**',
      '',
      '我会先读链接消息，再检查协议和规则是否影响输出。',
      '',
      '**📌 证据命中较宽**',
      '',
      '需要继续扩一圈看路由和清洗链路。',
      '',
      '**🎯 结论**',
      '',
      '问题不在前端排版，而在 agent 把执行日志写进了最终正文。',
      '',
      '**建议**',
      '',
      '在写入前清洗过程段落，只保留结论、交付和验证。',
    ].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('**🎯 结论**'));
    assert.ok(output.includes('问题不在前端排版'));
    assert.ok(output.includes('**建议**'));
    assert.ok(!output.includes('我先独立看问题'));
    assert.ok(!output.includes('继续扩一圈'));
  });

  test('drops codex anchor lookup progress headings before the real answer', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '🔍 我先按消息锚点查上下文',
      '',
      '你给的是 thread 内某条消息的锚点。我会先用证据库按 ID 精确查，再尝试读本地页面。',
      '',
      '🔎 本地页面没有直接吐出消息内容',
      '',
      'curl 只能拿到 Next.js 外壳，没拿到那条消息。',
      '',
      '🧭 我有两个事实了',
      '',
      '1. curl 打开的是 3003 的应用外壳。',
      '2. 当前磁盘上的文件不在原路径了。',
      '',
      '✅ 找到可用 API',
      '',
      '3003 的 `/api/messages?threadId=...` 能返回完整消息。',
      '',
      '✅ 我看完锚点上下文了',
      '',
      '这条链接锚到的是一次试跑，不是最终源文件。',
      '',
      '结论：锚点消息说明当前任务应该先确认来源文件，再继续执行。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：锚点消息说明当前任务应该先确认来源文件，再继续执行。');
  });

  test('drops model-visible skills budget warning lines', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '结论：任务已经完成。',
      '',
      '⚠️ Exceeded skills context budget of 2%. All skill descriptions were removed and 257 additional skills were not included in the model-visible skills list.',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：任务已经完成。');
  });

  test('drops shared-state preflight warnings from final chat output', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '⚠️ Shared-state preflight: uncommitted shared-state files: cat-template.json, docs/ROADMAP.md. Please commit+push before continuing (shared-rules §14).',
      '',
      '结论：这是内部治理提醒，不应该进入主会话正文。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：这是内部治理提醒，不应该进入主会话正文。');
  });

  test('drops internal handoff runtime JSON from final chat output', async () => {
    const sanitize = await getSanitizer();
    const input = [
      '{"type":"handoff_draft_window","catId":"gpt52","sessionId":"session_1","threadId":"default","healthSnapshot":{"usedTokens":277596,"windowTokens":353400,"fillRatio":0.7855,"source":"exact","measuredAt":1783658472680},"trust":"trusted"}',
      '',
      '结论：上下文压力信息只能留在内部运行态。',
    ].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：上下文压力信息只能留在内部运行态。');
  });
});

describe('leaked prompt envelope (kiro-cli turn wrapper)', () => {
  async function getSanitizer() {
    const mod = await import('../dist/domains/cats/services/agents/routing/agent-output-sanitizer.js');
    return mod.sanitizeAgentVisibleOutput;
  }

  // 现场取自 thread_ms16zvb8ex5mdwem（2026-07-29）：两条 opus5-architect 的 assistant
  // 消息末尾都追加了下一轮的完整 prompt。硬证据是包装里的 `Current time` 比消息自己的
  // timestamp 晚 5-7 分钟 —— 模型不可能预知未来的毫秒级时间，所以这是 kiro-cli 在同一
  // ACP session 上把新一轮输入回显成了 text chunk，被 accumulateTextAggregate 纯 append
  // 并进正文后落库。
  const LEAKED_TAIL = [
    'user--- CONTEXT ENTRY BEGIN ---',
    'Current time: Thursday, 2026-07-30T00:47:20.048+08:00',
    '--- CONTEXT ENTRY END ---',
    '',
    '--- USER MESSAGE BEGIN ---',
    '## Dispatch Mission Context',
    '',
    'mission: Quant',
    'work_item: Quant',
    'phase: unknown',
    '',
    'Identity: Kiro Opus 5/砚砚 (@opus5-architect, model=claude-opus-5)',
    '当前模式：独立回答。',
  ].join('\n');

  test('truncates the echoed next-turn prompt from the tail of a real reply', async () => {
    const sanitize = await getSanitizer();
    const input = ['结论：akquant 的账务能闭合，C1 已通过。', '', LEAKED_TAIL].join('\n');

    const output = sanitize(input);

    assert.equal(output, '结论：akquant 的账务能闭合，C1 已通过。');
    assert.ok(!output.includes('CONTEXT ENTRY'));
    assert.ok(!output.includes('USER MESSAGE BEGIN'));
    assert.ok(!output.includes('Dispatch Mission Context'));
    assert.ok(!output.includes('当前模式'));
  });

  test('keeps the wrapper when a cat is legitimately quoting it inside a code fence', async () => {
    // 自指保护：讨论这个 bug 时正文里就会出现这些标记。围栏内必须原样保留，
    // 否则排查这类问题的回复会被自己的清洗规则截断。
    const sanitize = await getSanitizer();
    const input = [
      '结论：这段包装来自 kiro-cli，不是 Clowder 生成的。',
      '',
      '```text',
      LEAKED_TAIL,
      '```',
      '',
      '建议：在写入前按结构标记截断。',
    ].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('CONTEXT ENTRY BEGIN'));
    assert.ok(output.includes('USER MESSAGE BEGIN'));
    assert.ok(output.includes('建议：在写入前按结构标记截断。'));
  });

  test('leaves an unrelated horizontal rule untouched', async () => {
    const sanitize = await getSanitizer();
    const input = ['结论：第一段。', '', '---', '', '建议：第二段。'].join('\n');

    const output = sanitize(input);

    assert.ok(output.includes('结论：第一段。'));
    assert.ok(output.includes('建议：第二段。'));
  });
});

describe('progress channel sanitizer (轻量版，不做叙事过滤)', () => {
  async function getProgressSanitizer() {
    const mod = await import('../dist/domains/cats/services/agents/routing/agent-output-sanitizer.js');
    return mod.sanitizeAgentProgressOutput;
  }

  test('中文进度不被内部独白启发式误杀（此前实测只有 ASCII 能过）', async () => {
    const sanitize = await getProgressSanitizer();
    // 这些句式全部命中 INTERNAL_PROGRESS_LINE_PATTERNS，完整版会整块吞掉
    const input = '我开始做：M3-B C-01 返修。初步结果：七条 P1 已定位，收尾验证稍后补。';

    const output = sanitize(input);

    assert.ok(output.includes('我开始做'), '进度通道必须保留「我开始做」句式');
    assert.ok(output.includes('初步结果'), '进度通道必须保留「初步结果」句式');
    assert.ok(output.includes('收尾验证'), '进度通道必须保留「收尾验证」句式');
  });

  test('协议泄漏与引用伪影仍然清除', async () => {
    const sanitize = await getProgressSanitizer();
    const output = sanitize('正在返修 cite:turn0view0\n\nShared-state preflight passed');

    assert.ok(output.includes('正在返修'));
    assert.ok(!output.includes('cite:turn0view0'), 'citation 伪影必须清除');
    assert.ok(!output.includes('Shared-state'), '协议块必须清除');
  });

  test('空内容原样返回', async () => {
    const sanitize = await getProgressSanitizer();
    assert.equal(sanitize(''), '');
  });
});

describe('开头整段逐字重复去重（cursor 重发现场）', () => {
  async function getSanitizer() {
    const mod = await import('../dist/domains/cats/services/agents/routing/agent-output-sanitizer.js');
    return mod.sanitizeAgentVisibleOutput;
  }

  test('A+A+后续 → A+后续（sol 现场：整段重复后接 @mention 与正文）', async () => {
    const sanitize = await getSanitizer();
    const A = '双变异红窗已稳定复现：配置载体逃逸未命中 CFG-MISSING，其余 47 个验收节点通过。';
    const out = sanitize(`${A}${A}@cursor-fable-5-thinking-max`);
    assert.equal(out, `${A}@cursor-fable-5-thinking-max`);
  });

  test('A+A → A（sol #238 现场：整条就是一段重复两遍）', async () => {
    const sanitize = await getSanitizer();
    const A = '候选已让既有 symlink 双红窗转绿，但相邻边界扫描发现新的稳定错误码缺口。';
    assert.equal(sanitize(`${A}${A}`), A);
  });

  test('合法内容不误伤：开头段只出现一次时原样保留', async () => {
    const sanitize = await getSanitizer();
    const text = '结论：方案可行。\n\n下一步：补测试。';
    assert.equal(sanitize(text), text);
  });

  test('合法内容不误伤：开头两句不同不去重', async () => {
    const sanitize = await getSanitizer();
    const text = '第一点是这样。第二点是那样。第三点收尾。';
    assert.equal(sanitize(text), text);
  });
});
