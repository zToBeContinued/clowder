#!/usr/bin/env node
/**
 * F130 Phase C: Log health check — disk usage, retention, anomaly count.
 * 跨平台 Node 版（原 logs-health.sh 依赖 du/find/awk/stat -f，Windows 不可用）。
 * Usage: pnpm logs:health [apiDataDir] [projectDataDir]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const apiDataDir = process.argv[2] ?? 'packages/api/data';
const projectDataDir = process.argv[3] ?? 'data';

const LAYERS = [
  { name: 'Runtime', dir: join(apiDataDir, 'logs', 'api'), retentionDays: 14 },
  { name: 'Process', dir: join(projectDataDir, 'logs', 'process'), retentionDays: 7 },
  { name: 'Audit', dir: join(apiDataDir, 'audit-logs'), retentionDays: 90 },
  { name: 'Forensics', dir: join(apiDataDir, 'cli-raw-archive'), retentionDays: 7 },
];
const WARN_DISK_MB = 500;

let issues = 0;

function walkFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function checkLayer({ name, dir, retentionDays }) {
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    console.log(`  ${name.padEnd(14)} ${dir.padEnd(32)} — (not created yet)`);
    return;
  }
  const files = walkFiles(abs);
  let totalBytes = 0;
  let oldestMtime = Number.POSITIVE_INFINITY;
  for (const file of files) {
    try {
      const st = statSync(file);
      totalBytes += st.size;
      if (st.mtimeMs < oldestMtime) oldestMtime = st.mtimeMs;
    } catch {
      /* file may vanish mid-walk */
    }
  }
  const sizeMb = Math.round(totalBytes / (1024 * 1024));
  const oldestDays = files.length > 0 ? Math.floor((Date.now() - oldestMtime) / 86_400_000) : 0;

  let status = 'OK';
  if (sizeMb > WARN_DISK_MB) {
    status = `WARN exceeds ${WARN_DISK_MB}MB`;
    issues++;
  }
  let ageNote = '';
  if (oldestDays > retentionDays) {
    ageNote = ` (oldest: ${oldestDays}d > ${retentionDays}d retention)`;
    issues++;
  }
  console.log(
    `  ${name.padEnd(14)} ${String(sizeMb).padStart(4)} MB  ${String(files.length).padStart(5)} files  ${status}${ageNote}`,
  );
}

function checkErrorRate(runtimeLogDir) {
  const logFile = resolve(runtimeLogDir, 'api.log');
  if (!existsSync(logFile)) return;
  const cutoffMs = Date.now() - 60 * 60 * 1000;
  let errorCount = 0;
  // api.log 可能上百 MB——只读末尾 8MB 足以覆盖近一小时
  const st = statSync(logFile);
  const readFrom = Math.max(0, st.size - 8 * 1024 * 1024);
  const content = readFileSync(logFile, 'utf8').slice(readFrom > 0 ? -8 * 1024 * 1024 : 0);
  for (const line of content.split(/\r?\n/)) {
    if (!line.includes('"level":50')) continue;
    const match = line.match(/"time":(\d{10,})/) ?? line.match(/"time":"([^"]+)"/);
    if (!match) continue;
    const ts = Number(match[1]) || Date.parse(match[1]);
    if (Number.isFinite(ts) && ts >= cutoffMs) errorCount++;
  }
  if (errorCount > 100) {
    console.log(`\n  WARN High error rate: ${errorCount} errors in last hour`);
    issues++;
  } else if (errorCount > 0) {
    console.log(`\n  Errors in last hour: ${errorCount}`);
  }
}

console.log('');
console.log('🐾 Cat Café Log Health Check (F130)');
console.log('────────────────────────────────────');
console.log('');
console.log('  Layer          Size     Files  Status');
console.log('  ─────          ────     ─────  ──────');
for (const layer of LAYERS) checkLayer(layer);
checkErrorRate(LAYERS[0].dir);

console.log('');
console.log('  Config');
console.log('  ──────');
console.log(`  LOG_LEVEL:     ${process.env.LOG_LEVEL ?? 'info (default)'}`);
for (const layer of LAYERS) console.log(`  ${(layer.name + ' dir:').padEnd(15)}${layer.dir}`);
console.log('');

if (issues > 0) {
  console.log(`  WARN ${issues} issue(s) found — check warnings above`);
  console.log('');
  process.exit(1);
}
console.log('  OK All log layers healthy');
console.log('');
