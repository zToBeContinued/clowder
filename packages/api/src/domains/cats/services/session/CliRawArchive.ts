import type { Dirent } from 'node:fs';
import { appendFile, mkdir, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_CLI_RAW_ARCHIVE_DIR = './data/cli-raw-archive';
const INVOCATION_ID_PATTERN = /^[\w-]+$/;
/** 债务3: 14 天保留,与 api 日志轮转对齐。 */
const DEFAULT_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface RawArchiveEntry {
  readonly timestamp: number;
  readonly payload: unknown;
}

export interface RawArchivePruneResult {
  deletedFiles: number;
  removedDirs: number;
}

interface RetentionSweepLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export class CliRawArchive {
  private readonly archiveDir: string;
  private readonly retentionMs: number;
  private readonly readyDirs = new Set<string>();
  private readonly initInFlight = new Map<string, Promise<void>>();

  constructor(options?: { archiveDir?: string; retentionDays?: number }) {
    this.archiveDir = options?.archiveDir ?? process.env.CLI_RAW_ARCHIVE_DIR ?? DEFAULT_CLI_RAW_ARCHIVE_DIR;
    this.retentionMs = (options?.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  }

  /** F118: Get the archive file path for a given invocationId (today's date) */
  getPath(invocationId: string): string {
    const day = this.formatDate(new Date());
    return join(this.archiveDir, day, `${invocationId}.ndjson`);
  }

  async append(invocationId: string, payload: unknown): Promise<void> {
    if (!INVOCATION_ID_PATTERN.test(invocationId)) {
      throw new Error(`Invalid invocationId for archive: ${invocationId}`);
    }

    const timestamp = Date.now();
    const day = this.formatDate(new Date(timestamp));
    const dir = join(this.archiveDir, day);
    const file = join(dir, `${invocationId}.ndjson`);
    const entry: RawArchiveEntry = { timestamp, payload };

    await this.ensureDir(this.archiveDir);
    await this.ensureDir(dir);
    await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  /**
   * 债务3(2026-08-13): 归档此前只增不减。按文件 mtime 裁决,超过保留期删除;
   * 清空的日目录一并移除(归档根保留)。所有失败逐文件吞掉——清扫是后台
   * 卫生工作,绝不影响主流程。
   */
  async pruneExpired(now = Date.now()): Promise<RawArchivePruneResult> {
    const result: RawArchivePruneResult = { deletedFiles: 0, removedDirs: 0 };
    let dayDirs: Dirent[];
    try {
      dayDirs = await readdir(this.archiveDir, { withFileTypes: true });
    } catch {
      return result; // 归档目录不存在/不可读 → 无事可做
    }
    for (const dayDir of dayDirs) {
      if (!dayDir.isDirectory()) continue;
      const dirPath = join(this.archiveDir, dayDir.name);
      let files: Dirent[];
      try {
        files = await readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.ndjson')) continue;
        const filePath = join(dirPath, file.name);
        try {
          const info = await stat(filePath);
          if (now - info.mtimeMs > this.retentionMs) {
            await unlink(filePath);
            result.deletedFiles++;
          }
        } catch {
          /* 单文件失败不影响其它文件 */
        }
      }
      try {
        const remaining = await readdir(dirPath);
        if (remaining.length === 0) {
          await rmdir(dirPath);
          // 目录缓存必须随删除失效,否则后续 append 会往已删目录里写而 ENOENT
          this.readyDirs.delete(dirPath);
          result.removedDirs++;
        }
      } catch {
        /* 目录收尾失败无碍 */
      }
    }
    return result;
  }

  /**
   * 债务3: 启动时清一次 + 每日定时清扫。返回 stop 函数(幂等)。
   * 清扫全程 fire-and-forget,任何异常只记日志,不得影响主流程。
   */
  startRetentionSweep(log?: RetentionSweepLogger): () => void {
    const runSweep = (): void => {
      void this.pruneExpired()
        .then((result) => {
          if (result.deletedFiles > 0 || result.removedDirs > 0) {
            log?.info({ archiveDir: this.archiveDir, ...result }, '[CliRawArchive] retention sweep pruned archives');
          }
        })
        .catch((err) => {
          log?.warn({ archiveDir: this.archiveDir, err }, '[CliRawArchive] retention sweep failed (non-fatal)');
        });
    };
    runSweep();
    const timer = setInterval(runSweep, DAY_MS);
    timer.unref?.();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
  }

  private async ensureDir(dir: string): Promise<void> {
    if (this.readyDirs.has(dir)) return;

    const inFlight = this.initInFlight.get(dir);
    if (inFlight) {
      await inFlight;
      return;
    }

    const initializing = mkdir(dir, { recursive: true })
      .then(() => {
        this.readyDirs.add(dir);
      })
      .finally(() => {
        this.initInFlight.delete(dir);
      });

    this.initInFlight.set(dir, initializing);
    await initializing;
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
