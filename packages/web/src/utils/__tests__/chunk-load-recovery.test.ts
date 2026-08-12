import { describe, expect, it, vi } from 'vitest';
import { clearStaleBrowserShell, isRecoverableChunkLoadError, shouldAttemptChunkReload } from '../chunk-load-recovery';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('chunk-load-recovery', () => {
  it('recognizes stale Next/Vite chunk loading failures', () => {
    expect(isRecoverableChunkLoadError(new Error('Loading chunk 1234 failed.'))).toBe(true);
    expect(isRecoverableChunkLoadError('Failed to fetch dynamically imported module: /_next/static/chunks/app.js')).toBe(
      true,
    );
    expect(isRecoverableChunkLoadError(new TypeError('ordinary request failed'))).toBe(false);
  });

  it('recognizes resource-tag load failures via event.target src/href (script/link 404)', () => {
    // 资源加载失败的 ErrorEvent：error/message 均为空，线索只在 target 上
    const scriptFailure = { type: 'error', target: { src: 'http://localhost:3003/_next/static/chunks/settings-abc123.js' } };
    const cssFailure = { type: 'error', target: { href: 'http://localhost:3003/_next/static/css/55a94185.css' } };
    expect(isRecoverableChunkLoadError(scriptFailure)).toBe(true);
    expect(isRecoverableChunkLoadError(cssFailure)).toBe(true);
    // 非 Next 静态资源（比如头像图片 404）不触发重载
    expect(isRecoverableChunkLoadError({ type: 'error', target: { src: 'http://localhost:3003/avatars/cat.png' } })).toBe(
      false,
    );
  });

  it('only allows one automatic reload during the cooldown window', () => {
    const storage = memoryStorage();

    expect(shouldAttemptChunkReload(storage, 1000)).toBe(true);
    expect(shouldAttemptChunkReload(storage, 2000)).toBe(false);
    expect(shouldAttemptChunkReload(storage, 40_000)).toBe(true);
  });

  it('clears service workers and caches before reload', async () => {
    const unregister = vi.fn(() => Promise.resolve(true));
    const cacheDelete = vi.fn(() => Promise.resolve(true));
    const windowRef = {
      navigator: {
        serviceWorker: {
          getRegistrations: () => Promise.resolve([{ unregister }]),
        },
      },
      caches: {
        keys: () => Promise.resolve(['old-shell']),
        delete: cacheDelete,
      },
    } as unknown as Window;

    await clearStaleBrowserShell(windowRef);

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith('old-shell');
  });
});
