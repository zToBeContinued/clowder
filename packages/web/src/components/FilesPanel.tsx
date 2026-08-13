'use client';

import { useMemo, useState } from 'react';
import { type CatData, formatCatName } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageData, MessageContent, RichBlock } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { Lightbox } from './Lightbox';

type FilePanelItem = {
  id: string;
  kind: 'image' | 'file';
  url: string;
  filename: string;
  mimeType?: string;
  size?: number;
  timestamp: number;
  author: string;
  messageId: string;
  caption?: string;
};

function resolveUrl(url: string): string {
  const trimmed = url.trim();
  if (
    trimmed.startsWith('/uploads/') ||
    trimmed.startsWith('/api/connector-media/') ||
    trimmed.startsWith('/avatars/')
  ) {
    return `${API_URL}${trimmed}`;
  }
  return trimmed;
}

function filenameFromUrl(url: string, fallback: string): string {
  const path = url.split('?')[0]?.split('#')[0] ?? '';
  const last = path.split('/').filter(Boolean).pop();
  return decodeURIComponent(last || fallback);
}

function formatFileSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatFileTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getAuthor(message: ChatMessageData, getCatById: (id: string) => CatData | undefined): string {
  if (message.type === 'assistant' && message.catId) {
    const cat = getCatById(message.catId);
    return cat ? formatCatName(cat) : message.catId;
  }
  if (message.type === 'connector') return message.source?.sender?.name ?? message.source?.label ?? 'Connector';
  if (message.type === 'user') return '你';
  return '系统';
}

function collectContentBlockFiles(
  message: ChatMessageData,
  getCatById: (id: string) => CatData | undefined,
): FilePanelItem[] {
  const blocks = message.contentBlocks ?? [];
  const author = getAuthor(message, getCatById);
  return blocks.flatMap((block: MessageContent, index): FilePanelItem[] => {
    if (block.type === 'image') {
      return [
        {
          id: `${message.id}:content:${index}`,
          kind: 'image',
          url: resolveUrl(block.url),
          filename: filenameFromUrl(block.url, `image-${index + 1}`),
          timestamp: message.timestamp,
          author,
          messageId: message.id,
        },
      ];
    }
    if (block.type === 'file') {
      return [
        {
          id: `${message.id}:content:${index}`,
          kind: 'file',
          url: resolveUrl(block.url),
          filename: block.filename || filenameFromUrl(block.url, `file-${index + 1}`),
          mimeType: block.mimeType,
          size: block.size,
          timestamp: message.timestamp,
          author,
          messageId: message.id,
        },
      ];
    }
    return [];
  });
}

function collectRichBlockFiles(
  message: ChatMessageData,
  getCatById: (id: string) => CatData | undefined,
): FilePanelItem[] {
  const blocks = message.extra?.rich?.blocks ?? [];
  const author = getAuthor(message, getCatById);
  return blocks.flatMap((block: RichBlock, blockIndex): FilePanelItem[] => {
    if (block.kind === 'file') {
      return [
        {
          id: `${message.id}:rich:${block.id || blockIndex}`,
          kind: block.mimeType?.startsWith('image/') ? 'image' : 'file',
          url: resolveUrl(block.url),
          filename: block.fileName || filenameFromUrl(block.url, `file-${blockIndex + 1}`),
          mimeType: block.mimeType,
          size: block.fileSize,
          timestamp: message.timestamp,
          author,
          messageId: message.id,
        },
      ];
    }
    if (block.kind === 'media_gallery') {
      return block.items.map((item, itemIndex) => ({
        id: `${message.id}:rich:${block.id || blockIndex}:${itemIndex}`,
        kind: 'image',
        url: resolveUrl(item.url),
        filename: filenameFromUrl(item.url, item.alt || `image-${itemIndex + 1}`),
        timestamp: message.timestamp,
        author,
        messageId: message.id,
        caption: item.caption ?? item.alt,
      }));
    }
    return [];
  });
}

export function collectThreadFiles(
  messages: ChatMessageData[],
  getCatById: (id: string) => CatData | undefined,
): FilePanelItem[] {
  return messages
    .flatMap((message) => [
      ...collectContentBlockFiles(message, getCatById),
      ...collectRichBlockFiles(message, getCatById),
    ])
    .sort((a, b) => b.timestamp - a.timestamp);
}

function FileCard({ item }: { item: FilePanelItem }) {
  const size = formatFileSize(item.size);
  return (
    <a
      href={item.url}
      download={item.filename}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-xl border border-[var(--slock-border-color)] bg-[var(--console-panel-bg)] px-4 py-3 text-sm transition-colors hover:border-[var(--cafe-accent)]/50 hover:bg-[var(--console-hover-bg)]"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--slock-border-color)] bg-[var(--console-card-soft-bg)] text-[10px] font-semibold tracking-[0.08em] text-[var(--cafe-text-muted)]">
        FILE
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-[var(--cafe-text)]">{item.filename}</span>
        <span className="mt-0.5 block text-xs text-[var(--cafe-text-muted)]">
          {item.mimeType ?? 'file'}
          {size ? ` · ${size}` : ''}
          {' · '}
          {item.author} · {formatFileTime(item.timestamp)}
        </span>
      </span>
      <span className="shrink-0 text-xs font-semibold text-[var(--cafe-accent)]">下载</span>
    </a>
  );
}

export function FilesPanel({
  messages,
  getCatById,
}: {
  messages: ChatMessageData[];
  getCatById: (id: string) => CatData | undefined;
}) {
  const files = useMemo(() => collectThreadFiles(messages, getCatById), [messages, getCatById]);
  const images = files.filter((item) => item.kind === 'image');
  const documents = files.filter((item) => item.kind === 'file');
  const [lightboxItem, setLightboxItem] = useState<FilePanelItem | null>(null);

  return (
    <section className="h-full overflow-y-auto bg-[var(--console-shell-bg)] p-5">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--cafe-text)]">Files</h2>
            <p className="mt-1 text-xs text-[var(--cafe-text-muted)]">
              当前频道消息里的图片与文件附件，共 {files.length} 个。
            </p>
          </div>
          <div className="flex gap-2 text-[11px] text-[var(--cafe-text-muted)]">
            <span className="rounded-full border border-[var(--slock-border-color)] px-2 py-1">
              图片 {images.length}
            </span>
            <span className="rounded-full border border-[var(--slock-border-color)] px-2 py-1">
              文件 {documents.length}
            </span>
          </div>
        </div>

        {files.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--slock-border-color)] bg-[var(--console-panel-bg)] p-8 text-center">
            <div className="text-sm font-medium text-[var(--cafe-text)]">当前频道暂无文件</div>
            <div className="mt-1 text-xs text-[var(--cafe-text-muted)]">
              上传图片或文件后，这里会自动汇总，方便后续回看。
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {images.length > 0 && (
              <section>
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--clowder-muted-soft)]">
                  Images
                </div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
                  {images.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setLightboxItem(item)}
                      className="group overflow-hidden rounded-xl border border-[var(--slock-border-color)] bg-[var(--console-panel-bg)] text-left transition-colors hover:border-[var(--cafe-accent)]/50"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.url} alt={item.caption ?? item.filename} className="h-36 w-full object-cover" />
                      <span className="block min-w-0 px-3 py-2">
                        <span className="block truncate text-xs font-medium text-[var(--cafe-text)]">
                          {item.filename}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-[var(--cafe-text-muted)]">
                          {item.author} · {formatFileTime(item.timestamp)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {documents.length > 0 && (
              <section>
                <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--clowder-muted-soft)]">
                  Documents
                </div>
                <div className="space-y-2">
                  {documents.map((item) => (
                    <FileCard key={item.id} item={item} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
      {lightboxItem && (
        <Lightbox
          url={lightboxItem.url}
          alt={lightboxItem.caption ?? lightboxItem.filename}
          caption={`${lightboxItem.filename} · ${lightboxItem.author}`}
          onClose={() => setLightboxItem(null)}
        />
      )}
    </section>
  );
}
