#!/usr/bin/env node
/**
 * Clowder 平台单次巡检(patrol)——供任何 AI/人类周期性调用的健康检查与自愈入口。
 *
 * 源自 2026-08-12/13 通宵实战沉淀(幽灵写手/假超时/队列停摆事故),完整方法论
 * 见 docs/diag-patrol-loop.md。设计原则:
 *   - 默认只读取证,绝不打扰在途工作(有活跃调用时永不重启、永不补发);
 *   - 唯一的自动修复动作是队列停摆时的 queue/next 推进,且需显式 --unblock;
 *   - 输出人类可读摘要,--json 给机器,退出码给循环脚本分支(0 绿/1 黄/2 红)。
 *
 * 用法:
 *   node scripts/patrol-clowder.mjs [--thread <threadId>] [--unblock] [--json]
 *   pnpm diag:patrol
 *
 * 巡检项:API/前端端口 → 各 thread 队列与活跃调用 → 最近调用活动 →
 *        api.log 高级别错误 → 孤儿 agent 进程(dry-run)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readDotEnvValues } from './lib/platform-status.mjs';
import { listenerPid } from './lib/port-utils.mjs';
import { sweepOrphanAgents } from './sweep-orphan-agents.mjs';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** 停摆判定的静默阈值:0 活跃 + 有排队,且最近调用文件超过该分钟数无写入 */
const STALL_SILENCE_MINUTES = 2;
/** api.log 错误扫描窗口(分钟) */
const ERROR_WINDOW_MINUTES = 12;

/**
 * 纯判定函数(可测):汇总巡检状态 → 结论与建议动作。
 * 动作 kind:restart / queue-next / inspect-errors / sweep-orphans。
 */
export function assessPatrol(state) {
  const actions = [];
  let verdict = 'healthy';

  if (!state.apiUp || !state.webUp) {
    verdict = 'critical';
    actions.push({
      kind: 'restart',
      hint: '服务端口未监听。先 node scripts/stop.mjs,再在带代理环境(HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:7890, NO_PROXY=localhost,127.0.0.1,::1)的独立窗口跑 node scripts/start-entry.mjs start --debug --quick',
    });
    return { verdict, actions };
  }

  const stalled =
    state.activeCount === 0 && state.queuedCount > 0 && state.minutesSinceLastInvocationWrite >= STALL_SILENCE_MINUTES;
  if (stalled) {
    verdict = 'stalled';
    actions.push({
      kind: 'queue-next',
      hint: 'POST /api/threads/{threadId}/queue/next (Content-Type: application/json, body {}) 推进队列;本脚本加 --unblock 可自动执行',
    });
  }

  if (state.recentErrorCount > 0) {
    if (verdict === 'healthy') verdict = 'warning';
    actions.push({
      kind: 'inspect-errors',
      hint: `api.log 最近 ${ERROR_WINDOW_MINUTES} 分钟有 ${state.recentErrorCount} 条高级别错误,读 packages/api/data/logs/api/api.log 取证(level>=50 的行含原始 stderr)`,
    });
  }

  if (state.orphanCount > 0) {
    if (verdict === 'healthy') verdict = 'warning';
    actions.push({
      kind: 'sweep-orphans',
      hint: `发现 ${state.orphanCount} 个孤儿 agent 进程,执行 node scripts/sweep-orphan-agents.mjs 清扫(先 --dry-run 复核)`,
    });
  }

  return { verdict, actions };
}

function checkPorts(env) {
  const apiPort = Number(env.API_SERVER_PORT ?? 3004);
  const webPort = Number(env.FRONTEND_PORT ?? 3003);
  return {
    apiPort,
    webPort,
    apiUp: Boolean(listenerPid(apiPort)),
    webUp: Boolean(listenerPid(webPort)),
  };
}

async function fetchJson(url, userId) {
  const res = await fetch(url, { headers: { 'x-cat-cafe-user': userId }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

/** 各 thread 的队列/活跃统计(指定 --thread 时只查该 thread) */
async function checkQueues(apiPort, userId, onlyThread) {
  const base = `http://127.0.0.1:${apiPort}`;
  let threadIds = [];
  if (onlyThread) {
    threadIds = [onlyThread];
  } else {
    const data = await fetchJson(`${base}/api/threads`, userId);
    const threads = Array.isArray(data) ? data : (data.threads ?? []);
    threadIds = threads.map((t) => t.id ?? t.threadId).filter(Boolean);
  }
  let queued = 0;
  let processing = 0;
  let active = 0;
  const stalledThreads = [];
  for (const threadId of threadIds) {
    try {
      const q = await fetchJson(`${base}/api/threads/${encodeURIComponent(threadId)}/queue`, userId);
      const entries = q.queue ?? [];
      const tQueued = entries.filter((e) => e.status === 'queued').length;
      const tActive = (q.activeInvocations ?? []).length;
      queued += tQueued;
      processing += entries.filter((e) => e.status === 'processing').length;
      active += tActive;
      if (tQueued > 0 && tActive === 0) stalledThreads.push(threadId);
    } catch {
      // 单个 thread 查询失败不阻塞整体巡检
    }
  }
  return { queued, processing, active, stalledThreads, threadCount: threadIds.length };
}

/** 最近一次 invocation 日志写入距今的分钟数(无日志则 Infinity) */
function minutesSinceLastInvocationWrite() {
  const root = join(projectRoot, 'packages', 'api', 'data', 'logs', 'invocations');
  let newest = 0;
  let dirs = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  for (const dir of dirs) {
    let files = [];
    try {
      files = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const m = statSync(join(root, dir, f)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* ignore */
      }
    }
  }
  if (newest === 0) return Number.POSITIVE_INFINITY;
  return (Date.now() - newest) / 60_000;
}

/** api.log 尾部窗口内 level>=50 的错误条数与样例 */
function scanRecentErrors() {
  const logPath = join(projectRoot, 'packages', 'api', 'data', 'logs', 'api', 'api.log');
  let size;
  try {
    size = statSync(logPath).size;
  } catch {
    return { count: 0, samples: [] };
  }
  const window = 500_000;
  const buf = readFileSync(logPath).subarray(Math.max(0, size - window));
  const since = Date.now() - ERROR_WINDOW_MINUTES * 60_000;
  const samples = [];
  let count = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    try {
      const j = JSON.parse(line);
      if (j.level >= 50 && j.time > since) {
        count++;
        if (samples.length < 5) samples.push(`${new Date(j.time).toISOString()} ${(j.msg ?? '').slice(0, 90)}`);
      }
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return { count, samples };
}

/** 孤儿 agent 计数(dry-run,不动手) */
function countOrphans() {
  let count = 0;
  sweepOrphanAgents({
    dryRun: true,
    log: (line) => {
      if (String(line).includes('[DRY]')) count++;
    },
  });
  return count;
}

async function unblockThread(apiPort, userId, threadId, log) {
  const res = await fetch(`http://127.0.0.1:${apiPort}/api/threads/${encodeURIComponent(threadId)}/queue/next`, {
    method: 'POST',
    headers: { 'x-cat-cafe-user': userId, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  });
  log(`  [${res.ok ? 'OK' : '!!'}] queue/next ${threadId} → HTTP ${res.status}`);
  return res.ok;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const argValue = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const asJson = args.includes('--json');
  const unblock = args.includes('--unblock');
  const onlyThread = argValue('--thread');
  const userId = argValue('--user') ?? 'default-user';
  const log = asJson ? () => {} : console.log;

  const env = readDotEnvValues(resolve(projectRoot, '.env'));
  const ports = checkPorts(env);
  let queues = { queued: 0, processing: 0, active: 0, stalledThreads: [], threadCount: 0 };
  if (ports.apiUp) {
    try {
      queues = await checkQueues(ports.apiPort, userId, onlyThread);
    } catch (error) {
      log(`  [!!] 队列查询失败:${error?.message ?? error}`);
    }
  }
  const errors = scanRecentErrors();
  const orphanCount = countOrphans();
  const silenceMin = minutesSinceLastInvocationWrite();

  const state = {
    apiUp: ports.apiUp,
    webUp: ports.webUp,
    activeCount: queues.active,
    queuedCount: queues.queued,
    recentErrorCount: errors.count,
    orphanCount,
    minutesSinceLastInvocationWrite: silenceMin,
  };
  const result = assessPatrol(state);

  if (asJson) {
    console.log(JSON.stringify({ state, queues, errorSamples: errors.samples, ...result }, null, 2));
  } else {
    log(
      `端口: API(${ports.apiPort})=${ports.apiUp ? 'UP' : 'DOWN'} WEB(${ports.webPort})=${ports.webUp ? 'UP' : 'DOWN'}`,
    );
    log(
      `队列: queued=${queues.queued} processing=${queues.processing} active=${queues.active}(扫描 ${queues.threadCount} 个 thread)`,
    );
    log(`调用: 最近写入距今 ${silenceMin === Number.POSITIVE_INFINITY ? '∞' : silenceMin.toFixed(1)} 分钟`);
    log(`错误: 最近 ${ERROR_WINDOW_MINUTES} 分钟 level>=50 共 ${errors.count} 条`);
    for (const s of errors.samples) log(`  ${s}`);
    log(`孤儿: ${orphanCount} 个`);
    log(`结论: ${result.verdict}`);
    for (const a of result.actions) log(`  → [${a.kind}] ${a.hint}`);
  }

  if (unblock && result.verdict === 'stalled' && ports.apiUp) {
    log('执行 --unblock:推进停摆 thread 的队列');
    for (const threadId of queues.stalledThreads) {
      await unblockThread(ports.apiPort, userId, threadId, log);
    }
  }

  process.exit(result.verdict === 'healthy' ? 0 : result.verdict === 'critical' ? 2 : 1);
}
