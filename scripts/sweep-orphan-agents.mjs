#!/usr/bin/env node
/**
 * 清扫孤儿 agent 进程（2026-08-12 quant「幽灵写手」事故的启动/停机兜底）。
 *
 * 谁会变成孤儿：API 被硬杀（Stop-Job / Stop-Process / 点窗口 X / 崩溃）时，
 * 它派工出去的 CLI agent（cursor-agent/claude/codex/…，常隔着 .ps1/.cmd 包装
 * 进程）与 kiro-cli acp carrier 不会随之死亡，继续持有目标项目的写权限。
 *
 * 识别（两条都要满足，宁漏勿错杀）：
 *   1. 命令行带 Clowder 标记：派工 prompt 的 "Dispatch Mission Context"
 *      （所有 CLI provider 的 prompt 都经 argv 传递，包装进程 argv 同样含有），
 *      或 kiro-cli 的 ACP 入口 `kiro-cli acp`（用户交互式 `kiro-cli chat` 不匹配）。
 *   2. 是孤儿：父进程已不存在，或父进程晚于自己创建（PID 复用）。父链健在
 *      说明它属于某个仍在运行的 Clowder 实例（如另一个 worktree），不动。
 *
 * 用法：node scripts/sweep-orphan-agents.mjs [--dry-run]
 * 退出码恒为 0（清扫失败绝不阻塞启动/停机主流程）。
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { killPidTree } from './lib/port-utils.mjs';

const IS_WINDOWS = process.platform === 'win32';

const DISPATCH_MARKER = 'Dispatch Mission Context';
const KIRO_ACP_PATTERN = /kiro-cli(\.exe)?["']?\s+(["']?)acp\2(\s|$)/i;

/** @typedef {{ pid: number, ppid: number, createdMs: number, cmdline: string }} ProcessRow */

/** 命令行是否带 Clowder agent 标记 */
export function isClowderAgentCommandLine(cmdline) {
  if (!cmdline) return false;
  return cmdline.includes(DISPATCH_MARKER) || KIRO_ACP_PATTERN.test(cmdline);
}

/**
 * 从进程表中找出应清扫的孤儿 agent。
 * 纯函数，便于回归测试；不排序、不去重子树（killPidTree /T 对已死 PID 容错）。
 *
 * @param {readonly ProcessRow[]} rows 全量进程表快照
 * @param {{ selfPid?: number }} [options] selfPid 及其祖先链绝不清扫
 * @returns {Array<{ pid: number, reason: string }>}
 */
export function identifyOrphanAgents(rows, options = {}) {
  const byPid = new Map(rows.map((row) => [row.pid, row]));

  // 自己的祖先链（清扫脚本运行在启动链里，绝不能反噬）
  const protectedPids = new Set();
  let cursor = options.selfPid;
  while (cursor !== undefined && byPid.has(cursor) && !protectedPids.has(cursor)) {
    protectedPids.add(cursor);
    cursor = byPid.get(cursor)?.ppid;
  }

  const orphans = [];
  for (const row of rows) {
    if (protectedPids.has(row.pid)) continue;
    if (!isClowderAgentCommandLine(row.cmdline)) continue;

    const parent = byPid.get(row.ppid);
    if (!parent) {
      orphans.push({ pid: row.pid, reason: `父进程 ${row.ppid} 已不存在` });
      continue;
    }
    // PID 复用：占着父 PID 的进程比自己还年轻，真正的父早已死亡
    if (row.createdMs > 0 && parent.createdMs > 0 && parent.createdMs > row.createdMs) {
      orphans.push({ pid: row.pid, reason: `父 PID ${row.ppid} 已被更晚创建的进程复用` });
    }
  }
  return orphans;
}

/** Windows：一次 CIM 查询取全量 pid/ppid/创建时间/命令行 */
function snapshotWindows() {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { ' +
    "'{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, " +
    '$(if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }), ' +
    "(($_.CommandLine) -replace '[\\r\\n]', ' ') }";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return parseSnapshotLines(out, (raw) => raw);
}

/** POSIX：ps 全表；etimes（存活秒数）换算创建时间，避免 lstart 的 locale 坑 */
function snapshotPosix() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etimes=,args='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const now = Date.now();
  const rows = [];
  for (const line of out.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      createdMs: now - Number(match[3]) * 1000,
      cmdline: match[4] ?? '',
    });
  }
  return rows;
}

/** 解析 'pid|ppid|createdMs|cmdline' 行（cmdline 内的 | 原样保留） */
export function parseSnapshotLines(text, normalize = (s) => s) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const first = trimmed.indexOf('|');
    const second = trimmed.indexOf('|', first + 1);
    const third = trimmed.indexOf('|', second + 1);
    if (first < 0 || second < 0 || third < 0) continue;
    const pid = Number(trimmed.slice(0, first));
    const ppid = Number(trimmed.slice(first + 1, second));
    const createdMs = Number(trimmed.slice(second + 1, third));
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({
      pid,
      ppid,
      createdMs: Number.isFinite(createdMs) ? createdMs : 0,
      cmdline: normalize(trimmed.slice(third + 1)),
    });
  }
  return rows;
}

/** 执行清扫；返回清扫数量。清扫失败只告警，不抛出。 */
export function sweepOrphanAgents({ dryRun = false, log = console.log } = {}) {
  let rows;
  try {
    rows = IS_WINDOWS ? snapshotWindows() : snapshotPosix();
  } catch (error) {
    log(`  [!!] 进程表快照失败，跳过孤儿清扫：${error?.message ?? error}`);
    return 0;
  }

  const orphans = identifyOrphanAgents(rows, { selfPid: process.pid });
  if (orphans.length === 0) {
    log('  [OK] 无孤儿 agent 进程');
    return 0;
  }

  let swept = 0;
  for (const orphan of orphans) {
    if (dryRun) {
      log(`  [DRY] 待清扫孤儿 agent pid=${orphan.pid}（${orphan.reason}）`);
      continue;
    }
    const ok = killPidTree(orphan.pid);
    log(`  [${ok ? 'OK' : '!!'}] 清扫孤儿 agent pid=${orphan.pid} 整树${ok ? '成功' : '失败'}（${orphan.reason}）`);
    if (ok) swept++;
  }
  return swept;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  sweepOrphanAgents({ dryRun });
  process.exit(0);
}
