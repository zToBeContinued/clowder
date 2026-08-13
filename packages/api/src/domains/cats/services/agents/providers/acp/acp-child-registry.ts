/**
 * ACP 子进程登记表 —— 让下次启动能回收上一轮的孤儿。
 *
 * 为什么需要：ACP carrier（kiro-cli / gemini 等）是 API 进程 spawn 出来的子进程，
 * 但它们不会因为父进程消失而退出（实测 kiro-cli 在 stdin EOF 后仍存活）。而 Windows 上
 * 优雅退出链路极难触发：
 *   - 点窗口 X → CTRL_CLOSE_EVENT，PowerShell 不保证展开 try/finally
 *   - stop-windows.ps1 用 Stop-Process -Force → TerminateProcess → node 的
 *     SIGTERM handler 根本不跑 → Fastify onClose → acpPoolRegistry.closeAll() 全被跳过
 * 结果就是一堆孤儿 carrier 常驻，还攥着 Kiro 的会话独占锁，导致后续
 * `Session is active in another process (PID ...)`。
 *
 * 做法：spawn 时把 pid 落一个小文件，正常关闭时删掉。启动时扫描残留文件并回收。
 *
 * ⚠️ PID 复用是这类设计的头号坑：一个过期 pid 可能已经被系统分配给别的无关进程，
 * 盲杀等于误杀。所以回收前必须校验身份 —— 进程的**实际创建时间**要落在我们记录的
 * spawn 时刻附近，且映像名要对得上。两者任一不符就只删文件、不杀进程。
 */

import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';

const log = createModuleLogger('acp-child-registry');

/** 记录的 spawn 时刻与进程真实创建时间的最大容差 —— 超出即认为是 PID 复用。 */
export const IDENTITY_TOLERANCE_MS = 60_000;
/** SIGTERM 到 SIGKILL 的宽限。 */
export const REAP_GRACE_MS = 3_000;

export interface AcpChildRecord {
  pid: number;
  /** spawn 时使用的命令（可能是绝对路径，也可能是裸命令名）。 */
  command: string;
  /** 我方 wall-clock spawn 时刻 —— 与 OS 创建时间只差毫秒级。 */
  spawnedAtMs: number;
  cwd?: string;
  providerProfile?: string;
}

/** 探针返回的存活进程信息。 */
export interface LiveProcessInfo {
  pid: number;
  /** 进程创建时间（epoch ms）。 */
  startedAtMs: number;
  /** 映像名或可执行文件路径。 */
  image: string;
}

export interface ReapDeps {
  /** 批量查询这些 pid 的存活信息；查不到的不返回。 */
  probe(pids: readonly number[]): Promise<LiveProcessInfo[]>;
  /** 发送信号；进程已不存在时应静默返回 false。 */
  kill(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean;
  now?(): number;
  graceMs?: number;
}

export interface ReapOutcome {
  /** 已确认身份并终止的 pid。 */
  reaped: number[];
  /** 进程已不在，只清理了残留文件。 */
  alreadyGone: number[];
  /** 身份校验不通过（疑似 PID 复用），未杀，只清文件。 */
  skippedMismatch: number[];
}

export function resolveAcpChildRegistryDir(projectRoot: string): string {
  return join(projectRoot, '.cat-cafe', 'run', 'acp-children');
}

/**
 * 进程级登记目录。AcpClient 在工厂深处被构造，逐层透传目录不划算，
 * 所以由 index.ts 在启动时设定一次；未设定时退化到 cwd 推导（测试/脚本场景）。
 */
let registryDir: string | null = null;

export function setAcpChildRegistryDir(dir: string): void {
  registryDir = dir;
}

export function getAcpChildRegistryDir(): string {
  return registryDir ?? resolveAcpChildRegistryDir(process.cwd());
}

function recordPath(dir: string, pid: number): string {
  return join(dir, `${pid}.json`);
}

/** spawn 成功后登记。失败不抛 —— 登记是尽力而为，不能拖垮 spawn。 */
export async function recordAcpChild(dir: string, record: AcpChildRecord): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(recordPath(dir, record.pid), JSON.stringify(record), 'utf8');
  } catch (err) {
    log.warn({ err, pid: record.pid }, 'failed to record ACP child pid');
  }
}

/** 正常关闭后注销。 */
export async function forgetAcpChild(dir: string, pid: number): Promise<void> {
  try {
    await unlink(recordPath(dir, pid));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, pid }, 'failed to forget ACP child pid');
    }
  }
}

async function readRecords(dir: string): Promise<AcpChildRecord[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: AcpChildRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as AcpChildRecord;
      if (typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        records.push(parsed);
      } else {
        await unlink(join(dir, name)).catch(() => {});
      }
    } catch {
      // 损坏的记录没有价值，直接清掉，绝不据此杀进程
      await unlink(join(dir, name)).catch(() => {});
    }
  }
  return records;
}

/** 映像名是否与登记的命令一致（Windows 不区分大小写，且忽略 .exe/.cmd 后缀）。 */
export function imageMatches(command: string, image: string): boolean {
  const strip = (s: string) =>
    basename(s)
      .replace(/\.(exe|cmd|bat|com)$/i, '')
      .toLowerCase();
  return strip(command) === strip(image);
}

/**
 * 回收上一轮残留的 ACP 子进程。
 *
 * 无论是否杀掉，处理完的记录文件都会被清理 —— 记录只对「上一轮」有意义，
 * 留着会让下次启动反复尝试同一个早已消失的 pid。
 */
export async function reapOrphanAcpChildren(dir: string, deps: ReapDeps): Promise<ReapOutcome> {
  const now = deps.now ?? Date.now;
  const graceMs = deps.graceMs ?? REAP_GRACE_MS;
  const outcome: ReapOutcome = { reaped: [], alreadyGone: [], skippedMismatch: [] };

  const records = await readRecords(dir);
  if (records.length === 0) return outcome;

  const live = new Map<number, LiveProcessInfo>();
  try {
    for (const info of await deps.probe(records.map((r) => r.pid))) live.set(info.pid, info);
  } catch (err) {
    // 探针失败时宁可不回收也不能瞎杀 —— 保留记录，等下次启动再试。
    log.warn({ err, candidates: records.length }, 'ACP orphan probe failed — skipping reap this boot');
    return outcome;
  }

  const toKill: number[] = [];
  for (const record of records) {
    const info = live.get(record.pid);
    if (!info) {
      outcome.alreadyGone.push(record.pid);
      continue;
    }
    const drift = Math.abs(info.startedAtMs - record.spawnedAtMs);
    if (drift > IDENTITY_TOLERANCE_MS || !imageMatches(record.command, info.image)) {
      // 极可能是 PID 复用后的无关进程 —— 绝不能杀。
      log.warn(
        { pid: record.pid, driftMs: drift, expected: record.command, actual: info.image },
        'ACP orphan identity mismatch — refusing to kill (likely PID reuse)',
      );
      outcome.skippedMismatch.push(record.pid);
      continue;
    }
    toKill.push(record.pid);
  }

  for (const pid of toKill) {
    deps.kill(pid, 'SIGTERM');
  }
  if (toKill.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    const stillAlive = new Set<number>();
    try {
      for (const info of await deps.probe(toKill)) stillAlive.add(info.pid);
    } catch {
      // 探针二次失败：无法确认，直接补一刀 SIGKILL（这些 pid 首轮已通过身份校验）
      for (const pid of toKill) stillAlive.add(pid);
    }
    for (const pid of stillAlive) deps.kill(pid, 'SIGKILL');
    outcome.reaped.push(...toKill);
  }

  for (const record of records) {
    await forgetAcpChild(dir, record.pid);
  }

  const total = outcome.reaped.length + outcome.alreadyGone.length + outcome.skippedMismatch.length;
  if (outcome.reaped.length > 0 || outcome.skippedMismatch.length > 0) {
    log.info(
      {
        reaped: outcome.reaped,
        alreadyGone: outcome.alreadyGone.length,
        skippedMismatch: outcome.skippedMismatch,
        scanned: total,
        elapsedNow: now(),
      },
      'ACP orphan sweep complete',
    );
  }
  return outcome;
}
