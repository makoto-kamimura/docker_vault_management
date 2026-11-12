// Types shared by the sync engine, its store binding and the UI. No React Native imports here.
export type SyncKind = 'synced' | 'syncing' | 'offline' | 'error' | 'rollback';

export type SyncErrorKind =
  | 'network'
  | 'server'
  | 'rateLimited'
  | 'clockSkew'
  | 'protocol'
  | 'unknown';

export type SyncStatus = {
  kind: SyncKind;
  /** ISO 8601 of the last completed sync in this session (or null). */
  lastSyncedAt: string | null;
  errorKind?: SyncErrorKind;
  /** The pull reported that a new VK needs the master password (FR / §7.7). */
  needsMasterPassword: boolean;
  /** Milliseconds until the next automatic retry, when one is scheduled. */
  retryInMs?: number;
};

export const initialSyncStatus: SyncStatus = {
  kind: 'synced',
  lastSyncedAt: null,
  needsMasterPassword: false,
};
