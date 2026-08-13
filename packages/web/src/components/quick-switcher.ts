import { type CatData, formatCatName } from '@/hooks/useCatData';
import type { Thread } from '@/stores/chat-types';
import { buildGlobalSearchHref } from './global-search-navigation';
import { getThreadHref } from './ThreadSidebar/thread-navigation';

export type QuickSwitchItemType = 'thread' | 'dm' | 'search';

export interface QuickSwitchItem {
  id: string;
  type: QuickSwitchItemType;
  label: string;
  detail: string;
  href: string;
  threadId?: string;
  lastActiveAt: number;
}

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function getThreadDisplayTitle(thread: Pick<Thread, 'id' | 'title' | 'isDM'>): string {
  if (thread.title) return thread.title;
  if (thread.id === 'default') return '大厅';
  return thread.isDM ? '私信' : '未命名对话';
}

function getDirectThreadCatId(thread: Pick<Thread, 'isDM' | 'preferredCats' | 'participatingCats'>): string | null {
  const directCats = thread.participatingCats?.length ? thread.participatingCats : thread.preferredCats;
  const catId = directCats?.[0];
  if (!catId || directCats.length !== 1) return null;
  return thread.isDM || thread.preferredCats?.length === 1 ? catId : null;
}

function scoreHaystack(query: string, values: string[]): number {
  if (!query) return 1;
  let best = 0;
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized) continue;
    if (normalized === query) best = Math.max(best, 100);
    else if (normalized.startsWith(query)) best = Math.max(best, 80);
    else if (normalized.includes(query)) best = Math.max(best, 50);
  }
  return best;
}

export function buildQuickSwitchItems({
  threads,
  cats,
  query,
  pathname,
  currentSearch,
  limit = 12,
}: {
  threads: Thread[];
  cats: CatData[];
  query: string;
  pathname: string;
  currentSearch: string;
  limit?: number;
}): QuickSwitchItem[] {
  const catById = new Map(cats.map((cat) => [cat.id, cat]));
  const trimmed = query.trim();
  const needle = normalize(trimmed);
  const seen = new Set<string>();
  const candidates: Array<QuickSwitchItem & { score: number }> = [];
  const inputThreads = threads.some((thread) => thread.id === 'default')
    ? threads
    : [
        {
          id: 'default',
          projectPath: 'default',
          title: '大厅',
          createdBy: 'system',
          participants: [],
          lastActiveAt: 0,
          createdAt: 0,
        } satisfies Thread,
        ...threads,
      ];

  for (const thread of inputThreads) {
    if (thread.deletedAt || seen.has(thread.id)) continue;
    seen.add(thread.id);
    const directCatId = getDirectThreadCatId(thread);
    const cat = directCatId ? catById.get(directCatId) : undefined;
    const label = cat ? formatCatName(cat) : getThreadDisplayTitle(thread);
    const type: QuickSwitchItemType = directCatId ? 'dm' : 'thread';
    const detail =
      type === 'dm'
        ? `私信 · ${thread.projectPath ?? thread.id}`
        : `${thread.id === 'default' ? '频道' : '对话'} · ${thread.projectPath ?? thread.id}`;
    const score = scoreHaystack(needle, [
      label,
      thread.title ?? '',
      thread.id,
      thread.projectPath ?? '',
      directCatId ?? '',
    ]);
    if (needle && score === 0) continue;
    candidates.push({
      id: `${type}:${thread.id}`,
      type,
      label,
      detail,
      href: getThreadHref(thread.id),
      threadId: thread.id,
      lastActiveAt: thread.lastActiveAt ?? 0,
      score,
    });
  }

  candidates.sort(
    (a, b) => b.score - a.score || b.lastActiveAt - a.lastActiveAt || a.label.localeCompare(b.label, 'zh-Hans-CN'),
  );

  const items: QuickSwitchItem[] = candidates
    .slice(0, limit)
    .map(({ id, type, label, detail, href, threadId, lastActiveAt }) => ({
      id,
      type,
      label,
      detail,
      href,
      ...(threadId ? { threadId } : {}),
      lastActiveAt,
    }));
  if (trimmed) {
    items.push({
      id: 'search:global',
      type: 'search',
      label: `搜索全部内容：“${trimmed}”`,
      detail: '消息、频道与历史',
      href: buildGlobalSearchHref(pathname, currentSearch, trimmed),
      lastActiveAt: Number.MAX_SAFE_INTEGER,
    });
  }
  return items;
}
