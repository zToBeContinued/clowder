/**
 * ProcessLivenessProbe — F118 Phase B
 * CPU sampling + liveness state classification for CLI child processes.
 *
 * States:
 * - active:      output received recently
 * - busy-silent: no output but CPU time is growing (process is working)
 * - idle-silent: no output AND CPU is flat (process may be stuck)
 * - dead:        PID no longer exists
 */

import { execFile } from 'node:child_process';

export type LivenessState = 'active' | 'busy-silent' | 'idle-silent' | 'dead';

export interface LivenessWarningEvent {
  __livenessWarning: true;
  state: LivenessState;
  silenceDurationMs: number;
  level: 'alive_but_silent' | 'suspected_stall';
  cpuTimeMs?: number;
  processAlive: boolean;
}

export interface ProbeConfig {
  sampleIntervalMs: number;
  softWarningMs: number;
  stallWarningMs: number;
  boundedExtensionFactor: number;
}

const DEFAULT_CONFIG: ProbeConfig = {
  sampleIntervalMs: 60_000,
  softWarningMs: 120_000,
  stallWarningMs: 300_000,
  boundedExtensionFactor: 2.0,
};

export interface ProcessCpuRow {
  pid: number;
  ppid: number;
  cpuMs: number;
}

/**
 * Sum CPU over rootPid + ALL transitive descendants.
 *
 * 2026-08-12 quant 假超时事故：CLI 跑长工具时忙的是深层后代（API → powershell
 * 包装 → cursor-agent → 工具 shell → pytest），此前只统计「自己+直接子进程」，
 * 包装模式下正好把烧 CPU 的那层排除在外 → busy 会话被误判 idle-silent →
 * 180s 假超时击杀。返回 null 表示 rootPid 不在进程表里（Unix 视为已死）。
 */
export function sumProcessTreeCpu(rows: readonly ProcessCpuRow[], rootPid: number): number | null {
  const childrenByPpid = new Map<number, ProcessCpuRow[]>();
  let rootRow: ProcessCpuRow | undefined;
  for (const row of rows) {
    if (row.pid === rootPid) rootRow = row;
    const bucket = childrenByPpid.get(row.ppid);
    if (bucket) bucket.push(row);
    else childrenByPpid.set(row.ppid, [row]);
  }
  if (!rootRow) return null;
  let total = 0;
  const visited = new Set<number>();
  const queue: ProcessCpuRow[] = [rootRow];
  for (;;) {
    const current = queue.pop();
    if (!current) break;
    if (visited.has(current.pid)) continue; // PID 复用可能造出 ppid 环
    visited.add(current.pid);
    total += current.cpuMs;
    for (const childRow of childrenByPpid.get(current.pid) ?? []) {
      queue.push(childRow);
    }
  }
  return total;
}

/** Parse ps cputime format (mm:ss.SS or h:mm:ss) to milliseconds */
export function parseCpuTime(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(':');
  if (parts.length === 3) {
    // h:mm:ss
    const [h, m, s] = parts;
    return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000;
  }
  if (parts.length === 2) {
    // mm:ss.SS
    const [m, s] = parts;
    return (Number(m) * 60 + Number(s)) * 1000;
  }
  return 0;
}

export class ProcessLivenessProbe {
  readonly config: ProbeConfig;
  private readonly pid: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt: number;
  private prevCpuTimeMs = 0;
  private currCpuTimeMs = 0;
  private cpuGrowing = false;
  private sampling = false;
  private pidAlive = true;
  private warningQueue: LivenessWarningEvent[] = [];
  private softWarningEmitted = false;
  private stallWarningEmitted = false;

  constructor(pid: number, config?: Partial<ProbeConfig>) {
    this.pid = pid;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.lastActivityAt = Date.now();
  }

  /** Notify that output was received — resets silence tracking */
  notifyActivity(): void {
    this.lastActivityAt = Date.now();
    this.softWarningEmitted = false;
    this.stallWarningEmitted = false;
  }

  /** Current liveness state */
  getState(): LivenessState {
    if (!this.pidAlive) return 'dead';
    const silenceMs = Date.now() - this.lastActivityAt;
    if (silenceMs < this.config.sampleIntervalMs) return 'active';
    return this.cpuGrowing ? 'busy-silent' : 'idle-silent';
  }

  /** Drain pending warning events */
  drainWarnings(): LivenessWarningEvent[] {
    const warnings = this.warningQueue.splice(0);
    return warnings;
  }

  /**
   * Final flush for shutdown races:
   * stdout can close before the next generator loop drains a warning that was
   * already queued by an in-flight sample. Wait briefly for that sample to land
   * so callers can drain pending warnings before exit, but do not synthesize
   * any new warnings during shutdown.
   */
  async flushPendingWarnings(): Promise<void> {
    const deadline = Date.now() + Math.max(this.config.sampleIntervalMs, 50);
    while (this.sampling && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Whether bounded extension applies (busy-silent) */
  shouldExtendTimeout(): boolean {
    return this.getState() === 'busy-silent';
  }

  /** Whether hard cap (boundedExtensionFactor * timeoutMs) is exceeded */
  isHardCapExceeded(elapsedMs: number, timeoutMs: number): boolean {
    return elapsedMs >= this.config.boundedExtensionFactor * timeoutMs;
  }

  /** Start periodic CPU sampling */
  start(): void {
    if (this.timer) return;
    this.sampleOnce(); // immediate first sample
    this.timer = setInterval(() => this.sampleOnce(), this.config.sampleIntervalMs);
    this.timer.unref();
  }

  /** Stop and cleanup */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private sampleOnce(): void {
    // Guard against concurrent samples — nested async calls (ps→pgrep→ps) can
    // overlap when sampleIntervalMs is shorter than the async chain duration.
    if (this.sampling) {
      // A Windows CPU sample (PowerShell ~1-2s) can outlast several ticks.
      // Keep silence warnings responsive while the async sample is in flight —
      // they are cheap, synchronous, and de-duped by the emitted flags.
      if (process.platform === 'win32' && this.pidAlive) this.emitSilenceWarnings();
      return;
    }
    this.sampling = true;

    // Check PID existence first
    try {
      process.kill(this.pid, 0); // signal 0 = existence check
    } catch {
      this.pidAlive = false;
      this.sampling = false;
      return;
    }

    // Windows: `ps` is not available — sample CPU via PowerShell CIM instead.
    // Emit silence warnings synchronously first (matching the pre-sampling
    // behavior) so they don't wait on the slow PowerShell round-trip.
    if (process.platform === 'win32') {
      this.emitSilenceWarnings();
      this.sampleWindowsCpu();
      return;
    }

    // Single ps call to get CPU for the WHOLE process tree (transitive).
    // When the CLI runs a tool call (e.g. pnpm test), the busy process is a
    // deep descendant (CLI → tool shell → test runner) while the CLI itself
    // idle-waits. Direct-children-only sampling misclassified those sessions
    // as idle-silent and triggered stallAutoKill (false positive).
    // Uses one `ps -A` instead of nested ps→pgrep→ps to avoid pgrep callback delays.
    execFile('ps', ['-A', '-o', 'pid=,ppid=,cputime='], (err, stdout) => {
      if (err) {
        this.pidAlive = false;
        this.sampling = false;
        return;
      }
      const rows: ProcessCpuRow[] = [];
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const pid = Number(parts[0]);
        const ppid = Number(parts[1]);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
        rows.push({ pid, ppid, cpuMs: parseCpuTime(parts[2]) });
      }
      const totalCpu = sumProcessTreeCpu(rows, this.pid);
      if (totalCpu === null) {
        this.pidAlive = false;
        this.sampling = false;
        return;
      }
      this.updateCpuSample(totalCpu);
    });
  }

  /**
   * Windows CPU sampling — PowerShell CIM query over Win32_Process.
   * Fetches the full pid/ppid/cpu table and sums the WHOLE descendant tree:
   * Windows 上 CLI 藏在 .ps1/.cmd 包装进程后面（probe 盯的是包装层 pid），
   * 烧 CPU 的是 cursor-agent → 工具 shell → pytest 这些深层后代——只看直接
   * 子进程会把忙碌会话误判 idle-silent（2026-08-12 quant 假超时事故）。
   * UserModeTime/KernelModeTime are in 100ns units → /10000 = ms.
   *
   * On ANY failure (PowerShell missing, WMI hiccup, timeout) fall back to the
   * previous conservative behavior: assume idle so stall detection still works.
   * Dead detection is NOT this method's job — process.kill(pid, 0) in
   * sampleOnce() owns it (WMI can transiently miss a live process).
   */
  private sampleWindowsCpu(): void {
    const script =
      `Get-CimInstance Win32_Process | ` +
      `ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, [math]::Round(($_.UserModeTime + $_.KernelModeTime) / 10000) }`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          this.cpuGrowing = false;
          this.emitSilenceWarnings();
          this.sampling = false;
          return;
        }
        const rows: ProcessCpuRow[] = [];
        for (const line of stdout.split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 3) continue;
          const pid = Number(parts[0]);
          const ppid = Number(parts[1]);
          const cpu = Number(parts[2]);
          if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(cpu)) continue;
          rows.push({ pid, ppid, cpuMs: cpu });
        }
        const totalCpu = sumProcessTreeCpu(rows, this.pid);
        if (totalCpu === null) {
          this.cpuGrowing = false;
          this.emitSilenceWarnings();
          this.sampling = false;
          return;
        }
        this.updateCpuSample(totalCpu);
      },
    );
  }

  /** Update CPU tracking and emit warnings after sampling */
  private updateCpuSample(totalCpuMs: number): void {
    this.prevCpuTimeMs = this.currCpuTimeMs;
    this.currCpuTimeMs = totalCpuMs;
    this.cpuGrowing = this.currCpuTimeMs > this.prevCpuTimeMs;
    this.emitSilenceWarnings();
    this.sampling = false;
  }

  /** Emit soft/stall warnings based on silence duration (shared by Windows and Unix paths) */
  private emitSilenceWarnings(): void {
    const silenceMs = Date.now() - this.lastActivityAt;
    if (silenceMs >= this.config.stallWarningMs && !this.stallWarningEmitted) {
      this.stallWarningEmitted = true;
      this.warningQueue.push(this.makeWarning('suspected_stall', silenceMs));
    } else if (silenceMs >= this.config.softWarningMs && !this.softWarningEmitted) {
      this.softWarningEmitted = true;
      this.warningQueue.push(this.makeWarning('alive_but_silent', silenceMs));
    }
  }

  private makeWarning(level: 'alive_but_silent' | 'suspected_stall', silenceDurationMs: number): LivenessWarningEvent {
    return {
      __livenessWarning: true,
      state: this.getState(),
      silenceDurationMs,
      level,
      cpuTimeMs: this.currCpuTimeMs,
      processAlive: this.pidAlive,
    };
  }
}
