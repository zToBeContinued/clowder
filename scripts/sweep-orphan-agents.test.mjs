/**
 * sweep-orphan-agents 回归测试
 *
 * 2026-08-12 quant「幽灵写手」事故：API 被硬杀后，派工出去的 CLI agent
 * （经 .ps1/.cmd 包装）与 kiro-cli acp carrier 变成孤儿继续写目标项目。
 * 启动/停机时必须识别并整树清扫，且绝不误杀健康实例名下的 agent。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identifyOrphanAgents, isClowderAgentCommandLine, parseSnapshotLines } from './sweep-orphan-agents.mjs';

const DISPATCH =
  '"C:\\cursor-agent\\node.exe" index.js --print --workspace D:\\project\\quant "## Dispatch Mission Context mission: quant"';
const KIRO_ACP = '"C:\\Users\\Administrator\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe" acp --trust-all-tools';

test('标记识别：派工 CLI 与 kiro acp 命中，交互式 kiro chat 与无关进程不命中', () => {
  assert.equal(isClowderAgentCommandLine(DISPATCH), true);
  assert.equal(isClowderAgentCommandLine(KIRO_ACP), true);
  assert.equal(isClowderAgentCommandLine('"C:\\...\\kiro-cli.exe" chat'), false, '用户交互式 kc 不能被清');
  assert.equal(isClowderAgentCommandLine('node D:\\some\\acp-tools\\build.js'), false, '路径里的 acp 字样不算');
  assert.equal(isClowderAgentCommandLine('"D:\\nodejs\\node.exe" dist/index.js'), false);
  assert.equal(isClowderAgentCommandLine(''), false);
});

test('孤儿判定：父进程已死的派工 agent 被选中，父链健在的不动', () => {
  const rows = [
    { pid: 100, ppid: 1, createdMs: 1000, cmdline: 'C:\\Windows\\explorer.exe' },
    // 孤儿：父 9999 不在表中（今晚的 31480 形态）
    { pid: 200, ppid: 9999, createdMs: 2000, cmdline: DISPATCH },
    // 健康:另一个活着的 Clowder 实例（API 300 → 包装 310 → agent 320）
    {
      pid: 300,
      ppid: 100,
      createdMs: 1500,
      cmdline: '"D:\\nodejs\\node.exe" D:\\other\\clowder\\packages\\api\\dist\\index.js',
    },
    {
      pid: 310,
      ppid: 300,
      createdMs: 1600,
      cmdline: `powershell.exe -File cursor-agent.ps1 "## Dispatch Mission Context"`,
    },
    { pid: 320, ppid: 310, createdMs: 1700, cmdline: DISPATCH },
  ];
  const orphans = identifyOrphanAgents(rows);
  assert.deepEqual(
    orphans.map((o) => o.pid),
    [200],
  );
});

test('孤儿判定：包装进程活着但其 API 父已死 → 清包装的树（agent 随树死）', () => {
  const rows = [
    // 包装进程的父（API）已不在表中 → 包装是孤儿根
    {
      pid: 310,
      ppid: 8888,
      createdMs: 1600,
      cmdline: 'powershell.exe -File cursor-agent.ps1 "## Dispatch Mission Context"',
    },
    // agent 的父（包装 310）还活着 → agent 本身不入选，由 310 的整树击杀覆盖
    { pid: 320, ppid: 310, createdMs: 1700, cmdline: DISPATCH },
  ];
  const orphans = identifyOrphanAgents(rows);
  assert.deepEqual(
    orphans.map((o) => o.pid),
    [310],
  );
});

test('PID 复用：占据父 PID 的进程比自己年轻 → 视为孤儿', () => {
  const rows = [
    { pid: 500, ppid: 1, createdMs: 9000, cmdline: 'C:\\Windows\\svchost.exe' },
    { pid: 600, ppid: 500, createdMs: 3000, cmdline: KIRO_ACP },
  ];
  const orphans = identifyOrphanAgents(rows);
  assert.deepEqual(
    orphans.map((o) => o.pid),
    [600],
  );
});

test('创建时间未知（0）时不做复用判定，父存在即视为健康', () => {
  const rows = [
    { pid: 500, ppid: 1, createdMs: 0, cmdline: 'C:\\Windows\\svchost.exe' },
    { pid: 600, ppid: 500, createdMs: 3000, cmdline: KIRO_ACP },
  ];
  assert.deepEqual(identifyOrphanAgents(rows), []);
});

test('自身祖先链绝不清扫（即使命令行带标记且父已死）', () => {
  const rows = [
    // 启动链场景：清扫脚本(701)的祖先 700 带着派工标记且父已死
    { pid: 700, ppid: 7777, createdMs: 1000, cmdline: DISPATCH },
    { pid: 701, ppid: 700, createdMs: 1100, cmdline: 'node scripts/sweep-orphan-agents.mjs' },
  ];
  assert.deepEqual(identifyOrphanAgents(rows, { selfPid: 701 }), []);
});

test('快照解析：cmdline 内的竖线原样保留，坏行跳过，坏时间降级为 0', () => {
  const text = [
    '4242|100|1755000000000|node a.js --flag "x|y"',
    '',
    'garbage-without-delimiters',
    '98|abc|0|cmd', // ppid 非数字 → 整行跳过
    '99|100|xyz|cmd', // createdMs 非数字 → 降级为 0
  ].join('\n');
  const rows = parseSnapshotLines(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { pid: 4242, ppid: 100, createdMs: 1755000000000, cmdline: 'node a.js --flag "x|y"' });
  assert.deepEqual(rows[1], { pid: 99, ppid: 100, createdMs: 0, cmdline: 'cmd' });
});
