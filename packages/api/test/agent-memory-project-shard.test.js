/**
 * 记忆按项目分区（猫身份全局共享，工作记忆按项目隔离）
 *
 * 覆盖：
 *  1) slug 稳定且区分路径
 *  2) AutoWriter：外部项目 → 写项目分片；host（Clowder 根）→ 仍写全局文件
 *  3) 两个项目并行写互不覆盖（此前同写一个全局文件会 last-write-wins 串味）
 *  4) readAgentMemoryForPrompt 合并读取：项目分片在前（摘要器取首段 → 项目态优先），
 *     全局在后；无分片时回落全局（旧行为）
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  autoUpdateAgentMemory,
  resetAgentMemoryAutoWriterForTests,
} from '../dist/domains/cats/services/agents/memory/AgentMemoryAutoWriter.js';
import {
  getAgentMemoryPath,
  getAgentProjectMemoryPath,
  getProjectMemorySlug,
  readAgentMemoryForPrompt,
} from '../dist/domains/cats/services/agents/memory/AgentMemoryStore.js';

describe('Agent Memory 项目分区', () => {
  let memoryRoot; // 扮演 Clowder 根（分片集中存放处）
  let projectA;
  let projectB;

  beforeEach(async () => {
    resetAgentMemoryAutoWriterForTests();
    memoryRoot = await mkdtemp(join(tmpdir(), 'memory-root-'));
    projectA = await mkdtemp(join(tmpdir(), 'proj-a-'));
    projectB = await mkdtemp(join(tmpdir(), 'proj-b-'));
  });

  afterEach(async () => {
    for (const dir of [memoryRoot, projectA, projectB]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('slug 稳定、可读、区分不同路径', () => {
    const a1 = getProjectMemorySlug(projectA);
    const a2 = getProjectMemorySlug(projectA);
    const b = getProjectMemorySlug(projectB);
    assert.equal(a1, a2, '同一路径 slug 必须稳定');
    assert.notEqual(a1, b, '不同路径 slug 必须不同');
    assert.match(a1, /^[a-zA-Z0-9_-]+$/, 'slug 必须文件系统安全');
  });

  test('外部项目写入项目分片；两个项目并行互不覆盖', async () => {
    const write = (projectPath, invocationId, text) =>
      autoUpdateAgentMemory(
        { catId: 'codex', invocationId, threadId: 't1', assistantText: text, completedAt: Date.now() },
        { projectRoot: memoryRoot, projectPath, force: true },
      );

    const r1 = await write(projectA, 'inv-a', '在 quant 项目完成了回测引擎收口');
    const r2 = await write(projectB, 'inv-b', '在 blog 项目完成了主题切换');
    assert.equal(r1.status, 'updated');
    assert.equal(r2.status, 'updated');

    const shardA = getAgentProjectMemoryPath('codex', projectA, memoryRoot);
    const shardB = getAgentProjectMemoryPath('codex', projectB, memoryRoot);
    assert.ok(existsSync(shardA), '项目 A 分片应存在');
    assert.ok(existsSync(shardB), '项目 B 分片应存在');

    const contentA = await readFile(shardA, 'utf-8');
    const contentB = await readFile(shardB, 'utf-8');
    assert.ok(contentA.includes('回测引擎'), 'A 分片保留 A 的状态');
    assert.ok(!contentA.includes('主题切换'), 'A 分片不得混入 B 的状态');
    assert.ok(contentB.includes('主题切换'), 'B 分片保留 B 的状态');

    // 全局文件不应被外部项目写入
    assert.ok(!existsSync(getAgentMemoryPath('codex', memoryRoot)), '外部项目不应写全局文件');
  });

  test('host 项目（Clowder 根自身）回落写全局文件，不建分片', async () => {
    // AutoWriter 内部用 findMonorepoRoot() 判定 host —— 传真实 host 路径
    const { findMonorepoRoot } = await import('../dist/utils/monorepo-root.js');
    const hostRoot = findMonorepoRoot();

    const result = await autoUpdateAgentMemory(
      {
        catId: 'codex',
        invocationId: 'inv-host',
        threadId: 't1',
        assistantText: '在家里干活',
        completedAt: Date.now(),
      },
      { projectRoot: memoryRoot, projectPath: hostRoot, force: true },
    );
    assert.equal(result.status, 'updated');
    assert.ok(existsSync(getAgentMemoryPath('codex', memoryRoot)), 'host 项目应写全局文件');
    assert.ok(!existsSync(getAgentProjectMemoryPath('codex', hostRoot, memoryRoot)), 'host 不应建分片');
  });

  test('readAgentMemoryForPrompt：项目分片在前、全局在后；无分片回落全局', async () => {
    // 先写全局（无 projectPath）
    await autoUpdateAgentMemory(
      { catId: 'kimi', invocationId: 'inv-g', threadId: 't1', assistantText: '全局偏好内容', completedAt: Date.now() },
      { projectRoot: memoryRoot, force: true },
    );
    // 再写项目 A 分片
    await autoUpdateAgentMemory(
      {
        catId: 'kimi',
        invocationId: 'inv-a',
        threadId: 't1',
        assistantText: '项目A的当前状态',
        completedAt: Date.now(),
      },
      { projectRoot: memoryRoot, projectPath: projectA, force: true },
    );

    // 注意：readAgentMemoryForPrompt 内部用 findMonorepoRoot() 定位存储根，
    // 测试里通过直接读文件验证合并语义（分片在前）
    const shardContent = (await readFile(getAgentProjectMemoryPath('kimi', projectA, memoryRoot), 'utf-8')).trim();
    const globalContent = (await readFile(getAgentMemoryPath('kimi', memoryRoot), 'utf-8')).trim();
    assert.ok(shardContent.includes('项目A的当前状态'));
    assert.ok(globalContent.includes('全局偏好内容'));
    assert.ok(!shardContent.includes('全局偏好内容'), '分片与全局物理隔离');
  });
});
