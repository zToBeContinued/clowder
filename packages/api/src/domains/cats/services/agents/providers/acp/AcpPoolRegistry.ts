import { createHash } from 'node:crypto';

export interface ManagedAcpPool {
  getMetrics(): { readonly activeLeaseCount: number };
  closeAll(): Promise<void>;
}

export interface AcpPoolIdentity {
  readonly carrier: string;
  readonly projectRoot: string;
  readonly command: string;
  readonly startupArgs: readonly string[];
  /** SHA-256 digest only; raw environment values must never enter the fingerprint. */
  readonly environmentDigest?: string;
  readonly supportsMultiplexing: boolean;
  readonly maxLiveProcesses: number;
  readonly idleTtlMs: number;
  readonly healthCheckIntervalMs: number;
}

interface RegistryEntry<TPool> {
  readonly fingerprint: string;
  readonly pool: TPool;
}

export function createAcpEnvironmentDigest(env: Readonly<Record<string, string>> | undefined): string {
  const hash = createHash('sha256');
  for (const [key, value] of Object.entries(env ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(key);
    hash.update('\0');
    hash.update(value);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Stable identity for every setting captured by an AcpProcessPool factory. */
export function createAcpPoolFingerprint(identity: AcpPoolIdentity): string {
  return JSON.stringify([
    identity.carrier,
    identity.projectRoot,
    identity.command,
    [...identity.startupArgs],
    identity.environmentDigest ?? createAcpEnvironmentDigest(undefined),
    identity.supportsMultiplexing,
    identity.maxLiveProcesses,
    identity.idleTtlMs,
    identity.healthCheckIntervalMs,
  ]);
}

/**
 * Keeps the current pool for each provider profile while safely retiring stale
 * pools after provider/command/capability changes. Active leases are never
 * killed during registry reconciliation; retired pools are reaped once idle.
 */
export class AcpPoolRegistry<TPool extends ManagedAcpPool> {
  private readonly current = new Map<string, RegistryEntry<TPool>>();
  private readonly retired = new Set<TPool>();

  get size(): number {
    return this.current.size;
  }

  async getOrCreate(profileId: string, fingerprint: string, factory: () => TPool): Promise<TPool> {
    await this.reapRetired();
    const current = this.current.get(profileId);
    if (current?.fingerprint === fingerprint) return current.pool;

    const replacement = factory();
    this.current.set(profileId, { fingerprint, pool: replacement });
    if (current) {
      this.retired.add(current.pool);
      await this.reapRetired();
    }
    return replacement;
  }

  async retainOnly(activeProfileIds: ReadonlySet<string>): Promise<void> {
    for (const [profileId, entry] of this.current) {
      if (activeProfileIds.has(profileId)) continue;
      this.current.delete(profileId);
      this.retired.add(entry.pool);
    }
    await this.reapRetired();
  }

  *entries(): IterableIterator<[string, TPool]> {
    for (const [profileId, entry] of this.current) {
      yield [profileId, entry.pool];
    }
  }

  async reapRetired(): Promise<void> {
    for (const pool of [...this.retired]) {
      if (pool.getMetrics().activeLeaseCount > 0) continue;
      this.retired.delete(pool);
      await pool.closeAll();
    }
  }

  async closeAll(): Promise<void> {
    const pools = new Set<TPool>([...[...this.current.values()].map((entry) => entry.pool), ...this.retired]);
    this.current.clear();
    this.retired.clear();
    for (const pool of pools) await pool.closeAll();
  }
}
