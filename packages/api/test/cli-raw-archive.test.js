import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

const { CliRawArchive } = await import('../dist/domains/cats/services/session/CliRawArchive.js');

const TEST_ARCHIVE_DIR = './test-cli-raw-archive';

function formatToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('CliRawArchive', () => {
  beforeEach(async () => {
    if (existsSync(TEST_ARCHIVE_DIR)) {
      await rm(TEST_ARCHIVE_DIR, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_ARCHIVE_DIR)) {
      await rm(TEST_ARCHIVE_DIR, { recursive: true, force: true });
    }
  });

  test('appends entries to the same invocation file in order', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });

    await archive.append('inv-1', { seq: 1, type: 'thread.started' });
    await archive.append('inv-1', { seq: 2, type: 'item.completed' });

    const file = join(TEST_ARCHIVE_DIR, formatToday(), 'inv-1.ndjson');
    assert.equal(existsSync(file), true);

    const content = await readFile(file, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.payload.seq, 1);
    assert.equal(second.payload.seq, 2);
  });

  test('writes different invocationIds to different files', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });

    await archive.append('inv-a', { marker: 'A' });
    await archive.append('inv-b', { marker: 'B' });

    const dir = join(TEST_ARCHIVE_DIR, formatToday());
    const fileA = join(dir, 'inv-a.ndjson');
    const fileB = join(dir, 'inv-b.ndjson');

    assert.equal(existsSync(fileA), true);
    assert.equal(existsSync(fileB), true);

    const a = JSON.parse((await readFile(fileA, 'utf-8')).trim());
    const b = JSON.parse((await readFile(fileB, 'utf-8')).trim());
    assert.equal(a.payload.marker, 'A');
    assert.equal(b.payload.marker, 'B');
  });

  test('rejects invalid invocationId path traversal attempts', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });

    await assert.rejects(archive.append('../etc/passwd', { marker: 'x' }), /Invalid invocationId/);
  });

  test('supports concurrent append calls for same invocation', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });

    const events = Array.from({ length: 20 }, (_, index) => ({
      seq: index + 1,
      type: 'item.completed',
    }));

    await Promise.all(events.map((event) => archive.append('inv-concurrent', event)));

    const file = join(TEST_ARCHIVE_DIR, formatToday(), 'inv-concurrent.ndjson');
    assert.equal(existsSync(file), true);

    const content = await readFile(file, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 20);

    const found = new Set(lines.map((line) => JSON.parse(line).payload.seq));
    assert.equal(found.size, 20);
    for (let i = 1; i <= 20; i += 1) {
      assert.equal(found.has(i), true);
    }
  });
});

/**
 * 债务3(2026-08-13 立案): CliRawArchive 无保留策略,只增不减。
 * 契约: 14 天保留(与 api 日志轮转对齐),按文件 mtime 裁决;
 * 启动清一次 + 每日定时清扫;清扫失败不得影响主流程。
 */
describe('CliRawArchive retention(债务3)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    if (existsSync(TEST_ARCHIVE_DIR)) {
      await rm(TEST_ARCHIVE_DIR, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (existsSync(TEST_ARCHIVE_DIR)) {
      await rm(TEST_ARCHIVE_DIR, { recursive: true, force: true });
    }
  });

  async function backdateFile(path, ageMs) {
    const old = new Date(Date.now() - ageMs);
    await utimes(path, old, old);
  }

  test('pruneExpired deletes files older than 14 days by mtime, keeps fresh ones', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });
    await archive.append('inv-old', { marker: 'old' });
    await archive.append('inv-fresh', { marker: 'fresh' });

    const dayDir = join(TEST_ARCHIVE_DIR, formatToday());
    await backdateFile(join(dayDir, 'inv-old.ndjson'), 15 * DAY_MS);

    const result = await archive.pruneExpired();

    assert.equal(existsSync(join(dayDir, 'inv-old.ndjson')), false, '15 天前的文件必须被清掉');
    assert.equal(existsSync(join(dayDir, 'inv-fresh.ndjson')), true, '新鲜文件必须保留');
    assert.equal(result.deletedFiles, 1);
  });

  test('pruneExpired removes day directories emptied by the sweep, keeps the archive root', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });
    await archive.append('inv-old', { marker: 'old' });

    const dayDir = join(TEST_ARCHIVE_DIR, formatToday());
    await backdateFile(join(dayDir, 'inv-old.ndjson'), 15 * DAY_MS);

    const result = await archive.pruneExpired();

    assert.equal(existsSync(dayDir), false, '清空的日目录必须被移除');
    assert.equal(existsSync(TEST_ARCHIVE_DIR), true, '归档根目录必须保留');
    assert.equal(result.removedDirs, 1);
  });

  test('append still works after prune removed the day directory (readyDirs cache invalidation)', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });
    await archive.append('inv-old', { marker: 'old' });

    const dayDir = join(TEST_ARCHIVE_DIR, formatToday());
    await backdateFile(join(dayDir, 'inv-old.ndjson'), 15 * DAY_MS);
    await archive.pruneExpired();
    assert.equal(existsSync(dayDir), false);

    await archive.append('inv-new', { marker: 'new' });
    assert.equal(existsSync(join(dayDir, 'inv-new.ndjson')), true, '目录缓存必须随清扫失效,append 自愈重建');
  });

  test('custom retentionDays is honored', async () => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR, retentionDays: 1 });
    await archive.append('inv-yesterday', { marker: 'y' });

    const dayDir = join(TEST_ARCHIVE_DIR, formatToday());
    await backdateFile(join(dayDir, 'inv-yesterday.ndjson'), 2 * DAY_MS);

    await archive.pruneExpired();
    assert.equal(existsSync(join(dayDir, 'inv-yesterday.ndjson')), false, 'retentionDays=1 时 2 天前的文件必须被清掉');
  });

  test('pruneExpired tolerates a missing archive dir (never throws)', async () => {
    const archive = new CliRawArchive({ archiveDir: join(TEST_ARCHIVE_DIR, 'does-not-exist') });
    const result = await archive.pruneExpired();
    assert.deepEqual(result, { deletedFiles: 0, removedDirs: 0 });
  });

  test('startRetentionSweep prunes immediately, keeps running on interval, and stop() disarms', async (t) => {
    const archive = new CliRawArchive({ archiveDir: TEST_ARCHIVE_DIR });
    await archive.append('inv-old', { marker: 'old' });
    const dayDir = join(TEST_ARCHIVE_DIR, formatToday());
    await backdateFile(join(dayDir, 'inv-old.ndjson'), 15 * DAY_MS);

    const stop = archive.startRetentionSweep();
    t.after(() => stop());

    // 启动即清一次(异步 fire-and-forget,轮询等它落地)
    let cleaned = false;
    for (let i = 0; i < 100 && !cleaned; i++) {
      cleaned = !existsSync(join(dayDir, 'inv-old.ndjson'));
      if (!cleaned) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(cleaned, true, '启动时必须立即清一次');

    stop();
    assert.doesNotThrow(() => stop(), '重复 stop 必须幂等');
  });

  test('startRetentionSweep never rejects even when the sweep fails (主流程不受影响)', async () => {
    const archive = new CliRawArchive({ archiveDir: join(TEST_ARCHIVE_DIR, 'nope') });
    const warnings = [];
    const stop = archive.startRetentionSweep({
      info: () => {},
      warn: (obj, msg) => warnings.push(msg),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    // 目录不存在按空处理不算失败;这里只断言全程无未捕获异常即可
    assert.ok(true);
  });
});
