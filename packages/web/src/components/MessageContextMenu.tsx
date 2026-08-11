'use client';

import { useLayoutEffect, useRef, useState } from 'react';

interface MessageContextMenuProps {
  x: number;
  y: number;
  messageId: string;
  content: string;
  onClose: () => void;
  onSave?: () => void;
  onConvertToTask?: () => void;
  onShare?: () => void;
  onPin?: () => void;
  onEdit?: () => void;
  onSoftDelete?: () => void;
  onHardDelete?: () => void;
}

const VIEWPORT_MARGIN = 8;

export function MessageContextMenu({
  x,
  y,
  messageId,
  content,
  onClose,
  onSave,
  onConvertToTask,
  onShare,
  onPin,
  onEdit,
  onSoftDelete,
  onHardDelete,
}: MessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  // 视口边界钳制：菜单从消息右缘/光标处弹出时可能超出屏幕右/下边界，
  // 在绘制前按实际尺寸把位置收回视口内（useLayoutEffect 在 paint 前执行，不闪烁）。
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (el == null || typeof window === 'undefined') {
      setPos({ top: y, left: x });
      return;
    }
    const rect = el.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    }
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN);
    }
    setPos({ top, left });
  }, [x, y]);

  const items = [
    {
      label: '复制链接',
      onClick: () => {
        void navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}#${messageId}`);
        onClose();
      },
    },
    {
      label: '复制 Markdown',
      onClick: () => {
        void navigator.clipboard.writeText(content);
        onClose();
      },
    },
    {
      label: '收藏消息',
      onClick: () => {
        onSave?.();
        onClose();
      },
    },
    {
      label: '转为任务',
      onClick: () => {
        onConvertToTask?.();
        onClose();
      },
    },
    ...(onPin
      ? [
          {
            label: '固定消息',
            onClick: () => {
              onPin();
              onClose();
            },
          },
        ]
      : []),
    ...(onEdit
      ? [
          {
            label: '编辑消息',
            onClick: () => {
              onEdit();
              onClose();
            },
          },
        ]
      : []),
    {
      label: '分享消息…',
      onClick: () => {
        onShare?.();
        onClose();
      },
    },
    ...(onSoftDelete
      ? [
          {
            label: '删除消息',
            onClick: () => {
              onSoftDelete();
              onClose();
            },
          },
        ]
      : []),
    ...(onHardDelete
      ? [
          {
            label: '永久删除',
            onClick: () => {
              onHardDelete();
              onClose();
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} aria-hidden="true" />
      <div
        ref={menuRef}
        className="fixed z-[9999] min-w-[160px] rounded-lg border border-[var(--slock-border-color)] bg-[var(--cafe-surface)] py-1 shadow-lg"
        style={{ top: pos.top, left: pos.left }}
        role="menu"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={item.onClick}
            className="w-full px-3 py-1.5 text-left text-sm text-[var(--cafe-text)] transition-colors hover:bg-[var(--cafe-surface-elevated)]"
            role="menuitem"
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
