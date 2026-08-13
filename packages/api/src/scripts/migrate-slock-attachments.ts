/**
 * Migrate Slock exported attachment IDs into Clowder archive messages.
 *
 * Default mode is dry-run: scan imported slock-archive batch messages and report
 * what would be migrated. Use --apply to download files, store them under
 * Clowder uploads/, and patch only the imported archive message hashes.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { MessageContent } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { MessageKeys } from '../domains/cats/services/stores/redis-keys/message-keys.js';
import { saveUploadedFiles } from '../routes/file-upload.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';

const execFileAsync = promisify(execFile);

interface ImportResult {
  channels?: Array<{
    channelName: string;
    threadId: string;
    title: string;
    messageIds?: string[];
  }>;
}

interface AttachmentHit {
  slockId: string;
  filename: string;
}

interface AttachmentMapping {
  slockId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  clowderUrl: string;
  migratedAt: string;
}

interface MigrationState {
  version: 1;
  updatedAt: string;
  attachments: Record<string, AttachmentMapping>;
  messages: Record<string, { updatedAt: string; attachmentIds: string[] }>;
}

interface MigrationError {
  at: string;
  slockId?: string;
  messageId?: string;
  error: string;
}

interface Args {
  apply: boolean;
  exportDir: string;
  importResult: string;
  mappingFile: string;
  errorsFile: string;
  backupFile: string;
  downloadDir: string;
  uploadDir: string;
  downloadTimeoutMs: number;
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
  const timeoutRaw = args.get('--download-timeout-ms');
  const downloadTimeoutMs = typeof timeoutRaw === 'string' ? Number.parseInt(timeoutRaw, 10) : 20_000;
  return {
    apply: args.has('--apply'),
    exportDir,
    importResult: resolve(String(args.get('--import-result') ?? join(exportDir, 'import-result.json'))),
    mappingFile: resolve(String(args.get('--mapping-file') ?? join(exportDir, 'attachment-migration-map.json'))),
    errorsFile: resolve(String(args.get('--errors-file') ?? join(exportDir, 'migration-errors.json'))),
    backupFile: resolve(String(args.get('--backup-file') ?? join(exportDir, 'attachment-migration-backup.json'))),
    downloadDir: resolve(String(args.get('--download-dir') ?? join(exportDir, 'attachments'))),
    uploadDir: getDefaultUploadDir(String(args.get('--upload-dir') ?? process.env.UPLOAD_DIR ?? '')),
    downloadTimeoutMs: Number.isFinite(downloadTimeoutMs) && downloadTimeoutMs > 0 ? downloadTimeoutMs : 20_000,
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

function extractAttachments(content: string): AttachmentHit[] {
  const hits: AttachmentHit[] = [];
  const seen = new Set<string>();
  const attachmentBlockRe = /\[\d+\s+attachments?:\s*([^\]]+?)\]/gi;
  const itemRe = /([^,\n]+?)\s+\(id:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;
  for (const block of content.matchAll(attachmentBlockRe)) {
    const body = block[1] ?? '';
    for (const item of body.matchAll(itemRe)) {
      const slockId = item[2];
      if (!slockId || seen.has(slockId)) continue;
      seen.add(slockId);
      hits.push({
        slockId,
        filename: sanitizeDisplayFilename(item[1] ?? 'attachment'),
      });
    }
  }
  return hits;
}

function sanitizeDisplayFilename(input: string): string {
  return (
    input
      .replace(/^,/, '')
      .replace(/\s+—.*$/, '')
      .trim() || 'attachment'
  );
}

function inferMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const byExt: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
  };
  return byExt[ext] ?? 'application/octet-stream';
}

function safeDownloadName(hit: AttachmentHit): string {
  const ext = extname(hit.filename);
  const stem =
    basename(hit.filename, ext)
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .slice(0, 80) || 'attachment';
  return `${hit.slockId}-${stem}${ext}`;
}

async function downloadSlockAttachment(hit: AttachmentHit, outputPath: string, timeoutMs: number): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await execFileAsync('slock', ['attachment', 'view', '--id', hit.slockId, '--output', outputPath], {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
}

function replaceAttachmentReferences(content: string, mappings: AttachmentMapping[]): string {
  let next = content;
  for (const mapping of mappings) {
    next = next.replaceAll(`(id:${mapping.slockId})`, `(id:${mapping.slockId}; clowder:${mapping.clowderUrl})`);
  }
  return next;
}

function toContentBlocks(content: string, mappings: AttachmentMapping[]): MessageContent[] {
  const blocks: MessageContent[] = [{ type: 'text', text: content }];
  for (const mapping of mappings) {
    if (mapping.mimeType.startsWith('image/')) {
      blocks.push({ type: 'image', url: mapping.clowderUrl });
    } else {
      blocks.push({
        type: 'file',
        filename: mapping.filename,
        url: mapping.clowderUrl,
        mimeType: mapping.mimeType,
        size: mapping.size,
      });
    }
  }
  return blocks;
}

async function migrateAttachment(
  hit: AttachmentHit,
  args: Args,
  state: MigrationState,
): Promise<AttachmentMapping | null> {
  const existing = state.attachments[hit.slockId];
  if (existing) return existing;
  if (!args.apply) return null;

  const downloadPath = join(args.downloadDir, safeDownloadName(hit));
  console.error(`[migrate-slock-attachments] downloading ${hit.slockId} (${hit.filename})`);
  await downloadSlockAttachment(hit, downloadPath, args.downloadTimeoutMs);
  const buffer = await readFile(downloadPath);
  const mimeType = inferMimeType(hit.filename);
  const saved = await saveUploadedFiles(
    [
      {
        filename: hit.filename,
        mimetype: mimeType,
        toBuffer: async () => buffer,
      },
    ],
    args.uploadDir,
  );
  const first = saved[0];
  if (!first) throw new Error(`upload failed for ${hit.slockId}`);

  const mapping: AttachmentMapping = {
    slockId: hit.slockId,
    filename: hit.filename,
    mimeType,
    size: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    clowderUrl: first.content.url,
    migratedAt: new Date().toISOString(),
  };
  state.attachments[hit.slockId] = mapping;
  return mapping;
}

export async function runMigrateSlockAttachmentsCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const importResult = await readJson<ImportResult>(args.importResult, {});
  const state = await readJson<MigrationState>(args.mappingFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    attachments: {},
    messages: {},
  });
  const backup = await readJson<Record<string, Record<string, string>>>(args.backupFile, {});
  const errors = await readJson<MigrationError[]>(args.errorsFile, []);
  const messageIds = (importResult.channels ?? []).flatMap((channel) => channel.messageIds ?? []);
  const scopedIds = args.limit ? messageIds.slice(0, args.limit) : messageIds;

  const redis = createRedisClient();
  let scannedMessages = 0;
  let messagesWithAttachments = 0;
  let attachmentRefs = 0;
  let migratedAttachments = 0;
  let patchedMessages = 0;

  try {
    for (const messageId of scopedIds) {
      scannedMessages++;
      const message = await redis.hgetall(MessageKeys.detail(messageId));
      const content = message.content ?? '';
      const hits = extractAttachments(content);
      if (hits.length === 0) continue;
      messagesWithAttachments++;
      attachmentRefs += hits.length;

      const mappings: AttachmentMapping[] = [];
      for (const hit of hits) {
        try {
          const before = state.attachments[hit.slockId];
          const mapping = await migrateAttachment(hit, args, state);
          if (mapping) mappings.push(mapping);
          if (!before && mapping) migratedAttachments++;
        } catch (err) {
          console.error(
            `[migrate-slock-attachments] failed ${hit.slockId}: ${err instanceof Error ? err.message : String(err)}`,
          );
          errors.push({
            at: new Date().toISOString(),
            slockId: hit.slockId,
            messageId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (args.apply && mappings.length > 0) {
        const nextContent = replaceAttachmentReferences(content, mappings);
        const contentBlocks = toContentBlocks(nextContent, mappings);
        if (!backup[messageId]) {
          backup[messageId] = {
            content: message.content ?? '',
            contentBlocks: message.contentBlocks ?? '',
            editedAt: message.editedAt ?? '',
          };
        }
        await redis.hset(MessageKeys.detail(messageId), {
          content: nextContent,
          contentBlocks: JSON.stringify(contentBlocks),
          editedAt: String(Date.now()),
        });
        state.messages[messageId] = {
          updatedAt: new Date().toISOString(),
          attachmentIds: hits.map((hit) => hit.slockId),
        };
        patchedMessages++;
      }
    }
  } finally {
    state.updatedAt = new Date().toISOString();
    await mkdir(dirname(args.mappingFile), { recursive: true });
    await writeFile(args.mappingFile, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    await writeFile(args.errorsFile, `${JSON.stringify(errors, null, 2)}\n`, 'utf-8');
    if (args.apply) {
      await writeFile(args.backupFile, `${JSON.stringify(backup, null, 2)}\n`, 'utf-8');
    }
    await redis.quit();
  }

  console.log(
    JSON.stringify(
      {
        mode: args.apply ? 'apply' : 'dry-run',
        scannedMessages,
        messagesWithAttachments,
        attachmentRefs,
        knownMigratedAttachments: Object.keys(state.attachments).length,
        migratedAttachments,
        patchedMessages,
        errors: errors.length,
        mappingFile: args.mappingFile,
        errorsFile: args.errorsFile,
        backupFile: args.backupFile,
        downloadDir: args.downloadDir,
        uploadDir: args.uploadDir,
        downloadTimeoutMs: args.downloadTimeoutMs,
      },
      null,
      2,
    ),
  );
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  runMigrateSlockAttachmentsCli().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
