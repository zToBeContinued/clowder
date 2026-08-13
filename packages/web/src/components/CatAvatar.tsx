'use client';

import { type ReactNode, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { hexToRgba } from '@/lib/color-utils';
import { PawIcon } from './icons/PawIcon';

type CatStatus = 'spawning' | 'pending' | 'streaming' | 'done' | 'error' | 'alive_but_silent' | 'suspected_stall';
type CatActivityStatus = 'active' | 'idle';

/** F174 D2b-2 — callback-auth health (per cat, derived from /api/debug/callback-auth snapshot). */
export type CallbackAuthStatus = 'healthy' | 'degraded' | 'broken' | 'unknown';

const CALLBACK_AUTH_STATUS_COLOR: Record<CallbackAuthStatus, string> = {
  healthy: 'var(--conn-emerald-text)',
  degraded: 'var(--conn-amber-text)',
  broken: 'var(--conn-red-text)',
  unknown: 'var(--cafe-text-muted)',
};

interface CatAvatarProps {
  catId: string;
  size?: number;
  status?: CatStatus;
  tone?: 'default' | 'quiet';
  /** F174 D2b-2: corner status dot for callback-auth health surface (明厨亮灶 实体层). */
  callbackAuthStatus?: CallbackAuthStatus;
  /** Runtime activity dot: Slock-like lightweight indicator for active cats. */
  activityStatus?: CatActivityStatus;
  /** Optional aria-label / hover hint for the status dot (e.g. "broken · 12 fails"). */
  callbackAuthLabel?: string;
  /**
   * F174 D2b-2 AC-D7: rich popover rendered on dot hover. When provided
   * (and onCallbackAuthClick set), the dot becomes a clickable entry
   * point — e.g. jump to D2b-3 deep-dive panel.
   */
  callbackAuthPopover?: ReactNode;
  /** F174 D2b-2 AC-D7: click handler for the dot (typically opens D2b-3). */
  onCallbackAuthClick?: () => void;
}

export function CatAvatar({
  catId,
  size = 32,
  status,
  callbackAuthStatus,
  activityStatus,
  callbackAuthLabel,
  callbackAuthPopover,
  onCallbackAuthClick,
}: CatAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const { getCatById } = useCatData();
  const cat = getCatById(catId);

  const isStreaming = status === 'streaming';
  const ringColor = cat?.color.primary ?? 'var(--console-cat-fallback)';
  const glowShadow = isStreaming && cat ? `0 0 10px ${hexToRgba(ringColor, 0.5)}` : undefined;

  // F174 D2b-2: dot is ~28% of avatar size (min 8px), absolute positioned bottom-right.
  // White ring lifts it off the avatar and survives most cat colors.
  const dotSize = Math.max(8, Math.round(size * 0.28));
  const dotBorder = 1;

  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <div
        data-testid="cat-avatar-frame"
        className={`overflow-hidden bg-cafe-surface-elevated flex items-center justify-center transition-shadow duration-300 ${
          isStreaming ? 'animate-pulse' : ''
        }`}
        style={{
          width: size,
          height: size,
          border: '1px solid var(--slock-ink, var(--console-border-strong, var(--cafe-border)))',
          borderRadius: 0,
          boxShadow: glowShadow,
        }}
      >
        {imgError ? (
          <PawIcon className="h-1/2 w-1/2" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cat?.avatar ?? `/avatars/${catId}.png`}
            alt={cat?.displayName ?? catId}
            width={size}
            height={size}
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        )}
      </div>
      {activityStatus && (
        <span
          role="status"
          data-testid="cat-activity-dot"
          data-cat-activity-status={activityStatus}
          aria-label={activityStatus === 'active' ? '正在运行' : '空闲'}
          title={activityStatus === 'active' ? '正在运行' : '空闲'}
          className={`absolute block rounded-full ${activityStatus === 'active' ? 'animate-pulse' : ''}`}
          style={{
            left: callbackAuthStatus ? -dotBorder : undefined,
            right: callbackAuthStatus ? undefined : -dotBorder,
            bottom: -dotBorder,
            width: dotSize,
            height: dotSize,
            backgroundColor: activityStatus === 'active' ? 'var(--conn-amber-text)' : 'var(--conn-emerald-text)',
            border: `${dotBorder}px solid var(--slock-white, var(--cafe-surface))`,
          }}
        />
      )}
      {callbackAuthStatus && (
        <span
          className="absolute"
          style={{ right: -dotBorder, bottom: -dotBorder }}
          onMouseEnter={() => callbackAuthPopover && setPopoverOpen(true)}
          onMouseLeave={() => setPopoverOpen(false)}
        >
          {onCallbackAuthClick ? (
            <button
              type="button"
              data-testid="callback-auth-dot"
              data-callback-auth-status={callbackAuthStatus}
              aria-label={callbackAuthLabel ?? `callback-auth: ${callbackAuthStatus}`}
              title={callbackAuthLabel ?? `callback-auth: ${callbackAuthStatus}`}
              onClick={(e) => {
                // 砚砚 P2 #1403: dot lives inside CatAvatar callsites that are
                // themselves clickable (e.g. ThreadItem row → onSelect). Without
                // stopPropagation, opening the D2b-3 panel would also switch
                // threads — a hidden context jump.
                e.stopPropagation();
                onCallbackAuthClick();
              }}
              className="block rounded-full p-0 hover:scale-110 transition-transform cursor-pointer"
              style={{
                width: dotSize,
                height: dotSize,
                backgroundColor: CALLBACK_AUTH_STATUS_COLOR[callbackAuthStatus],
                border: `${dotBorder}px solid var(--slock-white, var(--cafe-surface))`,
              }}
            />
          ) : (
            <span
              role="status"
              data-testid="callback-auth-dot"
              data-callback-auth-status={callbackAuthStatus}
              aria-label={callbackAuthLabel ?? `callback-auth: ${callbackAuthStatus}`}
              title={callbackAuthLabel ?? `callback-auth: ${callbackAuthStatus}`}
              className="block rounded-full"
              style={{
                width: dotSize,
                height: dotSize,
                backgroundColor: CALLBACK_AUTH_STATUS_COLOR[callbackAuthStatus],
                border: `${dotBorder}px solid var(--slock-white, var(--cafe-surface))`,
              }}
            />
          )}
          {popoverOpen && callbackAuthPopover && (
            <div
              data-testid="callback-auth-popover"
              className="absolute z-50 mt-1 rounded-lg border border-cafe-border bg-cafe-surface p-3 text-xs shadow-xl"
              style={{ top: dotSize + dotBorder, right: 0, minWidth: 200, maxWidth: 280 }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              {callbackAuthPopover}
            </div>
          )}
        </span>
      )}
    </div>
  );
}
