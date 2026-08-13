import type { CatConfig } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

export type CatSupervisorStatus = 'online_idle' | 'processing' | 'timeout' | 'offline';

type RedisLike = Pick<RedisClient, 'set'>;

interface SocketManagerLike {
  emitToUser(userId: string, event: string, data: unknown): void;
}

interface LoggerLike {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface CatSupervisorDeps {
  redis?: RedisLike;
  socketManager: SocketManagerLike;
  log: LoggerLike;
  userId?: string;
  heartbeatMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  /**
   * Backward compatibility for the old flat timeout. When this is the only
   * timeout option supplied, CatSupervisor keeps the original single-timer
   * behavior instead of using the two-stage stream watchdog.
   */
  processingTimeoutMs?: number;
}

type WatchdogPhase = 'connect' | 'idle' | 'paused';

/**
 * CatSupervisor keeps the lightweight "always online" contract for cats.
 *
 * It does not keep model processes alive yet. The MVP is intentionally smaller:
 * catalogued cats are marked online on API boot, execution paths flip them to
 * processing, and completion returns them to online idle.
 */
export class CatSupervisor {
  private readonly redis?: RedisLike;
  private readonly socketManager: SocketManagerLike;
  private readonly log: LoggerLike;
  private readonly userId: string;
  private readonly heartbeatMs: number;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly legacyProcessingTimeoutMs: number | null;
  private readonly statuses = new Map<string, CatSupervisorStatus>();
  private readonly enabledCats = new Set<string>();
  private readonly timeoutTimers = new Map<string, NodeJS.Timeout>();
  private readonly watchdogPhases = new Map<string, WatchdogPhase>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(deps: CatSupervisorDeps) {
    this.redis = deps.redis;
    this.socketManager = deps.socketManager;
    this.log = deps.log;
    this.userId = deps.userId ?? 'default-user';
    this.heartbeatMs = deps.heartbeatMs ?? 30_000;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? 30_000;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? 120_000;
    this.legacyProcessingTimeoutMs =
      deps.processingTimeoutMs !== undefined && deps.connectTimeoutMs === undefined && deps.idleTimeoutMs === undefined
        ? deps.processingTimeoutMs
        : null;
  }

  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat().catch((err) => {
        this.log.warn({ err }, '[CatSupervisor] heartbeat failed');
      });
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const timer of this.timeoutTimers.values()) clearTimeout(timer);
    this.timeoutTimers.clear();
    this.watchdogPhases.clear();
  }

  async syncCats(
    configs: Record<string, CatConfig>,
    isAvailable: (catId: string) => boolean = () => true,
  ): Promise<void> {
    const nextEnabled = new Set<string>();
    for (const [catId, config] of Object.entries(configs)) {
      if (isAvailable(catId)) nextEnabled.add(config.id as string);
    }

    for (const catId of this.enabledCats) {
      if (!nextEnabled.has(catId)) {
        await this.setStatus(catId, 'offline');
      }
    }

    this.enabledCats.clear();
    for (const catId of nextEnabled) {
      this.enabledCats.add(catId);
      const current = this.statuses.get(catId);
      if (current !== 'processing' && current !== 'timeout') {
        await this.setStatus(catId, 'online_idle', { force: true });
      }
    }
  }

  async markProcessing(catIds: string | readonly string[]): Promise<void> {
    for (const catId of this.normalizeCatIds(catIds)) {
      if (!this.enabledCats.has(catId)) this.enabledCats.add(catId);
      await this.setStatus(catId, 'processing');
      if (this.legacyProcessingTimeoutMs !== null) {
        this.armLegacyTimeout(catId);
      } else {
        this.armConnectTimeout(catId);
      }
    }
  }

  async markOutput(catIds: string | readonly string[]): Promise<void> {
    if (this.legacyProcessingTimeoutMs !== null) return;
    for (const catId of this.normalizeCatIds(catIds)) {
      if (this.statuses.get(catId) !== 'processing') continue;
      if (this.watchdogPhases.get(catId) === 'paused') continue;
      this.armIdleTimeout(catId);
    }
  }

  async pauseForTool(catIds: string | readonly string[]): Promise<void> {
    if (this.legacyProcessingTimeoutMs !== null) return;
    for (const catId of this.normalizeCatIds(catIds)) {
      if (this.statuses.get(catId) !== 'processing') continue;
      this.clearTimeoutTimer(catId);
      this.watchdogPhases.set(catId, 'paused');
    }
  }

  async resumeAfterTool(catIds: string | readonly string[]): Promise<void> {
    if (this.legacyProcessingTimeoutMs !== null) return;
    for (const catId of this.normalizeCatIds(catIds)) {
      if (this.statuses.get(catId) !== 'processing') continue;
      if (this.watchdogPhases.get(catId) !== 'paused') continue;
      this.armIdleTimeout(catId);
    }
  }

  async markIdle(catIds: string | readonly string[]): Promise<void> {
    for (const catId of this.normalizeCatIds(catIds)) {
      this.clearProcessingTimeout(catId);
      if (!this.enabledCats.has(catId)) this.enabledCats.add(catId);
      await this.setStatus(catId, 'online_idle');
    }
  }

  async markOffline(catIds: string | readonly string[]): Promise<void> {
    for (const catId of this.normalizeCatIds(catIds)) {
      this.clearProcessingTimeout(catId);
      await this.setStatus(catId, 'offline');
    }
  }

  async runHeartbeat(): Promise<void> {
    for (const catId of this.enabledCats) {
      const status = this.statuses.get(catId);
      if (status === 'processing' || status === 'timeout') continue;
      await this.setStatus(catId, 'online_idle', { force: true });
    }
  }

  async recoverStaleStatuses(): Promise<string[]> {
    const recovered: string[] = [];
    for (const catId of this.enabledCats) {
      const status = this.statuses.get(catId);
      if (status !== 'processing' && status !== 'timeout') continue;
      this.clearProcessingTimeout(catId);
      await this.setStatus(catId, 'online_idle', { force: true });
      recovered.push(catId);
    }
    if (recovered.length > 0) {
      this.log.info({ catIds: recovered }, '[CatSupervisor] recovered stale cat statuses');
    }
    return recovered;
  }

  getStatus(catId: string): CatSupervisorStatus | undefined {
    return this.statuses.get(catId);
  }

  private armLegacyTimeout(catId: string): void {
    this.armTimeout(catId, this.legacyProcessingTimeoutMs ?? 60_000);
  }

  private armConnectTimeout(catId: string): void {
    this.watchdogPhases.set(catId, 'connect');
    this.armTimeout(catId, this.connectTimeoutMs);
  }

  private armIdleTimeout(catId: string): void {
    this.watchdogPhases.set(catId, 'idle');
    this.armTimeout(catId, this.idleTimeoutMs);
  }

  private armTimeout(catId: string, timeoutMs: number): void {
    this.clearTimeoutTimer(catId);
    const timer = setTimeout(() => {
      if (this.statuses.get(catId) !== 'processing') return;
      this.timeoutTimers.delete(catId);
      this.watchdogPhases.delete(catId);
      void this.setStatus(catId, 'timeout').catch((err) => {
        this.log.warn({ err, catId }, '[CatSupervisor] timeout status update failed');
      });
    }, timeoutMs);
    timer.unref?.();
    this.timeoutTimers.set(catId, timer);
  }

  private clearProcessingTimeout(catId: string): void {
    this.clearTimeoutTimer(catId);
    this.watchdogPhases.delete(catId);
  }

  private clearTimeoutTimer(catId: string): void {
    const timer = this.timeoutTimers.get(catId);
    if (!timer) return;
    clearTimeout(timer);
    this.timeoutTimers.delete(catId);
  }

  private async setStatus(catId: string, status: CatSupervisorStatus, opts: { force?: boolean } = {}): Promise<void> {
    if (!opts.force && this.statuses.get(catId) === status) return;
    this.statuses.set(catId, status);
    await this.redis?.set(`cat:status:${catId}`, status);
    this.socketManager.emitToUser(this.userId, 'catStatusChange', {
      catId,
      status,
      updatedAt: Date.now(),
    });
  }

  private normalizeCatIds(catIds: string | readonly string[]): string[] {
    const raw = Array.isArray(catIds) ? catIds : [catIds];
    return [...new Set(raw.filter((catId): catId is string => typeof catId === 'string' && catId.length > 0))];
  }
}
