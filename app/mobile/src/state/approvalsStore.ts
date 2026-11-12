import { create } from 'zustand';

/** Pending PC approvals / recovery claims (badge on the list screen; filled by the next wave). */
type ApprovalsStore = {
  pendingCount: number;
  setPendingCount: (n: number) => void;
};

export const useApprovalsStore = create<ApprovalsStore>((set) => ({
  pendingCount: 0,
  setPendingCount: (pendingCount) => set({ pendingCount }),
}));
