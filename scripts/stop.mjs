#!/usr/bin/env node
/**
 * 跨平台停止 Clowder 服务（原 `pnpm stop` 走 start-dev.sh --stop，Windows 不可用）。
 * 按端口找监听进程，校验命令行归属本项目后杀进程树；防止误杀恰好占用同端口的
 * 无关进程。
 *
 * Usage: pnpm stop  /  node scripts/stop.mjs
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDotEnvValues } from './lib/platform-status.mjs';
import { commandLineOfPid, killPidTree, listenerPid } from './lib/port-utils.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = readDotEnvValues(resolve(projectRoot, '.env'));

const targets = [
  { name: 'API', port: Number(env.API_SERVER_PORT ?? 3004) },
  { name: 'Frontend', port: Number(env.FRONTEND_PORT ?? 3003) },
  ...(Number(env.PREVIEW_GATEWAY_PORT ?? 4100) > 0
    ? [{ name: 'Preview Gateway', port: Number(env.PREVIEW_GATEWAY_PORT ?? 4100) }]
    : []),
  ...((env.ANTHROPIC_PROXY_ENABLED ?? '1') !== '0'
    ? [{ name: 'Anthropic Proxy', port: Number(env.ANTHROPIC_PROXY_PORT ?? 9877) }]
    : []),
];

const projectMarker = projectRoot.replace(/\\/g, '\\').toLowerCase();
let stopped = 0;
let skipped = 0;

for (const target of targets) {
  const pid = listenerPid(target.port);
  if (!pid) {
    console.log(`  -    ${target.name} 端口 ${target.port}：未监听`);
    continue;
  }
  const cmdline = (commandLineOfPid(pid) ?? '').toLowerCase();
  const owned =
    cmdline.includes(projectMarker) || cmdline.includes('clowder') || cmdline.includes('cat-cafe') || cmdline === '';
  if (!owned) {
    console.log(`  SKIP ${target.name} 端口 ${target.port}：pid=${pid} 不属于本项目（${cmdline.slice(0, 80)}）`);
    skipped++;
    continue;
  }
  const ok = killPidTree(pid);
  console.log(`  ${ok ? 'OK  ' : 'ERR '} ${target.name} 端口 ${target.port}：pid=${pid} ${ok ? '已停止' : '停止失败'}`);
  if (ok) stopped++;
}

console.log('');
console.log(`已停止 ${stopped} 个服务${skipped > 0 ? `，跳过 ${skipped} 个非本项目进程` : ''}。`);
