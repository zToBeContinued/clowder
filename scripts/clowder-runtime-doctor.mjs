#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cwdOfPid, listenerPid } from './lib/port-utils.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');

function readEnvValue(key, fallback) {
  const envFile = resolve(projectRoot, '.env');
  if (!existsSync(envFile)) return fallback;
  const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) continue;
    return match[2].replace(/^['"]|['"]$/g, '') || fallback;
  }
  return fallback;
}

const frontendPort = Number(readEnvValue('FRONTEND_PORT', '3003'));
const apiPort = Number(readEnvValue('API_SERVER_PORT', '3004'));
const apiBearerToken = process.env.CLOWDER_API_BEARER_TOKEN || readEnvValue('CLOWDER_API_BEARER_TOKEN', '');
const uploadDirSetting = readEnvValue('UPLOAD_DIR', '');
const effectiveUploadDir =
  uploadDirSetting === './uploads'
    ? resolve(projectRoot, 'packages/api/uploads')
    : resolve((uploadDirSetting || '~/.cat-cafe/uploads').replace(/^~(?=$|\/)/, homedir()));

const results = [];

function add(ok, label, detail = '') {
  results.push({ ok, label, detail });
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      ...(apiBearerToken && url.includes('/api/') ? { headers: { authorization: `Bearer ${apiBearerToken}` } } : {}),
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, contentType: res.headers.get('content-type') || '' };
  } catch (err) {
    return { ok: false, status: 0, text: String(err), contentType: '' };
  }
}

const webPid = listenerPid(frontendPort);
const apiPid = listenerPid(apiPort);
const webCwd = cwdOfPid(webPid);
const apiCwd = cwdOfPid(apiPid);

add(Boolean(webPid), `Web 端口 ${frontendPort}`, webPid ? `pid=${webPid}` : '未监听');
add(Boolean(apiPid), `API 端口 ${apiPort}`, apiPid ? `pid=${apiPid}` : '未监听');
// Windows 不提供进程 cwd（cwdOfPid 返回 null）——跳过而非误报
if (webCwd !== null) add(webCwd.startsWith(projectRoot), 'Web 启动目录', webCwd || '无法识别');
if (apiCwd !== null) add(apiCwd.startsWith(projectRoot), 'API 启动目录', apiCwd || '无法识别');

const envPath = resolve(projectRoot, '.env');
const catalogPath = resolve(projectRoot, '.cat-cafe/cat-catalog.json');
const legacyUploadsPath = resolve(projectRoot, 'packages/api/uploads');
const uploadsPath = effectiveUploadDir;
// .env 与 uploads 都是可选资源：无 .env = 按代码默认值运行（合法形态）；
// uploads 目录懒创建。缺失只提示，不计入失败——否则默认值环境永远体检不过。
add(true, '.env', existsSync(envPath) ? '存在' : '未创建（按默认值运行）');
add(existsSync(catalogPath), '.cat-cafe/cat-catalog.json', existsSync(catalogPath) ? '存在' : '缺失');
if (existsSync(legacyUploadsPath)) {
  add(
    lstatSync(legacyUploadsPath).isSymbolicLink(),
    'packages/api/uploads symlink',
    `${legacyUploadsPath} -> ${uploadsPath}`,
  );
}
add(
  true,
  'uploads 目录',
  existsSync(uploadsPath)
    ? `${readdirSync(uploadsPath).length} 个条目：${uploadsPath}`
    : `未创建（首次上传时生成）：${uploadsPath}`,
);

if (existsSync(catalogPath)) {
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const rosterCount = Array.isArray(catalog.roster)
      ? catalog.roster.length
      : Object.keys(catalog.roster || {}).length;
    add(rosterCount > 0, '本地 Agent catalog', `${rosterCount} 个 roster 条目`);
  } catch (err) {
    add(false, '本地 Agent catalog', `解析失败：${err.message}`);
  }
}

const ready = await fetchText(`http://localhost:${apiPort}/api/ready`);
add(ready.ok, '/api/ready', ready.ok ? `HTTP ${ready.status}` : ready.text);

const cats = await fetchText(`http://localhost:${apiPort}/api/cats`);
if (cats.ok) {
  try {
    const payload = JSON.parse(cats.text);
    const list = Array.isArray(payload) ? payload : payload.cats || payload.data || [];
    add(list.length > 0, '/api/cats', `${list.length} 个 Agent`);
  } catch (err) {
    add(false, '/api/cats', `JSON 解析失败：${err.message}`);
  }
} else {
  add(false, '/api/cats', cats.text);
}

const html = await fetchText(`http://localhost:${frontendPort}/`);
add(html.ok, 'Web 首页', html.ok ? `HTTP ${html.status}` : html.text);
if (html.ok) {
  add(
    html.text.includes('data-visual-theme="slock"'),
    '默认 Slock 主题',
    html.text.includes('data-visual-theme="slock"') ? '首屏已注入' : '首屏未注入',
  );
}

console.log('Clowder Runtime Doctor');
console.log('======================');
for (const item of results) {
  console.log(`${item.ok ? 'OK ' : 'ERR'} ${item.label}${item.detail ? ` — ${item.detail}` : ''}`);
}

const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
  console.log('');
  console.log(`发现 ${failed.length} 个问题。建议从正确目录执行：`);
  console.log(`cd ${projectRoot}`);
  console.log('pnpm start:direct -- --daemon');
  process.exit(1);
}

console.log('');
console.log('运行态完整：Web/API/Agent/主题/本地资源均可用。');
