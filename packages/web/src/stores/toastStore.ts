'use client';

import { create } from 'zustand';

/**
 * Optional inline action, e.g. undoing a soft delete.
 *
 * Reversible destructive actions should offer the reversal where the user already is,
 * instead of relying on them finding the trash bin at the bottom of the sidebar.
 */
export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message: string;
  threadId?: string;
  /** Auto-dismiss after ms (0 = no auto-dismiss) */
  duration: number;
  createdAt: number;
  /** Set true when exit animation starts */
  exiting?: boolean;
  action?: ToastAction;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, 'id' | 'createdAt'>) => string;
  removeToast: (id: string) => void;
  markExiting: (id: string) => void;
}

let nextId = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = `toast-${++nextId}-${Date.now()}`;
    const item: ToastItem = { ...toast, id, createdAt: Date.now() };
    set((state) => ({
      toasts: [...state.toasts.slice(-9), item], // Keep max 10
    }));
    return id;
  },

  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),

  markExiting: (id) =>
    set((state) => ({
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, exiting: true } : t)),
    })),
}));
