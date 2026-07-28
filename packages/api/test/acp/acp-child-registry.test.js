/**
 * ACP 子进程孤儿回收
 *
 * 背景：Windows 上父进程常被 TerminateProcess 掉（点窗口 X / Stop-Process -Force），
 * node 的 SIGTERM handler 不跑 → onClose → closeAll() 全跳过 → carrier 变常驻孤儿，
 * 攥着 Kiro 会话独占锁导致 `Session is active in another process`。
 *
 * 这套机制最危险的地方是 **PID 复用**：一个过期 pid 可能已被系统分配给别的进程，
 * 盲杀就是误杀。所以这里最重要的用例不是「能杀掉孤儿」，而是「不该杀的一个都不能碰」。
 *
 * 测试全程注入假探针 + 假 kill，不触碰任何真实进程。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

const {
  recordAcpChild,
  forgetAcpChild,
  reapOrphanAcpChildren,
  imageMatches,
  resolveAcpChildRegistryDir,
  IDENTITY_TOLERANCE_MS,
} = await import('../../dist/domains/cats/services/agents/providers/acp/acp-child-registry.js');

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acp-child-reg-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** 假 kill：只记账，不动真进程。 */
function makeKiller() {
  const calls = [];
  return { calls, kill: (pid, signal) => (calls.push(`${signal}:${pid}`), true) };
}

/** 一次性探针：第一次返回 live，宽限期后返回 afterGrace（默认全部已死）。 */
function makeProbe(live, afterGrace = []) {
  let round = 0;
  return async (pids) => {
    round += 1;
    const table = round === 1 ? live : afterGrace;
    return table.filter((p) => pids.includes(p.pid));
  };
}

async function remaining() {
  return (await readdir(dir)).sort();
}

describe('ACP 子进程孤儿回收', () => {
  it('登记 → 注销 的文件生命周期', async () => {
    await recordAcpChild(dir, { pid: 4242, command: 'kiro-cli', spawnedAtMs: Date.now() });
    assert.deepEqual(await remaining(), ['4242.json']);
    await forgetAcpChild(dir, 4242);
    assert.deepEqual(await remaining(), []);
    // 注销不存在的记录不能抛
    await forgetAcpChild(dir, 4242);
  });

  it('身份吻合的孤儿：先 SIGTERM，宽限后已退出则不补刀', async () => {
    const now = Date.now();
    await recordAcpChild(dir, { pid: 100, command: 'C:\\x\\kiro-cli.exe', spawnedAtMs: now });
    const killer = makeKiller();

    const outcome = await reapOrphanAcpChildren(dir, {
      probe: makeProbe([{ pid: 100, startedAtMs: now + 200, image: 'C:\\x\\kiro-cli.exe' }]),
      kill: killer.kill,
      graceMs: 1,
    });

    assert.deepEqual(outcome.reaped, [100]);
    assert.deepEqual(killer.calls, ['SIGTERM:100'], '宽限后已退出，不该再 SIGKILL');
    assert.deepEqual(await remaining(), [], '处理完的记录必须清掉');
  });

  it('宽限期后仍存活 → 补 SIGKILL', async () => {
    const now = Date.now();
    await recordAcpChild(dir, { pid: 101, command: 'kiro-cli', spawnedAtMs: now });
    const killer = makeKiller();
    const stubborn = [{ pid: 101, startedAtMs: now, image: 'kiro-cli.exe' }];

    await reapOrphanAcpChildren(dir, {
      probe: makeProbe(stubborn, stubborn),
      kill: killer.kill,
      graceMs: 1,
    });

    assert.deepEqual(killer.calls, ['SIGTERM:101', 'SIGKILL:101']);
  });

  it('P1 防误杀：创建时间超出容差（PID 已被复用）绝不杀', async () => {
    const now = Date.now();
    await recordAcpChild(dir, { pid: 200, command: 'kiro-cli', spawnedAtMs: now });
    const killer = makeKiller();

    const outcome = await reapOrphanAcpChildren(dir, {
      // 同 pid，但这个进程是在我们记录之后很久才启动的 → 显然是别人
      probe: makeProbe([{ pid: 200, startedAtMs: now + IDENTITY_TOLERANCE_MS + 1, image: 'kiro-cli.exe' }]),
      kill: killer.kill,
      graceMs: 1,
    });

    assert.deepEqual(killer.calls, [], '疑似 PID 复用，一刀都不能下');
    assert.deepEqual(outcome.skippedMismatch, [200]);
    assert.deepEqual(outcome.reaped, []);
    assert.deepEqual(await remaining(), [], '仍要清掉无用记录');
  });

  it('P1 防误杀：映像名不符（pid 被别的程序占了）绝不杀', async () => {
    const now = Date.now();
    await recordAcpChild(dir, { pid: 201, command: 'kiro-cli', spawnedAtMs: now });
    const killer = makeKiller();

    const outcome = await reapOrphanAcpChildren(dir, {
      probe: makeProbe([{ pid: 201, startedAtMs: now, image: 'C:\\Windows\\explorer.exe' }]),
      kill: killer.kill,
      graceMs: 1,
    });

    assert.deepEqual(killer.calls, []);
    assert.deepEqual(outcome.skippedMismatch, [201]);
  });

  it('进程早已不在：只清文件，不发信号', async () => {
    await recordAcpChild(dir, { pid: 300, command: 'kiro-cli', spawnedAtMs: Date.now() });
    const killer = makeKiller();

    const outcome = await reapOrphanAcpChildren(dir, {
      probe: makeProbe([]),
      kill: killer.kill,
      graceMs: 1,
    });

    assert.deepEqual(killer.calls, []);
    assert.deepEqual(outcome.alreadyGone, [300]);
    assert.deepEqual(await remaining(), []);
  });

  it('探针整体失败：保留记录、不杀任何进程，留给下次启动重试', async () => {
    await recordAcpChild(dir, { pid: 400, command: 'kiro-cli', spawnedAtMs: Date.now() });
    const killer = makeKiller();

    const outcome = await reapOrphanAcpChildren(dir, {
      probe: async () => {
        throw new Error('wmi unavailable');
      },
      kill: killer.kill,
      graceMs: 1,
    });

    assert.deepEqual(killer.calls, [], '查不到身份就不能动手');
    assert.deepEqual(outcome, { reaped: [], alreadyGone: [], skippedMismatch: [] });
    assert.deepEqual(await remaining(), ['400.json'], '记录要留着，下次再试');
  });

  it('损坏/非法记录直接丢弃，绝不据此杀进程', async () => {
    await writeFile(join(dir, 'bad.json'), '{ not json', 'utf8');
    await writeFile(join(dir, '0.json'), JSON.stringify({ pid: 0, command: 'x', spawnedAtMs: 1 }), 'utf8');
    await writeFile(join(dir, 'neg.json'), JSON.stringify({ pid: -1, command: 'x', spawnedAtMs: 1 }), 'utf8');
    await writeFile(join(dir, 'ignored.txt'), 'not a record', 'utf8');
    const killer = makeKiller();

    const outcome = await reapOrphanAcpChildren(dir, {
      probe: async () => assert.fail('不该为损坏记录发起探测'),
      kill: killer.kill,
      graceMs: 1,
    });

    assert.deepEqual(outcome, { reaped: [], alreadyGone: [], skippedMismatch: [] });
    assert.deepEqual(killer.calls, []);
    assert.deepEqual(await remaining(), ['ignored.txt'], '非 .json 不碰，损坏的 .json 清掉');
  });

  it('目录不存在时是 no-op（首次启动）', async () => {
    const outcome = await reapOrphanAcpChildren(join(dir, 'nope'), {
      probe: async () => assert.fail('不该探测'),
      kill: () => assert.fail('不该 kill'),
    });
    assert.deepEqual(outcome, { reaped: [], alreadyGone: [], skippedMismatch: [] });
  });

  it('imageMatches 忽略路径与可执行后缀，Windows 大小写不敏感', () => {
    assert.equal(imageMatches('kiro-cli', 'C:\\Users\\x\\Kiro-Cli\\kiro-cli.exe'), true);
    assert.equal(imageMatches('C:\\a\\kiro-cli.cmd', 'kiro-cli.exe'), true);
    assert.equal(imageMatches('gemini', 'kiro-cli.exe'), false);
    assert.equal(imageMatches('kiro-cli', 'explorer.exe'), false);
  });

  it('登记目录落在项目内的 .cat-cafe/run 下', () => {
    const resolved = resolveAcpChildRegistryDir('D:\\proj');
    assert.match(resolved.replaceAll('\\', '/'), /\/\.cat-cafe\/run\/acp-children$/);
  });
});
