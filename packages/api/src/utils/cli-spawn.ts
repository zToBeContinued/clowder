/**
 * CLI Process Spawner
 * 通用 CLI 子进程管理器，处理生命周期、超时和清理
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import type { Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { CliRawArchive } from '../domains/cats/services/session/CliRawArchive.js';
import { createModuleLogger } from '../infrastructure/logger.js';
import { registerLivenessProbe, unregisterLivenessProbe } from '../infrastructure/telemetry/instruments.js';
import { emitOtelLog } from '../infrastructure/telemetry/otel-logger.js';
import { invalidateCliCommand } from './cli-resolve.js';
import { resolveWindowsSpawnPlan } from './cli-spawn-win.js';
import { resolveCliTimeoutMs } from './cli-timeout.js';
import type { ChildProcessLike, CliSpawnOptions, SpawnFn } from './cli-types.js';
import { isParseError, parseNDJSON } from './ndjson-parser.js';
import { ProcessLivenessProbe } from './ProcessLivenessProbe.js';
import { killProcessTree, killProcessTreeSync } from './process-tree-kill.js';

const log = createModuleLogger('cli-spawn');

const IS_WINDOWS = process.platform === 'win32';

type CliErrorReasonCode = 'invalid_thinking_signature' | 'missing_rollout' | 'model_unavailable';

function classifyKnownCliStderr(stderr: string): CliErrorReasonCode | undefined {
  if (/Invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i.test(stderr)) {
    return 'invalid_thinking_signature';
  }
  if (/no rollout found/i.test(stderr)) {
    return 'missing_rollout';
  }
  // 账号权限/额度变化后 CLI 以 code 1 裸退出（2026-08-13 现场：claude/gpt
  // 从可用列表消失，猫全部哑火，用户只看到「CLI 异常退出 (code: 1)」）。
  if (/Cannot use this model/i.test(stderr)) {
    return 'model_unavailable';
  }
  return undefined;
}

/** 已知原因码的用户可读补充说明（不泄漏原始 stderr）。 */
const REASON_CODE_HINTS: Partial<Record<CliErrorReasonCode, string>> = {
  model_unavailable: '；账号当前无权使用所配模型（常见于额度用尽或套餐变化），请在 Hub 更换模型或检查账号',
};

/** Grace period between SIGTERM and SIGKILL */
export const KILL_GRACE_MS = 3_000;

/** Grace period after semantic completion before force-killing a lingering process */
export const SEMANTIC_COMPLETION_GRACE_MS = 5_000;

/**
 * 全 provider 通用的原始事件归档（诊断首段重发 / exit 1 / 事件序列反常）。
 *
 * provider 在自己**现有**的事件循环体里调用 `archiveRawEvent(invocationId, event)`
 * 即可归档——fire-and-forget，不 await、不改迭代结构。刻意不做成「包一层
 * async generator」的形式：那会在 spawnCli 与 provider 之间插入一次微任务
 * 调度，打乱 claude steer 等对 stdin/init 精确时序敏感的 provider。
 * codex 有自己的 sanitized 归档，不用本 helper。
 */
const sharedCliRawArchive = new CliRawArchive();

export function archiveRawEvent(invocationId: string | undefined, event: unknown): void {
  if (invocationId) void sharedCliRawArchive.append(invocationId, event).catch(() => {});
}

/**
 * Options for spawnCli (dependency injection for testing)
 */
export interface CliSpawnerDeps {
  /** Inject a custom spawn function (for testing) */
  spawnFn?: SpawnFn;
  /**
   * Inject a tree-kill function (for testing). Production default on Windows
   * is taskkill-based killProcessTree; POSIX keeps plain signals.
   * 注意：注入 spawnFn（假子进程/假 pid）而未注入 treeKillFn 时，树击杀自动
   * 关闭——否则单测会对无辜的真实 PID 执行 taskkill。
   */
  treeKillFn?: (pid: number) => Promise<boolean>;
  /** Inject a liveness-probe factory (for deterministic timing tests). */
  probeFactory?: (pid: number, config: NonNullable<CliSpawnOptions['livenessProbe']>) => ProcessLivenessProbe;
}

/** Env vars to strip from child processes to prevent E2BIG (overly large values). */
const ENV_VARS_TO_STRIP: ReadonlySet<string> = new Set([
  'LS_COLORS', // typically 1-2 KB of color mappings
  'LSCOLORS', // BSD/macOS equivalent
]);

export function buildChildEnv(overrides?: Record<string, string | null>): NodeJS.ProcessEnv {
  // Clone process.env but strip known bloated vars to avoid E2BIG (ARG_MAX exceeded).
  const merged: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ENV_VARS_TO_STRIP.has(key)) continue;
    merged[key] = value;
  }
  if (!overrides) return merged;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * Spawns a CLI process and yields parsed NDJSON events from stdout.
 * On non-zero exit: yields __cliError. On timeout: yields __cliTimeout.
 * On spawn error (ENOENT): throws. Messages are sanitized (no raw stderr).
 */
export async function* spawnCli(
  options: CliSpawnOptions,
  deps?: CliSpawnerDeps,
): AsyncGenerator<unknown, void, undefined> {
  const doSpawn: SpawnFn = deps?.spawnFn ?? defaultSpawn;
  // Default timeout is configurable via CLI_TIMEOUT_MS env var; 0 disables timeout.
  const timeoutMs = resolveCliTimeoutMs(options.timeoutMs);

  // Log only flag names (--foo) and arg count — never raw values.
  // Multiple providers pass prompt text via different shapes (positional,
  // --prompt, -p, after --) so pattern-based redaction is unreliable.
  const flagNames = options.args.filter((a) => a.startsWith('-'));
  log.debug(
    {
      command: options.command,
      flagNames,
      argCount: options.args.length,
      cwd: options.cwd,
      timeoutMs,
      invocationId: options.invocationId,
    },
    '[cli-spawn] Spawning CLI process',
  );

  let stdinCleanup: (() => void) | undefined;
  const child = doSpawn(options.command, options.args, {
    cwd: options.cwd,
    env: buildChildEnv(options.env),
    stdio: [options.stdinLineSink ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  log.debug({ pid: child.pid, command: options.command }, 'CLI process spawned');

  if (options.stdinLineSink && child.stdin) {
    const cleanup = options.stdinLineSink({
      writeLine(line: string): boolean {
        return child.stdin?.write(line.endsWith('\n') ? line : `${line}\n`) ?? false;
      },
      writeJsonLine(value: unknown): boolean {
        return child.stdin?.write(`${JSON.stringify(value)}\n`) ?? false;
      },
      end(): void {
        child.stdin?.end();
      },
    });
    if (typeof cleanup === 'function') stdinCleanup = cleanup;
  } else if (options.stdinLineSink) {
    log.warn({ command: options.command }, 'stdinLineSink requested but child stdin is unavailable');
  }

  // F153 Phase B: Create CLI session child span under invocation span
  let cliSpan: Span | undefined;
  if (options.parentSpan) {
    const tracer = trace.getTracer('cat-cafe-api');
    const parentCtx = trace.setSpan(context.active(), options.parentSpan);
    cliSpan = tracer.startSpan(
      'cat_cafe.cli_session',
      {
        attributes: {
          'cli.command': options.command,
          'cli.arg_count': options.args.length,
          ...(child.pid ? { 'cli.pid': child.pid } : {}),
          ...(options.invocationId ? { invocationId: options.invocationId } : {}),
          ...(options.cliSessionId ? { sessionId: options.cliSessionId } : {}),
        },
      },
      parentCtx,
    );
  }

  // Buffer stderr for error reporting (handler attached after resetTimeout is defined)
  let stderrBuffer = '';

  // Track child exit state (P1: prevents PID reuse kills)
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const exitPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      childExited = true;
      exitCode = code;
      exitSignal = signal;
      log.debug({ pid: child.pid, command: options.command, exitCode: code, signal }, 'CLI process exited');
      resolve();
    });
  });

  // Handle spawn errors (P2: ENOENT for command-not-found)
  let spawnError: Error | undefined;
  child.once('error', (err: Error) => {
    spawnError = err;
    // F173 Phase D AC-D1: ENOENT means cached path is stale (binary uninstalled,
    // symlink rebuild moved target, etc.). Drop the cache entry so the next
    // resolveCliCommand call re-probes; otherwise we ENOENT-loop forever
    // until process restart.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      invalidateCliCommand(options.command);
    }
  });

  let killed = false;
  let timedOut = false;
  let stallKilled = false; // #774: set when idle-silent stall triggers auto-kill
  // F118 P1-fix: Snapshot process liveness at the moment timeout fires,
  // BEFORE killChild() — otherwise childExited is always true by yield time.
  let processAliveAtTimeout = false;
  let escalationTimer: ReturnType<typeof setTimeout> | undefined;

  // 2026-08-12 quant 幽灵写手事故：Windows 上 CLI 经 .ps1/.cmd/git-bash 包装
  // 进程启动，child.kill() 只杀包装层，真 CLI 孙进程沦为孤儿继续写工作树，
  // 槽位释放后同猫被二次拉起 → 双进程同任务。Windows 生产路径必须树击杀。
  // 注入了假 spawnFn（单测）时禁用默认树击杀，避免 taskkill 真实误伤。
  const treeKillFn = deps?.treeKillFn ?? (IS_WINDOWS && !deps?.spawnFn ? killProcessTree : undefined);
  let treeKillPromise: Promise<void> | undefined;

  function killChild(): void {
    if (killed || childExited) return;
    killed = true;
    if (treeKillFn && child.pid !== undefined) {
      // 必须先树击杀再考虑直接击杀：先杀包装进程会让 taskkill 无法从死掉的
      // 父进程枚举子树，孙进程照样漏网。
      const pid = child.pid;
      treeKillPromise = treeKillFn(pid)
        .then((ok) => {
          if (!ok && !childExited) child.kill('SIGKILL');
        })
        .catch(() => {
          if (!childExited) child.kill('SIGKILL');
        });
      return;
    }
    child.kill('SIGTERM');
    escalationTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    escalationTimer.unref();
    child.on('exit', () => {
      if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    });
  }

  // Timeout: reset on any output, timeoutMs=0 disables
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let probe: ProcessLivenessProbe | undefined; // F118: declared early for closure access
  // 硬帽按「连续静默时长」而非「会话总时长」计算。旧算法用 startedAt：会话
  // 年龄一过 factor×timeout（默认 6 分钟），busy-silent 的延长一律被拒——
  // quant 事故 22:26:41 的击杀正是会话 371s > 360s 帽、延长被拒（当时 pytest
  // 还在烧 CPU）。改为静默起点计时后，长会话与新会话同权：连续静默最多
  // factor×timeout，期间只要 CPU 在长就延长。
  let silenceStartedAt = Date.now();
  const armTimeout = (): void => {
    if (timeoutMs === 0) return; // Disabled
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = setTimeout(() => {
      // F118: If busy-silent (CPU growing), extend timeout unless hard cap exceeded
      if (probe?.shouldExtendTimeout()) {
        const silenceMs = Date.now() - silenceStartedAt;
        if (!probe.isHardCapExceeded(silenceMs, timeoutMs)) {
          armTimeout(); // extend once more — 不前移 silenceStartedAt
          return;
        }
      }
      timedOut = true;
      processAliveAtTimeout = !childExited;
      killChild();
    }, timeoutMs);
    timeoutTimer.unref();
  };
  const resetTimeout = (): void => {
    if (timeoutMs === 0) return; // Disabled
    silenceStartedAt = Date.now();
    armTimeout();
  };
  if (timeoutMs > 0) armTimeout(); // Start initial timeout only if enabled

  // Attach stderr handler now that resetTimeout is defined
  // Reset timeout on stderr activity — CLI is alive (working on tools, thinking, etc.)
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    resetTimeout();
    probe?.notifyActivity(); // F118: stderr = CLI alive, sync to probe
  });

  // AbortSignal
  const abortHandler = (): void => killChild();
  if (options.signal) {
    if (options.signal.aborted) {
      killChild();
    } else {
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  // Zombie prevention (P1: guard with childExited to prevent PID reuse kills)
  const exitHandler = (): void => {
    if (!childExited && child.pid !== undefined) {
      // Windows 生产路径同样必须树击杀：API 退出时只杀包装层一样会留孤儿写手。
      // exit handler 里只能同步执行，用 spawnSync 版本。
      if (IS_WINDOWS && !deps?.spawnFn && !deps?.treeKillFn) {
        if (killProcessTreeSync(child.pid)) return;
      }
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // Process already gone
      }
    }
  };
  process.on('exit', exitHandler);

  // F118: Track NDJSON event timestamps for timeout diagnostics
  let firstEventAt: number | null = null;
  let lastEventAt: number | null = null;
  let lastEventType: string | null = null;

  // F118 Phase B: Initialize liveness probe
  if (options.livenessProbe && child.pid !== undefined) {
    probe = deps?.probeFactory
      ? deps.probeFactory(child.pid, options.livenessProbe)
      : new ProcessLivenessProbe(child.pid, options.livenessProbe);
    probe.start();
    // F152: Register probe for OTel agentLiveness gauge
    if (options.invocationId) {
      const catId = options.env?.CAT_CAFE_CAT_ID ?? 'unknown';
      registerLivenessProbe(options.invocationId, catId, () => probe!.getState());
    }
  }

  try {
    if (!child.stdout) {
      throw new Error(`CLI process ${options.command} has no stdout`);
    }

    // Throw on spawn error before iterating
    if (spawnError) {
      throw spawnError;
    }

    const ndjson = parseNDJSON(child.stdout)[Symbol.asyncIterator]();
    let pendingNext = ndjson.next();

    // #774 R2: Deferred stall-kill — only execute when probe timer wins the race,
    // meaning no NDJSON event arrived. If NDJSON wins, the pending kill is cancelled
    // because CLI has recovered. This prevents the stale-warning race condition where
    // a recovery event is pending in the stream but hasn't been consumed yet.
    let pendingStallKill = false;

    for (;;) {
      if (spawnError) throw spawnError;

      // F118: Drain probe warnings and check for dead process
      if (probe) {
        for (const warning of probe.drainWarnings()) {
          yield warning;
          // #774: Mark for deferred kill — don't kill here (recovery NDJSON may be pending)
          if (
            options.livenessProbe?.stallAutoKill &&
            warning.level === 'suspected_stall' &&
            warning.state === 'idle-silent'
          ) {
            pendingStallKill = true;
          }
        }
        if (probe.getState() === 'dead') {
          killChild();
          break;
        }
      }

      // Race NDJSON event vs probe poll interval
      let raceTimer: ReturnType<typeof setTimeout> | undefined;
      const raceResult = probe
        ? await Promise.race([
            pendingNext.then((r) => {
              if (raceTimer !== undefined) clearTimeout(raceTimer);
              return { source: 'ndjson' as const, result: r };
            }),
            new Promise<{ source: 'probe' }>((r) => {
              raceTimer = setTimeout(() => r({ source: 'probe' }), probe.config.sampleIntervalMs);
            }),
          ])
        : { source: 'ndjson' as const, result: await pendingNext };

      if (raceResult.source === 'probe') {
        // No NDJSON arrived — if stall-kill is pending, execute it now
        if (pendingStallKill) {
          stallKilled = true;
          timedOut = true;
          processAliveAtTimeout = !childExited;
          killChild();
          break;
        }
        continue;
      }

      // NDJSON event arrived — CLI is alive, cancel any pending stall-kill
      pendingStallKill = false;

      const { done, value } = raceResult.result;
      if (done) break;

      if (isParseError(value)) {
        const parseErr = value as { line: string };
        log.warn({ command: options.command, line: parseErr.line }, 'CLI non-JSON output');
        yield value;
        pendingNext = ndjson.next();
        continue;
      }
      // Reset timeout only after a valid NDJSON event.
      // Invalid chatter should not keep a stuck invocation alive forever.
      resetTimeout();
      if (probe) probe.notifyActivity();
      // F118: Record event timestamps for diagnostic enrichment
      const now = Date.now();
      if (firstEventAt === null) firstEventAt = now;
      lastEventAt = now;
      if (typeof value === 'object' && value !== null && 'type' in value) {
        lastEventType = String((value as Record<string, unknown>).type);
      }
      yield value;
      pendingNext = ndjson.next();
    }

    if (probe) {
      await probe.flushPendingWarnings();
      for (const warning of probe.drainWarnings()) {
        yield warning;
        if (
          options.livenessProbe?.stallAutoKill &&
          warning.level === 'suspected_stall' &&
          warning.state === 'idle-silent'
        ) {
          stallKilled = true;
          timedOut = true;
          processAliveAtTimeout = !childExited;
          killChild();
        }
      }
    }

    // Check for spawn error that arrived during/after iteration
    if (spawnError) throw spawnError;

    // Issue #116: If provider signaled semantic completion, give a short grace period
    // instead of blocking on full exit. Process gets SEMANTIC_COMPLETION_GRACE_MS to
    // exit naturally; if it doesn't, killChild() in finally will clean up.
    const semanticDone = options.semanticCompletionSignal?.aborted === true;

    if (!semanticDone) {
      // Wait for child to fully exit after stdout closes
      await exitPromise;
    } else if (!childExited) {
      // Grace period: give the process time to exit naturally before force-killing.
      // If it exits within grace, great; if not, killChild() in finally will clean up.
      await Promise.race([exitPromise, new Promise<void>((r) => setTimeout(r, SEMANTIC_COMPLETION_GRACE_MS).unref())]);
    }

    if (exitCode === 0 && exitSignal === null && stderrBuffer.trim()) {
      log.debug(
        {
          command: options.command,
          hadNdjsonEvent: firstEventAt !== null,
          stderr: stderrBuffer.trim().slice(-1000),
        },
        'CLI stderr on successful exit',
      );
    }

    // Yield error on abnormal exit (only if WE didn't kill it AND no semantic completion)
    // Covers both non-zero exitCode AND external signal kills
    // Windows: exit code 3221226505 (0xC0000409 STATUS_STACK_BUFFER_OVERRUN) is a libuv
    // assertion crash in the MCP subprocess shutdown path. If we already received valid
    // NDJSON events, the CLI output is fine — suppress the spurious error.
    const isWindowsLibuvCrash = process.platform === 'win32' && exitCode === 3221226505 && semanticDone;
    if (!semanticDone && !killed && !isWindowsLibuvCrash && (exitCode !== 0 || exitSignal !== null)) {
      const reasonCode = classifyKnownCliStderr(stderrBuffer);
      // Log stderr for debugging (never expose to users — may contain thinking/traces)
      if (stderrBuffer.trim()) {
        log.error({ command: options.command, stderr: stderrBuffer.trim().slice(-1000) }, 'CLI stderr (debug only)');
      }
      const reasonHint = reasonCode ? (REASON_CODE_HINTS[reasonCode] ?? '') : '';
      yield {
        __cliError: true,
        exitCode,
        signal: exitSignal,
        // Sanitized message — no raw stderr exposed to users
        message: `CLI 异常退出 (code: ${exitCode ?? 'null'}, signal: ${exitSignal ?? 'none'})${reasonHint}`,
        command: options.command,
        ...(reasonCode ? { reasonCode } : {}),
      };
    }

    // Yield timeout error (distinct from user cancel which stays silent)
    if (timedOut) {
      // Log stderr for debugging (never expose to users)
      if (stderrBuffer.trim()) {
        log.error(
          { command: options.command, stderr: stderrBuffer.trim().slice(-1000) },
          'CLI stderr on timeout (debug only)',
        );
      }
      const stallWarningMs = probe?.config.stallWarningMs;
      yield {
        __cliTimeout: true,
        timeoutMs: stallKilled && stallWarningMs ? stallWarningMs : timeoutMs,
        // Sanitized message — no raw stderr exposed to users
        message: stallKilled
          ? `CLI idle-silent 超时 (${Math.round((stallWarningMs ?? timeoutMs) / 1000)}s — stall auto-kill)`
          : `CLI 响应超时 (${Math.round(timeoutMs / 1000)}s)`,
        command: options.command,
        // F118: Diagnostic enrichment
        firstEventAt,
        lastEventAt,
        lastEventType,
        silenceDurationMs: lastEventAt ? Date.now() - lastEventAt : timeoutMs,
        processAlive: processAliveAtTimeout,
        ...(stallKilled ? { stallKill: true } : {}),
        ...(options.invocationId ? { invocationId: options.invocationId } : {}),
        ...(options.cliSessionId ? { cliSessionId: options.cliSessionId } : {}),
        ...(options.rawArchivePath ? { rawArchivePath: options.rawArchivePath } : {}),
      };
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (escalationTimer !== undefined) clearTimeout(escalationTimer);
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    process.off('exit', exitHandler);
    probe?.stop();
    try {
      stdinCleanup?.();
    } catch {
      // Best-effort cleanup only. The child process is killed below if still alive.
    }
    // F152: Unregister probe from OTel gauge
    if (options.invocationId) unregisterLivenessProbe(options.invocationId);
    killChild();
    // 等树击杀落地再让 generator 结束：上游在 generator 结束后立刻释放
    // (thread, cat) 槽位并可能拉起替补进程——树没死透就放行，等于把
    // 「旧写手还活着 + 新进程已启动」的双写窗口重新打开。
    if (treeKillPromise) {
      try {
        await treeKillPromise;
      } catch {
        // 树击杀永不 reject；防御性兜底，不阻塞收尾
      }
    }

    // F153 Phase B: End CLI session span with appropriate status
    if (cliSpan) {
      if (timedOut) {
        cliSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'CLI timeout' });
        emitOtelLog('ERROR', 'cli_session_timeout', { 'cli.timeout_ms': timeoutMs }, cliSpan);
      } else if (exitCode !== null && exitCode !== 0) {
        cliSpan.setStatus({ code: SpanStatusCode.ERROR, message: `CLI exit code ${exitCode}` });
        emitOtelLog('ERROR', 'cli_session_error', { 'cli.exit_code': exitCode }, cliSpan);
      } else if (exitSignal) {
        cliSpan.setStatus({ code: SpanStatusCode.ERROR, message: `CLI killed by ${exitSignal}` });
        emitOtelLog('WARN', 'cli_session_killed', { 'cli.signal': exitSignal }, cliSpan);
      } else {
        cliSpan.setStatus({ code: SpanStatusCode.OK });
      }
      cliSpan.setAttribute('cli.exit_code', exitCode ?? -1);
      if (exitSignal) cliSpan.setAttribute('cli.exit_signal', exitSignal);
      cliSpan.end();
    }
  }
}

/**
 * Type guard for CLI error objects (abnormal exit or external signal kill)
 * Note: `message` is sanitized for user display; raw stderr is logged to console only.
 */
export function isCliError(value: unknown): value is {
  __cliError: true;
  exitCode: number | null;
  signal: string | null;
  message: string;
  command: string;
  reasonCode?: CliErrorReasonCode;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__cliError' in value &&
    (value as Record<string, unknown>).__cliError === true
  );
}

/**
 * Type guard for CLI timeout objects (process killed due to timeout)
 * Note: `message` is sanitized for user display; raw stderr is logged to console only.
 */
export function isCliTimeout(value: unknown): value is {
  __cliTimeout: true;
  timeoutMs: number;
  message: string;
  command: string;
  // F118 AC-C3: Diagnostic enrichment fields
  silenceDurationMs?: number;
  processAlive?: boolean;
  lastEventType?: string;
  firstEventAt?: number;
  lastEventAt?: number;
  cliSessionId?: string;
  invocationId?: string;
  rawArchivePath?: string;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__cliTimeout' in value &&
    (value as Record<string, unknown>).__cliTimeout === true
  );
}

/**
 * Type guard for liveness warning events from ProcessLivenessProbe (F118 Phase C)
 */
export function isLivenessWarning(value: unknown): value is import('./ProcessLivenessProbe.js').LivenessWarningEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__livenessWarning' in value &&
    (value as Record<string, unknown>).__livenessWarning === true
  );
}

/**
 * Default spawn function wrapping child_process.spawn.
 *
 * On Windows (#64): bypasses .cmd shim by resolving the underlying .js
 * script and spawning via `node` directly. Falls back to `shell: true`
 * if shim resolution fails.
 */
function defaultSpawn(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    stdio: ['ignore' | 'pipe', 'pipe', 'pipe'];
  },
): ChildProcessLike {
  if (IS_WINDOWS) {
    const spawnPlan = resolveWindowsSpawnPlan(command, args);
    if (spawnPlan.mode === 'shim') {
      log.debug(
        {
          original: command,
          resolved: spawnPlan.command,
          argCount: spawnPlan.args.length,
          mode: spawnPlan.mode,
          shell: spawnPlan.shell,
        },
        'Windows shim resolved',
      );
    } else {
      log.debug(
        {
          original: command,
          resolved: spawnPlan.command,
          argCount: spawnPlan.args.length,
          mode: spawnPlan.mode,
          shell: spawnPlan.shell,
        },
        'Windows spawn plan resolved',
      );
    }
    return nodeSpawn(spawnPlan.command, spawnPlan.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
      ...(spawnPlan.shell !== undefined ? { shell: spawnPlan.shell } : {}),
    });
  }

  // macOS GUI apps (Electron) have a minimal PATH that excludes version
  // managers (nvm/fnm/Volta). CLI shims use `#!/usr/bin/env node`, so the
  // child process must be able to find `node` in its PATH. Prepend the
  // directory containing the resolved CLI binary — it typically sits next
  // to the `node` binary that installed it (e.g. ~/.nvm/versions/node/v20/bin/).
  const env = { ...options.env };
  if (isAbsolute(command)) {
    const binDir = dirname(command);
    env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir;
  }

  return nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env,
    stdio: options.stdio,
  });
}
