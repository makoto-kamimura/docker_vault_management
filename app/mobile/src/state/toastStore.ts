import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error';
export type ToastItem = { id: number; kind: ToastKind; message: string };

type ToastStore = {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string) => number;
  dismiss: (id: number) => void;
};

let nextId = 1;

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (kind, message) => {
    const id = nextId++;
    // Keep at most 3 on screen; messages never contain secrets (callers pass i18n strings).
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, message }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
