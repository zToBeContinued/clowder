'use client';

import { useEffect } from 'react';
import {
  clearStaleBrowserShell,
  isRecoverableChunkLoadError,
  markChunkReloadAttempt,
} from '@/utils/chunk-load-recovery';

export function ChunkLoadRefreshGuard() {
  useEffect(() => {
    const reloadOnce = (reason: unknown) => {
      if (!isRecoverableChunkLoadError(reason)) return;
      if (!markChunkReloadAttempt(window)) return;
      void clearStaleBrowserShell(window).finally(() => {
        window.setTimeout(() => window.location.reload(), 0);
      });
    };

    const onError = (event: Event) => {
      const errorEvent = event as ErrorEvent;
      // 资源标签（script/link）加载失败时 error/message 都为空，线索在
      // event.target 的 src/href 上——把整个 event 交给识别器读 target。
      reloadOnce(errorEvent.error ?? (errorEvent.message || event));
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      reloadOnce(event.reason);
    };

    // capture: true —— 资源加载失败（script/link 404）不冒泡，只能在捕获阶段收到。
    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return null;
}
