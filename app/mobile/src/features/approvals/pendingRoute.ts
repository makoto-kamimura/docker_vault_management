import { create } from 'zustand';

/** A route requested (notification tap, "身に覚えがない") while the app was locked. */
type PendingRouteStore = {
  route: string | null;
  set: (route: string | null) => void;
};

export const usePendingRoute = create<PendingRouteStore>((set) => ({
  route: null,
  set: (route) => set({ route }),
}));

/** Where the "pending approvals" banner leads (the oldest waiting request). */
export const usePendingTarget = create<PendingRouteStore>((set) => ({
  route: null,
  set: (route) => set({ route }),
}));
