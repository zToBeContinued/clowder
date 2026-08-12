#!/usr/bin/env node
/**
 * 个人 Redis 管理（跨平台 Node 版；原 user-redis.sh 依赖 bash/redis-cli）。
 * status/backup/stop 走 Redis 协议（ioredis，无需 redis-cli）；start 需要
 * PATH 中有 redis-server（Windows 可用 Memurai/redis-windows）。
 *
 * Usage: node scripts/user-redis.mjs <start|stop|status|backup>
 * Env:   USER_REDIS_PORT (6401) / USER_REDIS_PROFILE (user)
 *        USER_REDIS_DATA_DIR / USER_REDIS_BACKUP_DIR / USER_REDIS_DBFILE
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// ioredis 是 packages/api 的依赖，从那里解析（根目录直接 require 会失败）
const requireFromApi = createRequire(join(projectDir, 'packages', 'api', 'package.json'));
const { Redis } = requireFromApi('ioredis');

const action = process.argv[2] ?? 'status';
const port = Number(process.env.USER_REDIS_PORT ?? 6401);
const profile = process.env.USER_REDIS_PROFILE ?? 'user';
const dataDir = process.env.USER_REDIS_DATA_DIR ?? join(homedir(), '.cat-cafe', `redis-${profile}`);
const backupDir = process.env.USER_REDIS_BACKUP_DIR ?? join(homedir(), '.cat-cafe', 'redis-backups', profile);
const dbfile = process.env.USER_REDIS_DBFILE ?? 'dump.rdb';

function connect() {
  const redis = new Redis({
    port,
    host: '127.0.0.1',
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
  });
  redis.on('error', () => {
    /* 连接失败按 stopped 处理，不让 ioredis 向控制台喷未处理错误 */
  });
  return redis;
}

async function isRunning() {
  const redis = connect();
  try {
    await redis.connect();
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function backupSnapshot(reason = 'manual') {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });

  let source = '';
  if (await isRunning()) {
    const redis = connect();
    try {
      await redis.connect();
      await redis.bgsave().catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      const [, dir] = await redis.config('GET', 'dir');
      const [, name] = await redis.config('GET', 'dbfilename');
      if (dir && name) source = join(dir, name);
    } catch {
      /* fall through to local file */
    } finally {
      redis.disconnect();
    }
  }
  if (!source) source = join(dataDir, dbfile);
  if (!existsSync(source)) {
    console.log('[user-redis] no dump file found for snapshot');
    return;
  }
  const target = join(backupDir, `${profile}-${reason}-${timestamp()}.rdb`);
  copyFileSync(source, target);
  console.log(`[user-redis] snapshot saved: ${target}`);
}

async function status() {
  if (!(await isRunning())) {
    console.log(`[user-redis] stopped (port ${port})`);
    console.log(`[user-redis] data dir: ${dataDir}`);
    console.log(`[user-redis] REDIS_URL=redis://127.0.0.1:${port}`);
    process.exitCode = 1;
    return;
  }
  const redis = connect();
  await redis.connect();
  const [, dir] = await redis.config('GET', 'dir');
  const [, name] = await redis.config('GET', 'dbfilename');
  const [, appendonly] = await redis.config('GET', 'appendonly');
  const dbsize = await redis.dbsize();
  redis.disconnect();
  console.log('[user-redis] running');
  console.log(`  profile:    ${profile}`);
  console.log(`  port:       ${port}`);
  console.log(`  dbsize:     ${dbsize}`);
  console.log(`  dir:        ${dir}`);
  console.log(`  dbfilename: ${name}`);
  console.log(`  appendonly: ${appendonly}`);
  console.log(`  REDIS_URL:  redis://127.0.0.1:${port}`);
}

async function start() {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(backupDir, { recursive: true });
  if (await isRunning()) {
    console.log(`[user-redis] already running on port ${port}`);
    await status();
    return;
  }
  await backupSnapshot('pre-start');
  const args = [
    '--port',
    String(port),
    '--bind',
    '127.0.0.1',
    '--dir',
    dataDir,
    '--dbfilename',
    dbfile,
    '--save',
    '3600 1 300 100 60 10000',
    '--appendonly',
    'yes',
    '--appendfilename',
    'appendonly.aof',
    '--appendfsync',
    'everysec',
    '--logfile',
    join(dataDir, `redis-${port}.log`),
  ];
  // Windows 的 redis-server 无 --daemonize，统一用 detached 子进程实现常驻
  const child = spawn('redis-server', args, { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
  child.on('error', () => {
    console.error('[user-redis] redis-server not found — Windows 可安装 Memurai 或 redis-windows 并加入 PATH');
    process.exit(127);
  });
  child.unref();

  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isRunning()) break;
  }
  if (!(await isRunning())) {
    console.error(`[user-redis] failed to start on port ${port}`);
    process.exit(1);
  }
  await status();
}

async function stop() {
  if (!(await isRunning())) {
    console.log(`[user-redis] already stopped (port ${port})`);
    return;
  }
  await backupSnapshot('pre-stop');
  const redis = connect();
  await redis.connect();
  await redis.shutdown('SAVE').catch(() => {
    /* shutdown 会断开连接，报错属预期 */
  });
  redis.disconnect();
  console.log(`[user-redis] stopped (port ${port})`);
}

const actions = { start, stop, status, backup: () => backupSnapshot('manual') };
const handler = actions[action];
if (!handler) {
  console.error('Usage: node scripts/user-redis.mjs <start|stop|status|backup>');
  process.exit(2);
}
await handler();
