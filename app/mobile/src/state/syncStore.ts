import { create } from 'zustand';
import { initialSyncStatus, type SyncStatus } from '../sync/types';

type SyncStore = {
  status: SyncStatus;
  setStatus: (status: SyncStatus) => void;
};

export const useSyncStore = create<SyncStore>((set) => ({
  status: initialSyncStatus,
  setStatus: (status) => set({ status }),
}));
