import type { LockState } from '@localvault/core';
import { create } from 'zustand';
import type { DeviceStanding } from '../features/navigation/guard';

export type { DeviceStanding };

type LockStore = {
  /** 'unknown' until the first `getLockState()` finished (show a splash, never a flash of /unlock). */
  lockState: LockState | 'unknown';
  /** What happened to this device on the server (G1, G3). Drives the `/revoked` screen. */
  standing: DeviceStanding;
  setLockState: (state: LockState) => void;
  setStanding: (standing: DeviceStanding) => void;
};

export const useLockStore = create<LockStore>((set) => ({
  lockState: 'unknown',
  standing: 'ok',
  setLockState: (lockState) => set({ lockState }),
  setStanding: (standing) => set({ standing }),
}));
