import { create } from 'zustand';

/**
 * In-memory state shared by the setup screens. NEVER persisted: `recoveryKey` is a secret that
 * lives only until the emergency kit is confirmed (then `clear()` is called).
 */
type SetupDraft = {
  serverUrl: string;
  registrationMode: 'open' | 'invite' | 'closed' | null;
  accountName: string;
  recoveryKey: string | null;
  /** True while account creation / restore is under way (the guard allows setup routes when unlocked). */
  inProgress: boolean;
  setInProgress: (v: boolean) => void;
  setServer: (serverUrl: string, mode: 'open' | 'invite' | 'closed') => void;
  setAccountName: (name: string) => void;
  setRecoveryKey: (key: string | null) => void;
  clear: () => void;
};

const empty = {
  serverUrl: '',
  registrationMode: null,
  accountName: '',
  recoveryKey: null,
  inProgress: false,
};

export const useSetupDraft = create<SetupDraft>((set) => ({
  ...empty,
  setServer: (serverUrl, registrationMode) => set({ serverUrl, registrationMode }),
  setInProgress: (inProgress) => set({ inProgress }),
  setAccountName: (accountName) => set({ accountName }),
  setRecoveryKey: (recoveryKey) => set({ recoveryKey }),
  clear: () => set({ ...empty }),
}));
