const CHUNK_RELOAD_SESSION_KEY = 'clowder:chunk-load-reload-at';
// 冷却窗口只是防重载循环；服务重启后旧壳的多次导航失败应该都能自愈，
// 2 分钟太长（第一次重载若被 SW 缓存拖住，用户会在窗口内一直看空白页）。
const CHUNK_RELOAD_COOLDOWN_MS = 30 * 1000;

const CHUNK_ERROR_RE =
  /ChunkLoadError|Loading chunk \d+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

// 资源标签（script/link）加载失败时 ErrorEvent 没有 error/message，唯一线索是
// target 的 src/href——指向 Next 静态资源即视为「旧壳加载新构建失败」。
const NEXT_STATIC_ASSET_RE = /\/_next\/static\//;

function collectErrorText(reason: unknown): string {
  if (!reason) return '';
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return `${reason.name}\n${reason.message}\n${reason.stack ?? ''}`;
  if (typeof reason === 'object') {
    const candidate = reason as { name?: unknown; message?: unknown; stack?: unknown; type?: unknown; target?: unknown };
    const target = candidate.target as { src?: unknown; href?: unknown } | undefined;
    return [candidate.name, candidate.message, candidate.stack, candidate.type, target?.src, target?.href]
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
  }
  return '';
}

export function isRecoverableChunkLoadError(reason: unknown): boolean {
  const text = collectErrorText(reason);
  return CHUNK_ERROR_RE.test(text) || NEXT_STATIC_ASSET_RE.test(text);
}

export function shouldAttemptChunkReload(storage: Pick<Storage, 'getItem' | 'setItem'>, now = Date.now()): boolean {
  const previous = Number(storage.getItem(CHUNK_RELOAD_SESSION_KEY) ?? 0);
  if (Number.isFinite(previous) && previous > 0 && now - previous < CHUNK_RELOAD_COOLDOWN_MS) {
    return false;
  }
  storage.setItem(CHUNK_RELOAD_SESSION_KEY, String(now));
  return true;
}

export function markChunkReloadAttempt(windowRef: Window): boolean {
  try {
    return shouldAttemptChunkReload(windowRef.sessionStorage);
  } catch {
    return true;
  }
}

export async function clearStaleBrowserShell(windowRef: Window): Promise<void> {
  await Promise.allSettled([
    windowRef.navigator.serviceWorker?.getRegistrations().then((registrations) =>
      Promise.allSettled(registrations.map((registration) => registration.unregister())),
    ),
    'caches' in windowRef
      ? windowRef.caches.keys().then((keys) => Promise.allSettled(keys.map((key) => windowRef.caches.delete(key))))
      : Promise.resolve(),
  ]);
}
