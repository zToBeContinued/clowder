import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

const [cmd, ...args] = process.argv.slice(2);

if (!cmd) {
  console.error('Usage: node scripts/run-with-node-env-test.mjs <cmd> [...args]');
  process.exit(1);
}

// 从 bin 所属包的 package.json 读取 bin 字段，定位其 JS 入口，用 node 直接运行。
function resolveBinEntry(binName) {
  const pkgJsonPath = require.resolve(`${binName}/package.json`);
  const pkg = require(pkgJsonPath);
  const binField = pkg.bin;
  const relEntry = typeof binField === 'string' ? binField : binField?.[binName];
  if (!relEntry) throw new Error(`cannot resolve bin entry for "${binName}"`);
  return resolve(dirname(pkgJsonPath), relEntry);
}

// Windows 上没有裸 `pnpm` 可执行文件（实际是 pnpm.cmd），且 Node 出于安全默认不直接 spawn .cmd，
// 因此 `spawn('pnpm', ...)` 会 ENOENT。`pnpm exec <bin>` 本质就是运行本地安装的 bin，这里在 Windows
// 上把它翻译成 `node <bin 的 JS 入口>`，语义等价，同时绕开 pnpm.cmd 与 shell 对路径中括号的引号问题。
// Unix/CI 行为完全不变。
let spawnCmd = cmd;
let spawnArgs = args;
if (process.platform === 'win32' && cmd === 'pnpm' && args[0] === 'exec') {
  spawnCmd = process.execPath;
  spawnArgs = [resolveBinEntry(args[1]), ...args.slice(2)];
}

const child = spawn(spawnCmd, spawnArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
  },
});

child.on('error', (error) => {
  console.error(`run-with-node-env-test: failed to spawn ${spawnCmd}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
