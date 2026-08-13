#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sweepStaleTestTemp } from '../test/helpers/sweep-stale-test-temp.js';
import { CI_TIERS, selectTests } from './select-ci-tests.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(SCRIPT_DIR, '..');
const WITH_TEST_HOME = resolve(SCRIPT_DIR, 'with-test-home.sh');
const ISOLATED_REDIS_HARNESS = resolve(SCRIPT_DIR, 'run-isolated-redis-tests.sh');
const SETUP_IMPORT = resolve(API_DIR, 'test/helpers/setup-cat-registry.js');
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TIMEOUT_MS = 120_000;

function parsePositiveInteger(value, flag) {
  if (!/^\d+$/u.test(value) || Number(value) < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return Number(value);
}

function parseValueOption(args, index) {
  const argument = args[index];
  const separatorIndex = argument.indexOf('=');
  const flag = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
  const inlineValue = separatorIndex === -1 ? null : argument.slice(separatorIndex + 1);
  const supportedFlags = new Set(['--tier', '--concurrency', '--timeout']);
  if (!supportedFlags.has(flag)) {
    throw new Error(`unknown argument "${argument}"`);
  }

  const value = inlineValue ?? args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return { flag, value, consumed: inlineValue === null ? 2 : 1 };
}

function applyRunnerOption(options, { flag, value }) {
  if (flag === '--tier') return { ...options, tier: value };
  if (flag === '--concurrency') {
    return { ...options, concurrency: parsePositiveInteger(value, flag) };
  }
  return { ...options, timeoutMs: parsePositiveInteger(value, flag) };
}

export function parseRunnerArgs(args) {
  let options = { tier: 'core', concurrency: DEFAULT_CONCURRENCY, timeoutMs: DEFAULT_TIMEOUT_MS };

  for (let index = 0; index < args.length; ) {
    if (args[index] === '--') {
      index += 1;
      continue;
    }
    const parsed = parseValueOption(args, index);
    options = applyRunnerOption(options, parsed);
    index += parsed.consumed;
  }

  if (!CI_TIERS.includes(options.tier)) {
    throw new Error(`unknown tier "${options.tier}"; expected one of ${CI_TIERS.join(', ')}`);
  }
  return options;
}

export function assertRunnerPreconditions({ tier, nodeVersion = process.versions.node, env = process.env }) {
  const nodeMajor = Number(nodeVersion.split('.')[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    throw new Error(`test lanes require Node.js >=20; received ${nodeVersion}`);
  }
  if (tier === 'external' && env.RUN_EXTERNAL_TESTS !== '1') {
    throw new Error('external lane requires RUN_EXTERNAL_TESTS=1');
  }
}

// Windows CreateProcess 命令行上限约 32767 字符；留出 node 路径与固定参数的余量。
const WIN_ARG_BUDGET = 24_000;

// 按累计长度把文件列表切成多批，保证每批命令行不超预算。
export function chunkByArgLength(files, budget = WIN_ARG_BUDGET) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const file of files) {
    const cost = file.length + 1; // +1 近似分隔空格
    if (current.length > 0 && length + cost > budget) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Node 等价的 with-test-home.sh：无 bash 的环境（如未装 Git Bash 的 Windows）用它
// 构造隔离沙箱环境，确保测试不触碰真实 HOME/~/.cat-cafe，并复刻 shell 版的同款语义。
function createIsolatedHomeEnv(baseEnv) {
  // 自愈清扫上一轮残留(硬杀/崩溃时 finally 不执行,%TEMP% 会积垃圾)
  try {
    sweepStaleTestTemp();
  } catch {
    /* 清扫失败绝不影响测试 */
  }
  const realHome = baseEnv.HOME ?? baseEnv.USERPROFILE ?? homedir();
  const testHome = mkdtempSync(join(tmpdir(), 'cat-cafe-test-home-'));
  const env = {
    ...baseEnv,
    HOME: testHome,
    USERPROFILE: testHome, // Windows 上 os.homedir() 读 USERPROFILE
    CAT_CAFE_TEST_SANDBOX: baseEnv.CAT_CAFE_TEST_SANDBOX ?? '1',
    CAT_CAFE_TEST_REAL_HOME: baseEnv.CAT_CAFE_TEST_REAL_HOME ?? realHome,
    NODE_ENV: 'test',
  };
  delete env.CAT_CAFE_RUNTIME_ROOT;
  delete env.CAT_CAFE_MCP_SERVER_PATH;
  delete env.CAT_CAFE_WORKSPACE_ROOT;
  return {
    env,
    cleanup: () => {
      try {
        rmSync(testHome, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`node:test terminated by signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

export function buildLaneSpawnSpec({ tier, nodeBinary = process.execPath, nodeArgs }) {
  const testCommand = [nodeBinary, ...nodeArgs];
  if (tier === 'redis') {
    return {
      command: 'bash',
      args: [WITH_TEST_HOME, 'bash', ISOLATED_REDIS_HARNESS, '--', ...testCommand],
    };
  }
  return {
    command: 'bash',
    args: [WITH_TEST_HOME, ...testCommand],
  };
}

export async function runTestLane(args = process.argv.slice(2)) {
  const options = parseRunnerArgs(args);
  assertRunnerPreconditions(options);

  const selection = await selectTests({ tier: options.tier, testDir: resolve(API_DIR, 'test') });
  if (selection.selected.length === 0) {
    throw new Error(`tier "${options.tier}" selected zero test files`);
  }

  const testFiles = selection.selected.map(({ absolutePath }) => absolutePath);
  const nodeArgsPrefix = [
    '--import',
    // Windows 上 node --import 只接受 file:// URL，不接受 "D:\..." 绝对路径（会被当成 scheme 'd:'）。
    // pathToFileURL 在 Unix/Windows 通用，故统一转换。
    pathToFileURL(SETUP_IMPORT).href,
    '--test',
    `--test-concurrency=${options.concurrency}`,
    `--test-timeout=${options.timeoutMs}`,
  ];
  const nodeArgs = [...nodeArgsPrefix, ...testFiles];

  process.stdout.write(
    `[test-lane] tier=${options.tier} files=${testFiles.length} concurrency=${options.concurrency} timeout=${options.timeoutMs} node=${process.versions.node}\n`,
  );

  const baseEnv = {
    ...process.env,
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
  };

  const spawnSpec = buildLaneSpawnSpec({ tier: options.tier, nodeArgs });
  let exitCode;
  try {
    exitCode = await waitForChild(
      spawn(spawnSpec.command, spawnSpec.args, { cwd: API_DIR, env: baseEnv, stdio: 'inherit' }),
    );
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // bash 不可用。redis lane 还依赖 run-isolated-redis-tests.sh，无法用 node 直跑。
    if (options.tier === 'redis') {
      throw new Error(
        'redis lane requires bash (with-test-home.sh + run-isolated-redis-tests.sh); install Git Bash to run it on this platform',
      );
    }
    // 用相对路径并分批，规避 Windows ~32KB 命令行长度限制（900 个绝对路径会 ENAMETOOLONG）。
    const relFiles = testFiles.map((f) => relative(API_DIR, f));
    const batches = chunkByArgLength(relFiles, WIN_ARG_BUDGET);
    process.stdout.write(
      `[test-lane] bash unavailable; running node directly in ${batches.length} batch(es) with isolated HOME sandbox\n`,
    );
    const { env, cleanup } = createIsolatedHomeEnv(baseEnv);
    try {
      exitCode = 0;
      for (let i = 0; i < batches.length; i++) {
        process.stdout.write(`[test-lane] batch ${i + 1}/${batches.length} (${batches[i].length} files)\n`);
        const code = await waitForChild(
          spawn(process.execPath, [...nodeArgsPrefix, ...batches[i]], { cwd: API_DIR, env, stdio: 'inherit' }),
        );
        if (code !== 0) exitCode = code; // 记录失败但跑完所有批次以拿到完整结果
      }
    } finally {
      cleanup();
    }
  }

  if (exitCode !== 0) {
    throw new Error(`node:test exited with code ${exitCode}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runTestLane().catch((error) => {
    process.stderr.write(`[test-lane] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
