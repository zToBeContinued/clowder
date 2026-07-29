/**
 * TranscriptWriter — F24 Phase C
 * Streams invocation events to JSONL as they arrive; writes index + digest on seal.
 *
 * File structure per session:
 *   <dataDir>/threads/<threadId>/<catId>/sessions/<sessionId>/
 *     events.jsonl           — NDJSON events with envelope
 *     index.json             — sparse byte-offset index for pagination
 *     digest.extractive.json — rule-based extractive digest
 *
 * events.jsonl envelope:
 *   { v:1, t:number, threadId, catId, sessionId, cliSessionId, invocationId?, eventNo, event }
 *
 * Durability: events used to live only in memory until seal, so an API crash (or any exit
 * that never reaches the sealer) lost the entire raw event stream — the one copy that
 * IndexBuilder falls back to once Redis messages expire. Each appendEvent now schedules an
 * append to events.jsonl behind a per-session promise chain, so a crash costs at most the
 * events still in flight. The in-memory buffer is kept regardless: generateExtractiveDigest
 * reads it at seal time, and it is what assigns eventNo.
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import {
  type CollaborationContinuityCapsuleV1,
  extractContinuityCapsuleFromSystemInfo,
} from '../agents/invocation/CollaborationContinuityCapsule.js';
import { stripLeakedToolCallPayload } from '../agents/routing/route-helpers.js';

const log = createModuleLogger('transcript-writer');

export interface TranscriptSessionInfo {
  sessionId: string;
  threadId: string;
  catId: string;
  cliSessionId: string;
  seq: number;
}

interface BufferedEvent {
  eventNo: number;
  timestamp: number;
  invocationId?: string;
  event: Record<string, unknown>;
}

export interface ExtractiveDigestV1 {
  v: 1;
  sessionId: string;
  threadId: string;
  catId: string;
  seq: number;
  time: { createdAt: number; sealedAt: number };
  invocations: Array<{
    invocationId?: string;
    toolNames?: string[];
  }>;
  filesTouched: Array<{
    path: string;
    ops: string[];
  }>;
  errors: Array<{
    at: number;
    invocationId?: string;
    message: string;
  }>;
  /** Last visible assistant text messages, carried verbatim as reference data for continuity. */
  recentMessages?: Array<{
    role: 'assistant';
    invocationId?: string;
    content: string;
  }>;
  /** Latest structured collaboration control-flow state captured at a seal boundary. */
  continuityCapsule?: CollaborationContinuityCapsuleV1;
}

export interface TranscriptWriterOptions {
  dataDir: string;
  /** Sparse index stride (default 100) */
  indexStride?: number;
}

export interface HandoffDigestMeta {
  v: number;
  model: string;
  generatedAt: number;
}

/** Per-session bookkeeping for the incremental events.jsonl append. */
interface PersistState {
  sessionDir: string;
  /** Events already on disk from an earlier process (see adoptExistingFile). */
  eventNoBase: number;
  /** How many entries of the current in-memory buffer are already appended. */
  writtenCount: number;
  /** Current file size in bytes, i.e. the offset the next line starts at. */
  byteOffset: number;
  /** Sparse index offsets, absolute within the file. */
  offsets: number[];
}

export class TranscriptWriter {
  private readonly dataDir: string;
  private readonly indexStride: number;
  /** sessionId → buffered events */
  private buffers = new Map<string, BufferedEvent[]>();
  /** sessionId → threadId, so a thread purge can drop pending buffers too */
  private bufferedThreadIds = new Map<string, string>();
  /** sessionId → on-disk append bookkeeping */
  private persistStates = new Map<string, PersistState>();
  /** sessionId → tail of the serialized append chain, so appends never interleave */
  private persistChains = new Map<string, Promise<void>>();

  constructor(opts: TranscriptWriterOptions) {
    this.dataDir = opts.dataDir;
    this.indexStride = opts.indexStride ?? 100;
  }

  /**
   * Buffer a raw event and schedule it to be appended to events.jsonl.
   *
   * Stays synchronous and never throws: callers treat it as fire-and-forget, and a transcript
   * write failure must not break an invocation. Persistence errors are logged once per append.
   */
  appendEvent(session: TranscriptSessionInfo, event: Record<string, unknown>, invocationId?: string): void {
    let buf = this.buffers.get(session.sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(session.sessionId, buf);
    }
    this.bufferedThreadIds.set(session.sessionId, session.threadId);
    buf.push({
      eventNo: buf.length,
      timestamp: Date.now(),
      ...(invocationId !== undefined ? { invocationId } : {}),
      event,
    });
    this.schedulePersist(session);
  }

  /**
   * Queue a persist pass behind whatever is already running for this session.
   *
   * Bursty streams (text deltas) coalesce naturally: while one append is in flight the
   * newly buffered events pile up and the next pass writes them in a single call.
   */
  private schedulePersist(session: TranscriptSessionInfo): void {
    const sessionId = session.sessionId;
    const previous = this.persistChains.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.persistPending(session))
      .catch((err) => {
        log.warn(
          { sessionId, threadId: session.threadId, catId: session.catId, err: String(err) },
          'Transcript incremental append failed; events stay buffered for the seal-time flush',
        );
      });
    this.persistChains.set(sessionId, next);
  }

  /** Append every buffered-but-unwritten event for a session. Must run inside the chain. */
  private async persistPending(session: TranscriptSessionInfo): Promise<void> {
    const buf = this.buffers.get(session.sessionId);
    if (!buf || buf.length === 0) return;

    const state = await this.ensurePersistState(session);
    const pending = buf.slice(state.writtenCount);
    if (pending.length === 0) return;

    let chunk = '';
    let byteOffset = state.byteOffset;
    const offsets: number[] = [];
    for (const entry of pending) {
      const absoluteEventNo = state.eventNoBase + entry.eventNo;
      if (absoluteEventNo % this.indexStride === 0) {
        offsets.push(byteOffset);
      }
      const line = this.serializeEnvelope(session, entry, absoluteEventNo);
      chunk += `${line}\n`;
      byteOffset += Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
    }

    await appendFile(join(state.sessionDir, 'events.jsonl'), chunk, 'utf-8');

    // Only commit bookkeeping after the write lands, so a failed append is retried
    // by the next pass instead of being silently skipped.
    state.writtenCount += pending.length;
    state.byteOffset = byteOffset;
    state.offsets.push(...offsets);
  }

  private serializeEnvelope(session: TranscriptSessionInfo, entry: BufferedEvent, eventNo: number): string {
    return JSON.stringify({
      v: 1,
      t: entry.timestamp,
      threadId: session.threadId,
      catId: session.catId,
      sessionId: session.sessionId,
      cliSessionId: session.cliSessionId,
      invocationId: entry.invocationId,
      eventNo,
      event: entry.event,
    });
  }

  private async ensurePersistState(session: TranscriptSessionInfo): Promise<PersistState> {
    const existing = this.persistStates.get(session.sessionId);
    if (existing) return existing;

    const sessionDir = this.sessionDir(session);
    await mkdir(sessionDir, { recursive: true });
    const adopted = await this.adoptExistingFile(join(sessionDir, 'events.jsonl'));
    const state: PersistState = { sessionDir, ...adopted };
    this.persistStates.set(session.sessionId, state);
    return state;
  }

  /**
   * Continue an events.jsonl left by an earlier process instead of clobbering or duplicating it.
   *
   * A session stays active across an API restart (session-active:* lives in Redis), so the
   * fresh in-memory buffer starts numbering at 0 again while the file already holds events.
   * Appending blindly would produce duplicate eventNo values; the previous whole-file
   * writeFile-on-seal would instead have dropped everything written before the restart.
   * Scanning once gives us the real line count, size and stride offsets to carry on from.
   */
  private async adoptExistingFile(
    jsonlPath: string,
  ): Promise<{ eventNoBase: number; writtenCount: number; byteOffset: number; offsets: number[] }> {
    const empty = { eventNoBase: 0, writtenCount: 0, byteOffset: 0, offsets: [] as number[] };
    try {
      const info = await stat(jsonlPath);
      if (!info.isFile() || info.size === 0) return empty;
    } catch {
      return empty;
    }

    let eventNoBase = 0;
    let byteOffset = 0;
    const offsets: number[] = [];
    try {
      const rl = createInterface({ input: createReadStream(jsonlPath, 'utf-8'), crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of rl) {
        if (line.trim().length === 0) continue;
        if (eventNoBase % this.indexStride === 0) offsets.push(byteOffset);
        byteOffset += Buffer.byteLength(line, 'utf-8') + 1;
        eventNoBase++;
      }
    } catch (err) {
      log.warn({ jsonlPath, err: String(err) }, 'Could not scan existing transcript; starting a fresh append cursor');
      return empty;
    }

    return { eventNoBase, writtenCount: 0, byteOffset, offsets };
  }

  /** Wait for the in-flight appends of one session (or all sessions) to settle. */
  async drain(sessionId?: string): Promise<void> {
    const chains = sessionId
      ? [this.persistChains.get(sessionId)].filter((c): c is Promise<void> => Boolean(c))
      : [...this.persistChains.values()];
    await Promise.all(chains.map((chain) => chain.catch(() => {})));
  }

  /** Get buffered events for a session (for testing). */
  getBufferedEvents(sessionId: string): BufferedEvent[] {
    return this.buffers.get(sessionId) ?? [];
  }

  /** Get buffered event count for a session. */
  getEventCount(sessionId: string): number {
    return this.buffers.get(sessionId)?.length ?? 0;
  }

  /**
   * Seal-time finalization: append whatever is still unwritten, then write index + digest.
   * Clears the buffer afterwards.
   *
   * events.jsonl is no longer rewritten here — it has been growing all along, so this only
   * needs to catch the tail. index.json and the digest are still whole-file writes: they are
   * small, derived, and only meaningful once the session is complete.
   */
  async flush(session: TranscriptSessionInfo, sealTimestamps?: { createdAt: number; sealedAt: number }): Promise<void> {
    const buf = this.buffers.get(session.sessionId);
    if (!buf || buf.length === 0) {
      return;
    }

    // Let queued appends finish first, otherwise this pass and an in-flight one could both
    // claim the same pending slice.
    await this.drain(session.sessionId);
    await this.persistPending(session);

    const state = await this.ensurePersistState(session);
    const sessionDir = state.sessionDir;

    const index = {
      v: 1,
      eventCount: state.eventNoBase + buf.length,
      stride: this.indexStride,
      offsets: state.offsets,
    };
    await writeFile(join(sessionDir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');

    if (sealTimestamps) {
      const digest = this.generateExtractiveDigest(session, sealTimestamps);
      await writeFile(join(sessionDir, 'digest.extractive.json'), JSON.stringify(digest, null, 2), 'utf-8');
    }

    this.buffers.delete(session.sessionId);
    this.bufferedThreadIds.delete(session.sessionId);
    this.persistStates.delete(session.sessionId);
    this.persistChains.delete(session.sessionId);
  }

  /**
   * Generate extractive digest from buffered events.
   * Rule-based extraction: no LLM, deterministic, zero cost.
   */
  generateExtractiveDigest(
    session: TranscriptSessionInfo,
    sealTimestamps: { createdAt: number; sealedAt: number },
  ): ExtractiveDigestV1 {
    const buf = this.buffers.get(session.sessionId) ?? [];

    // Extract tool names (deduplicated per invocation group)
    const toolNames = new Set<string>();
    const filePaths = new Map<string, Set<string>>(); // path → ops
    const errors: ExtractiveDigestV1['errors'] = [];
    const recentMessages: NonNullable<ExtractiveDigestV1['recentMessages']> = [];
    const recentMessageByStream = new Map<string, NonNullable<ExtractiveDigestV1['recentMessages']>[number]>();
    let continuityCapsule: CollaborationContinuityCapsuleV1 | undefined;

    for (const entry of buf) {
      const evt = entry.event;
      const evtType = evt.type;
      // R11 P1-2: Support both AgentMessage fields (toolName/toolInput) and
      // raw NDJSON fields (name/input). In production, appendEvent receives
      // AgentMessage objects, which use toolName/toolInput.
      const evtName = (evt.toolName ?? evt.name) as string | undefined;

      // Tool use events
      if (evtType === 'tool_use' && typeof evtName === 'string') {
        toolNames.add(evtName);

        // Extract file paths from tool input (AgentMessage: toolInput, raw: input)
        const input = (evt.toolInput ?? evt.input) as Record<string, unknown> | undefined;
        if (input) {
          const filePath = (input.file_path ?? input.path) as string | undefined;
          if (filePath && typeof filePath === 'string') {
            const ops = filePaths.get(filePath) ?? new Set();
            const opName = this.toolNameToOp(evtName);
            if (opName) ops.add(opName);
            filePaths.set(filePath, ops);
          }
        }
      }

      // Error events — AgentMessage uses type='error'+error field;
      // raw NDJSON uses type='tool_result'+is_error+content
      if (evtType === 'tool_result' && evt.is_error) {
        const evtContent = evt.content;
        const message = typeof evtContent === 'string' ? evtContent : JSON.stringify(evtContent);
        errors.push({
          at: entry.timestamp,
          ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
          message: message.slice(0, 500),
        });
      }
      if (evtType === 'error' && typeof evt.error === 'string') {
        errors.push({
          at: entry.timestamp,
          ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
          message: (evt.error as string).slice(0, 500),
        });
      }
      if (evtType === 'system_info' && typeof evt.content === 'string') {
        continuityCapsule = extractContinuityCapsuleFromSystemInfo(evt.content) ?? continuityCapsule;
      }

      const streamKey =
        evtType === 'text' && entry.invocationId !== undefined
          ? `${entry.invocationId}:${typeof evt.catId === 'string' ? evt.catId : session.catId}`
          : null;
      const visibleText = extractVisibleAssistantText(evt, { trim: streamKey === null });
      if (visibleText) {
        if (streamKey) {
          const existing = recentMessageByStream.get(streamKey);
          if (existing && recentMessages[recentMessages.length - 1] === existing) {
            const content = normalizeVisibleText(coalesceVisibleText(existing.content, visibleText, evt.textMode), {
              trim: false,
            });
            if (content) {
              existing.content = content.slice(0, 1200);
              moveToEnd(recentMessages, existing);
            } else {
              removeItem(recentMessages, existing);
              recentMessageByStream.delete(streamKey);
            }
          } else {
            const message = {
              role: 'assistant' as const,
              ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
              content: visibleText.slice(0, 1200),
            };
            recentMessages.push(message);
            recentMessageByStream.set(streamKey, message);
          }
        } else {
          recentMessages.push({
            role: 'assistant',
            ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
            content: visibleText.slice(0, 1200),
          });
        }
      }
    }

    return {
      v: 1,
      sessionId: session.sessionId,
      threadId: session.threadId,
      catId: session.catId,
      seq: session.seq,
      time: sealTimestamps,
      invocations: [
        {
          toolNames: [...toolNames],
        },
      ],
      filesTouched: [...filePaths.entries()].map(([path, ops]) => ({
        path,
        ops: [...ops],
      })),
      errors,
      recentMessages: recentMessages.slice(-5),
      ...(continuityCapsule ? { continuityCapsule } : {}),
    };
  }

  /**
   * Write handoff digest to a session directory.
   * F065 Phase C: static so it can be called from SessionSealer without instance state.
   */
  static async writeHandoffDigest(sessionDir: string, meta: HandoffDigestMeta, body: string): Promise<void> {
    const frontmatter = ['---', `v: ${meta.v}`, `model: ${meta.model}`, `generatedAt: ${meta.generatedAt}`, '---'].join(
      '\n',
    );

    await writeFile(join(sessionDir, 'digest.handoff.md'), `${frontmatter}\n\n${body}\n`, 'utf-8');
  }

  /** Map tool name to file operation type. */
  private toolNameToOp(name: string): string | null {
    switch (name.toLowerCase()) {
      case 'write':
        return 'create';
      case 'edit':
        return 'edit';
      case 'delete':
        return 'delete';
      case 'read':
      case 'grep':
      case 'glob':
        return 'read';
      default:
        return null;
    }
  }

  /**
   * Remove every transcript on disk for a thread (cascade on thread purge).
   *
   * Transcripts hold the raw session events, so a permanent delete that only clears
   * Redis would leave the conversation fully readable on disk. Returns whether a
   * directory was actually removed.
   */
  async deleteThread(threadId: string): Promise<boolean> {
    const threadDir = join(this.dataDir, 'threads', threadId);
    // Drop pending buffers too, otherwise a later flush would recreate the directory.
    const affected: string[] = [];
    for (const [sessionId, bufferedThreadId] of this.bufferedThreadIds) {
      if (bufferedThreadId !== threadId) continue;
      affected.push(sessionId);
      this.buffers.delete(sessionId);
      this.bufferedThreadIds.delete(sessionId);
    }
    // Wait for in-flight appends before removing the directory, and drop their bookkeeping —
    // an append that lands after the rm would resurrect the transcript we just purged.
    await Promise.all(affected.map((sessionId) => this.drain(sessionId)));
    for (const sessionId of affected) {
      this.persistStates.delete(sessionId);
      this.persistChains.delete(sessionId);
    }
    try {
      await rm(threadDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Compute session directory path. */
  private sessionDir(session: TranscriptSessionInfo): string {
    return join(this.dataDir, 'threads', session.threadId, session.catId, 'sessions', session.sessionId);
  }
}

function extractVisibleAssistantText(evt: Record<string, unknown>, opts?: { trim?: boolean }): string | null {
  if (evt.type === 'text' && typeof evt.content === 'string') {
    return normalizeVisibleText(evt.content, opts);
  }

  if (evt.type === 'assistant') {
    const content = evt.content;
    if (typeof content === 'string') {
      return normalizeVisibleText(content, opts);
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const maybeText = (part as { text?: unknown }).text;
          return typeof maybeText === 'string' ? maybeText : '';
        })
        .filter(Boolean)
        .join('\n');
      return normalizeVisibleText(text, opts);
    }
  }

  return null;
}

function normalizeVisibleText(text: string, opts?: { trim?: boolean }): string | null {
  const sanitized = stripLeakedToolCallPayload(text.replace(/[\x00-\x08\x0b-\x1f]/g, ''));
  if (sanitized.trim().length === 0) return null;
  return opts?.trim === false ? sanitized : sanitized.trim();
}

function coalesceVisibleText(existing: string, next: string, textMode: unknown): string {
  if (textMode === 'replace') {
    return next;
  }
  return `${existing}${next}`;
}

function moveToEnd<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index >= 0 && index !== items.length - 1) {
    items.splice(index, 1);
    items.push(item);
  }
}

function removeItem<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index >= 0) {
    items.splice(index, 1);
  }
}
