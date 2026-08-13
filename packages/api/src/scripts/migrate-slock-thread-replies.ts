/**
 * Restore Slock exported thread replies into Clowder archive threads.
 *
 * The original Slock import stores each channel as 50-message archive batches.
 * Slock thread replies were exported separately under `threads/<channel>/*.md`,
 * so this migration creates one hidden branch thread per archive batch, imports
 * the matching Slock thread replies there, then records the branch mapping on
 * the visible archive batch message via `extra.slockThread`.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConnectorSource } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { generateSortableId } from '../domains/cats/services/stores/ports/MessageStore.js';
import { MessageKeys } from '../domains/cats/services/stores/redis-keys/message-keys.js';
import { ThreadKeys } from '../domains/cats/services/stores/redis-keys/thread-keys.js';

const MESSAGE_START_RE = /^\[seq=\d+ msg=/;
const MESSAGE_HEADER_RE = /^\[seq=(\d+) msg=([0-9a-f-]+) time=([^\]]+?) type=(\w+)(?: [^\]]*)?\] @([^:]+): ?(.*)$/u;
const MENTION_RE = /(^|[^[])(@[\p{L}\p{N}_-]+)/gu;
const BATCH_SIZE = 50;

interface ImportResult {
  userId?: string;
  limit?: number;
  channels?: Array<{
    channelName: string;
    threadId: string;
    title: string;
    importedMessages?: number;
    messageIds?: string[];
  }>;
}

interface ParsedMessage {
  seq: number;
  msgId: string;
  shortId: string;
  timeRaw: string;
  timestamp: number;
  type: string;
  sender: string;
  content: string;
}

interface ThreadFile {
  channelName: string;
  parentShortId: string;
  path: string;
  replies: ParsedMessage[];
}

interface BatchGroup {
  channelName: string;
  archiveThreadId: string;
  batchIndex: number;
  batchMessageId: string;
  threadFiles: ThreadFile[];
  replies: Array<ParsedMessage & { parentShortId: string }>;
}

interface MigrationState {
  version: 1;
  updatedAt: string;
  messages: Record<
    string,
    {
      branchThreadId: string;
      replyCount: number;
      threadFiles: string[];
      updatedAt: string;
    }
  >;
}

interface Args {
  apply: boolean;
  exportDir: string;
  importResult: string;
  mappingFile: string;
  backupFile: string;
  errorsFile: string;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args.set(token, next);
      i++;
    } else {
      args.set(token, true);
    }
  }
  const exportDir = expandHome(String(args.get('--export-dir') ?? '~/Downloads/slock-export-20260518'));
  const limitRaw = args.get('--limit');
  const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : null;
  return {
    apply: args.has('--apply'),
    exportDir,
    importResult: resolve(String(args.get('--import-result') ?? join(exportDir, 'import-result.json'))),
    mappingFile: resolve(String(args.get('--mapping-file') ?? join(exportDir, 'thread-reply-migration-map.json'))),
    backupFile: resolve(String(args.get('--backup-file') ?? join(exportDir, 'thread-reply-migration-backup.json'))),
    errorsFile: resolve(String(args.get('--errors-file') ?? join(exportDir, 'thread-reply-migration-errors.json'))),
    limit: Number.isFinite(limit) && limit !== null && limit > 0 ? limit : null,
  };
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function parseTime(raw: string): number {
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Date.now();
}

function parseMessages(markdown: string): ParsedMessage[] {
  const blocks: Array<Omit<ParsedMessage, 'content'> & { contentLines: string[] }> = [];
  let current: (Omit<ParsedMessage, 'content'> & { contentLines: string[] }) | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (MESSAGE_START_RE.test(line)) {
      if (current) blocks.push(current);
      const match = line.match(MESSAGE_HEADER_RE);
      if (!match) {
        current = null;
        continue;
      }
      const [, seqRaw, msgId, timeRaw, type, sender, firstContent] = match;
      current = {
        seq: Number(seqRaw),
        msgId,
        shortId: msgId.slice(0, 8),
        timeRaw,
        timestamp: parseTime(timeRaw),
        type,
        sender: sender.trim(),
        contentLines: [firstContent ?? ''],
      };
      continue;
    }
    if (current) current.contentLines.push(line);
  }
  if (current) blocks.push(current);

  return blocks
    .filter((message) => message.type !== 'system')
    .map((message) => ({
      ...message,
      content: message.contentLines.join('\n').trimEnd(),
    }));
}

function escapeMentions(text: string): string {
  return text.replace(MENTION_RE, (_, prefix, mention) => `${prefix}[${mention}]`);
}

async function listThreadFiles(exportDir: string): Promise<ThreadFile[]> {
  const root = join(exportDir, 'threads');
  const channels = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: ThreadFile[] = [];
  for (const channel of channels) {
    if (!channel.isDirectory()) continue;
    const channelName = channel.name;
    const channelDir = join(root, channelName);
    const entries = await readdir(channelDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = join(channelDir, entry.name);
      const replies = parseMessages(await readFile(path, 'utf-8'));
      if (replies.length === 0) continue;
      files.push({
        channelName,
        parentShortId: basename(entry.name, '.md'),
        path,
        replies,
      });
    }
  }
  return files;
}

function branchThreadIdFor(batchMessageId: string): string {
  return `thread_slock_${createHash('sha1').update(batchMessageId).digest('hex').slice(0, 18)}`;
}

function safeParseObject(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sourceFor(channelName: string, message: ParsedMessage): ConnectorSource {
  return {
    connector: 'slock-import',
    label: `Slock #${channelName}`,
    icon: 'thread',
    meta: {
      kind: 'thread_reply',
      externalMessageId: message.msgId,
    },
  };
}

function formatReplyContent(channelName: string, parentShortId: string, reply: ParsedMessage): string {
  const body = escapeMentions(reply.content || '').trimEnd();
  return [`【slock thread #${channelName}:${parentShortId}】`, `[${reply.timeRaw}] @${reply.sender}: ${body}`]
    .join('\n')
    .trimEnd();
}

async function buildBatchGroups(
  args: Args,
  importResult: ImportResult,
): Promise<{
  groups: BatchGroup[];
  threadFiles: number;
  replyMessages: number;
  missingParents: Array<{ channelName: string; parentShortId: string; path: string }>;
}> {
  const channelByName = new Map((importResult.channels ?? []).map((channel) => [channel.channelName, channel]));
  const threadFiles = await listThreadFiles(args.exportDir);
  const parentMaps = new Map<string, Map<string, { batchIndex: number; batchMessageId: string }>>();
  const missingParents: Array<{ channelName: string; parentShortId: string; path: string }> = [];

  for (const channel of importResult.channels ?? []) {
    const filePath = join(args.exportDir, `${channel.channelName}.md`);
    const raw = await readFile(filePath, 'utf-8').catch(() => '');
    const importedLimit = channel.importedMessages ?? importResult.limit ?? 500;
    const parsed = parseMessages(raw).slice(0, importedLimit);
    const map = new Map<string, { batchIndex: number; batchMessageId: string }>();
    for (let i = 0; i < parsed.length; i++) {
      const batchIndex = Math.floor(i / BATCH_SIZE);
      const batchMessageId = channel.messageIds?.[batchIndex];
      if (!batchMessageId) continue;
      map.set(parsed[i]!.shortId, { batchIndex, batchMessageId });
    }
    parentMaps.set(channel.channelName, map);
  }

  const groupsByBatch = new Map<string, BatchGroup>();
  for (const file of threadFiles) {
    const channel = channelByName.get(file.channelName);
    const parent = parentMaps.get(file.channelName)?.get(file.parentShortId);
    if (!channel || !parent) {
      missingParents.push({ channelName: file.channelName, parentShortId: file.parentShortId, path: file.path });
      continue;
    }
    const key = parent.batchMessageId;
    const group =
      groupsByBatch.get(key) ??
      ({
        channelName: file.channelName,
        archiveThreadId: channel.threadId,
        batchIndex: parent.batchIndex,
        batchMessageId: parent.batchMessageId,
        threadFiles: [],
        replies: [],
      } satisfies BatchGroup);
    group.threadFiles.push(file);
    for (const reply of file.replies) {
      group.replies.push({ ...reply, parentShortId: file.parentShortId });
    }
    groupsByBatch.set(key, group);
  }

  const groups = [...groupsByBatch.values()].sort((a, b) => a.batchMessageId.localeCompare(b.batchMessageId));
  const limitedGroups = args.limit ? groups.slice(0, args.limit) : groups;
  return {
    groups: limitedGroups,
    threadFiles: threadFiles.length,
    replyMessages: threadFiles.reduce((total, file) => total + file.replies.length, 0),
    missingParents,
  };
}

async function createBranchThread(
  redis: ReturnType<typeof createRedisClient>,
  group: BatchGroup,
  batchMessage: Record<string, string>,
) {
  const branchThreadId = branchThreadIdFor(group.batchMessageId);
  const userId = batchMessage.userId || 'default-user';
  const sourceTimestamp = Number.parseInt(batchMessage.timestamp ?? `${Date.now()}`, 10);
  const lastReplyTimestamp = Math.max(...group.replies.map((reply) => reply.timestamp), sourceTimestamp);
  const exists = await redis.exists(ThreadKeys.detail(branchThreadId));
  if (!exists) {
    await redis
      .multi()
      .hset(ThreadKeys.detail(branchThreadId), {
        id: branchThreadId,
        projectPath: `slock-archive/${group.channelName}/threads`,
        title: `[slock-archive] #${group.channelName} thread replies batch ${group.batchIndex + 1} (分支)`,
        createdBy: userId,
        lastActiveAt: String(lastReplyTimestamp),
        createdAt: String(sourceTimestamp),
        pinned: 'false',
        pinnedAt: '0',
        favorited: 'false',
        favoritedAt: '0',
        isDM: 'false',
        thinkingMode: 'debug',
      })
      .zadd(ThreadKeys.userList(userId), String(lastReplyTimestamp), branchThreadId)
      .exec();

    const parentExtra = safeParseObject(batchMessage.extra);
    delete parentExtra.slockThread;
    await appendRawMessage(redis, {
      threadId: branchThreadId,
      userId,
      catId: batchMessage.catId ?? '',
      content: batchMessage.content ?? '',
      timestamp: sourceTimestamp,
      contentBlocks: batchMessage.contentBlocks ?? '',
      toolEvents: batchMessage.toolEvents ?? '',
      metadata: batchMessage.metadata ?? '',
      extra: JSON.stringify(parentExtra),
      mentions: batchMessage.mentions ?? '[]',
      source: batchMessage.source ?? '',
    });

    for (const reply of group.replies.sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq)) {
      await appendRawMessage(redis, {
        threadId: branchThreadId,
        userId,
        catId: '',
        content: formatReplyContent(group.channelName, reply.parentShortId, reply),
        timestamp: reply.timestamp,
        contentBlocks: '',
        toolEvents: '',
        metadata: '',
        extra: '',
        mentions: '[]',
        source: JSON.stringify(sourceFor(group.channelName, reply)),
      });
    }
  }
  return branchThreadId;
}

async function appendRawMessage(
  redis: ReturnType<typeof createRedisClient>,
  input: {
    threadId: string;
    userId: string;
    catId: string;
    content: string;
    timestamp: number;
    contentBlocks: string;
    toolEvents: string;
    metadata: string;
    extra: string;
    mentions: string;
    source: string;
  },
): Promise<string> {
  const id = generateSortableId(input.timestamp);
  await redis
    .multi()
    .hset(MessageKeys.detail(id), {
      id,
      threadId: input.threadId,
      userId: input.userId,
      catId: input.catId,
      content: input.content,
      contentBlocks: input.contentBlocks,
      toolEvents: input.toolEvents,
      metadata: input.metadata,
      extra: input.extra,
      mentions: input.mentions,
      timestamp: String(input.timestamp),
      source: input.source,
    })
    .zadd(MessageKeys.TIMELINE, String(input.timestamp), id)
    .zadd(MessageKeys.user(input.userId), String(input.timestamp), id)
    .zadd(MessageKeys.thread(input.threadId), String(input.timestamp), id)
    .exec();
  return id;
}

export async function runMigrateSlockThreadRepliesCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const importResult = await readJson<ImportResult>(args.importResult, {});
  const state = await readJson<MigrationState>(args.mappingFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    messages: {},
  });
  const backup = await readJson<Record<string, { extra: string; editedAt?: string }>>(args.backupFile, {});
  const errors = await readJson<Array<{ at: string; batchMessageId?: string; error: string }>>(args.errorsFile, []);
  const scan = await buildBatchGroups(args, importResult);

  let patchedMessages = 0;
  let createdBranchThreads = 0;
  let skippedExisting = 0;
  const redis = createRedisClient();

  try {
    for (const group of scan.groups) {
      const batchMessage = await redis.hgetall(MessageKeys.detail(group.batchMessageId));
      if (!batchMessage?.id) {
        errors.push({
          at: new Date().toISOString(),
          batchMessageId: group.batchMessageId,
          error: 'archive batch message not found',
        });
        continue;
      }

      const branchThreadId =
        state.messages[group.batchMessageId]?.branchThreadId ?? branchThreadIdFor(group.batchMessageId);
      const branchExists = await redis.exists(ThreadKeys.detail(branchThreadId));
      if (!args.apply) continue;

      try {
        const actualBranchThreadId = await createBranchThread(redis, group, batchMessage);
        if (branchExists) skippedExisting++;
        else createdBranchThreads++;

        const extra = safeParseObject(batchMessage.extra);
        if (!backup[group.batchMessageId]) {
          backup[group.batchMessageId] = {
            extra: batchMessage.extra ?? '',
            ...(batchMessage.editedAt ? { editedAt: batchMessage.editedAt } : {}),
          };
        }
        extra.slockThread = {
          branchThreadId: actualBranchThreadId,
          replyCount: group.replies.length,
        };
        await redis.hset(MessageKeys.detail(group.batchMessageId), {
          extra: JSON.stringify(extra),
          editedAt: String(Date.now()),
        });
        state.messages[group.batchMessageId] = {
          branchThreadId: actualBranchThreadId,
          replyCount: group.replies.length,
          threadFiles: group.threadFiles.map((file) => file.path),
          updatedAt: new Date().toISOString(),
        };
        patchedMessages++;
      } catch (err) {
        errors.push({
          at: new Date().toISOString(),
          batchMessageId: group.batchMessageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    state.updatedAt = new Date().toISOString();
    await writeFile(args.mappingFile, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    await writeFile(args.errorsFile, `${JSON.stringify(errors, null, 2)}\n`, 'utf-8');
    if (args.apply) {
      await writeFile(args.backupFile, `${JSON.stringify(backup, null, 2)}\n`, 'utf-8');
    }
    await redis.quit();
  }

  const totalGroupedReplies = scan.groups.reduce((total, group) => total + group.replies.length, 0);
  console.log(
    JSON.stringify(
      {
        mode: args.apply ? 'apply' : 'dry-run',
        scannedThreadFiles: scan.threadFiles,
        scannedReplyMessages: scan.replyMessages,
        mappedBatchMessages: scan.groups.length,
        mappedReplyMessages: totalGroupedReplies,
        missingParents: scan.missingParents.length,
        createdBranchThreads,
        skippedExisting,
        patchedMessages,
        errors: errors.length,
        mappingFile: args.mappingFile,
        backupFile: args.backupFile,
        errorsFile: args.errorsFile,
      },
      null,
      2,
    ),
  );
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  runMigrateSlockThreadRepliesCli().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
