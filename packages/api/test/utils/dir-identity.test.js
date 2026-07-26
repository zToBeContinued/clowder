/**
 * 目录身份比较
 *
 * 起因：Windows 上同一个目录可以有多种路径写法（8.3 短名 vs 长名、大小写差异），
 * realpathSync 不展开短名，纯字符串比会把同一个目录判成两个。对 isSameRepo /
 * isSameProject 来说这意味着本仓库被误当成外部项目 —— 会触发治理门禁，也会让
 * marker 写错知识库。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

const { dirIdentity, isSameDirPath, sameDir } = await import('../../dist/utils/dir-identity.js');

/**
 * 同一目录的另一种写法。
 *
 * Windows 上 os.tmpdir() 通常返回 8.3 短名（`C:\Users\ADMINI~1\...`），而
 * realpathSync.native 会展开成长名 —— 正好构成一对指向同一目录的不同字符串。
 * 拿不到不同写法时返回 null（卷上禁用了短名等情况），调用方跳过。
 */
function otherSpelling(path) {
  try {
    const native = realpathSync.native(path);
    return native !== path ? native : null;
  } catch {
    return null;
  }
}

describe('dirIdentity', () => {
  const tempDirs = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('treats a directory as identical to itself', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dir-identity-'));
    tempDirs.push(dir);
    assert.equal(isSameDirPath(dir, dir), true);
  });

  it('distinguishes two different directories', () => {
    const a = mkdtempSync(join(tmpdir(), 'dir-identity-a-'));
    const b = mkdtempSync(join(tmpdir(), 'dir-identity-b-'));
    tempDirs.push(a, b);
    assert.equal(isSameDirPath(a, b), false);
  });

  it('matches a different spelling of the same directory (8.3 short name)', () => {
    // 短名/长名是 realpathSync 弥合不了的那一类差异，也是最初把同一仓库判成两个的根因。
    const dir = mkdtempSync(join(tmpdir(), 'dir-identity-short-'));
    tempDirs.push(dir);
    const other = otherSpelling(dir);
    if (!other) return; // 该平台/卷上拿不到第二种写法

    assert.notEqual(other, dir, 'fixture must actually differ in spelling');
    assert.equal(realpathSync(dir) === realpathSync(other), false, 'realpathSync alone cannot bridge this');
    assert.equal(isSameDirPath(other, dir), true);
  });

  it('matches a case-different spelling on Windows', { skip: process.platform !== 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'dir-identity-case-'));
    tempDirs.push(dir);
    assert.equal(isSameDirPath(dir.toUpperCase(), dir), true);
  });

  it('falls back to the normalized input path when the directory is missing', () => {
    const missing = join(tmpdir(), 'dir-identity-does-not-exist-abc123');
    const id = dirIdentity(missing);

    assert.equal(id.inode, null, 'no inode is available for a missing directory');
    // 退化行为要与旧的字符串比较等价：同一个不存在的路径仍然相等。
    assert.equal(sameDir(id, dirIdentity(missing)), true);
    assert.equal(sameDir(id, dirIdentity(`${missing}-other`)), false);
  });

  it('reports no match when either side is unresolvable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dir-identity-null-'));
    tempDirs.push(dir);
    assert.equal(sameDir(null, dirIdentity(dir)), false);
    assert.equal(sameDir(dirIdentity(dir), null), false);
    assert.equal(sameDir(null, null), false);
  });
});
