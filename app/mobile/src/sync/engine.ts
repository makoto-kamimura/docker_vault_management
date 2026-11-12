// Sync engine: spec §15 `syncOnce` + §7.8 triggers. Pure TypeScript (no React Native imports) so it
// can be tested against FakeVaultCore and a fake fetch.
//
// fullResync rule (docs/spec-review.md, W2): when a pull answers `fullResync: true` we restart from
// `since=0` and IGNORE `fullResync` on every later page of that restart (otherwise it loops). All
// pages of the restart are handed to VaultCore with `fullResync: true`.
import { type VaultCore, VaultCoreError } from '@localvault/core';
import { ApiError } from '@localvault/protocol';
import { type ApiClient, InvalidResponseError, NetworkError } from '../api';
import { syncConfig } from '../env';
import { initialSyncStatus, type SyncErrorKind, type SyncStatus } from './types';

export type SyncCore = Pick<
  VaultCore,
  'getPendingChanges' | 'applyPushResults' | 'getSyncState' | 'applyPulled' | 'acceptServerState'
>;

export const PUSH_BATCH = 100;
export const PULL_LIMIT = 500;
/** Safety net against a misbehaving server that keeps producing conflicts forever. */
const MAX_PUSH_ROUNDS = 50;
const MAX_PULL_PAGES = 1000;

export async function syncOnce(deps: {
  core: SyncCore;
  api: Pick<ApiClient, 'call'>;
}): Promise<{ needsMasterPassword: boolean }> {
  const { core, api } = deps;
  let needsMasterPassword = false;

  const pull = async (): Promise<void> => {
    let { cursor } = await core.getSyncState();
    let restarted = false;
    for (let page = 0; page < MAX_PULL_PAGES; page++) {
      const res = await api.call('getRecords', { query: { since: cursor, limit: PULL_LIMIT } });
      if (res.fullResync && !restarted) {
        restarted = true;
        cursor = 0;
        continue;
      }
      const r = await core.applyPulled({
        records: res.records,
        cursor: res.cursor,
        keyset: res.keyset,
        fullResync: restarted,
      });
      if (r.needsMasterPassword) needsMasterPassword = true;
      if (!res.hasMore) return;
      if (res.cursor === cursor) throw new InvalidResponseError('getRecords', 200);
      cursor = res.cursor;
    }
    throw new InvalidResponseError('getRecords', 200);
  };

  // ---- push
  let pulledForStaleKey = false;
  for (let round = 0; round < MAX_PUSH_ROUNDS; round++) {
    const changes = await core.getPendingChanges(PUSH_BATCH);
    if (changes.length === 0) break;
    try {
      const res = await api.call('postRecordsBatch', { body: { changes } });
      await core.applyPushResults(res.results);
    } catch (e) {
      // E_STALE_KEY / E_VERSION_CONFLICT: sync first, then try once more (spec §14 table).
      if (
        !pulledForStaleKey &&
        e instanceof ApiError &&
        (e.code === 'E_STALE_KEY' || e.code === 'E_VERSION_CONFLICT')
      ) {
        pulledForStaleKey = true;
        await pull();
        continue;
      }
      throw e;
    }
  }

  // ---- pull
  await pull();
  return { needsMasterPassword };
}

// ------------------------------------------------------------------ engine

export type SyncReason =
  | 'launch'
  | 'foreground'
  | 'saved'
  | 'manual'
  | 'timer'
  | 'retry'
  | 'unlock';

export type SyncEngineDeps = {
  core: SyncCore;
  api: Pick<ApiClient, 'call'>;
  report: (status: SyncStatus) => void;
  onDeviceRevoked: () => void | Promise<void>;
  onAccountDeleted: () => void | Promise<void>;
  now?: () => number;
};

export type SyncEngine = {
  /** Foreground + launch: starts the 5-minute timer and syncs now. */
  start(): void;
  /** Stops all timers (sign-out, wipe). */
  stop(): void;
  setForeground(foreground: boolean): void;
  requestSync(reason: SyncReason): Promise<void>;
  /** VaultCore `onSyncNeeded`: debounced 1 s. */
  notifySyncNeeded(): void;
  /** After the user accepted the server state (§7.5). */
  acceptRollback(): Promise<void>;
  /** After re-registration: syncing may run again. */
  resume(): void;
  getStatus(): SyncStatus;
};

export function backoffDelayMs(failures: number): number {
  const exp = Math.max(0, failures - 1);
  return Math.min(syncConfig.backoffBaseMs * 2 ** exp, syncConfig.backoffMaxMs);
}

type Timer = ReturnType<typeof setTimeout>;

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const now = deps.now ?? Date.now;
  let status: SyncStatus = { ...initialSyncStatus };
  let running: Promise<void> | null = null;
  let rerun = false;
  let halted = false;
  let foreground = false;
  let failures = 0;
  let retryTimer: Timer | null = null;
  let debounceTimer: Timer | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  const publish = (next: SyncStatus) => {
    status = next;
    deps.report(next);
  };

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };
  const clearDebounce = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
  };
  const clearInterval_ = () => {
    if (intervalTimer !== null) clearInterval(intervalTimer);
    intervalTimer = null;
  };

  const scheduleRetry = (delayMs: number) => {
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void requestSync('retry');
    }, delayMs);
  };

  const fail = (kind: 'offline' | 'error', errorKind: SyncErrorKind, minDelayMs = 0) => {
    failures += 1;
    const delay = Math.max(backoffDelayMs(failures), minDelayMs);
    publish({ ...status, kind, errorKind, retryInMs: delay });
    if (!halted) scheduleRetry(delay);
  };

  const halt = () => {
    halted = true;
    clearRetry();
    clearDebounce();
    clearInterval_();
  };

  async function handleError(e: unknown, previous: SyncStatus): Promise<void> {
    if (e instanceof ApiError) {
      switch (e.code) {
        case 'E_DEVICE_REVOKED':
          halt();
          publish({ ...status, kind: 'error', errorKind: 'protocol' });
          await deps.onDeviceRevoked();
          return;
        case 'E_ACCOUNT_DELETED':
          halt();
          publish({ ...status, kind: 'error', errorKind: 'protocol' });
          await deps.onAccountDeleted();
          return;
        case 'E_CLOCK_SKEW':
          fail('error', 'clockSkew');
          return;
        case 'E_RATE_LIMITED': {
          const sec = Number(e.details?.retryAfterSec);
          fail('error', 'rateLimited', Number.isFinite(sec) ? sec * 1000 : 0);
          return;
        }
        case 'E_INTERNAL':
          fail('error', 'server');
          return;
        default:
          fail('error', 'protocol');
          return;
      }
    }
    if (e instanceof NetworkError) {
      fail('offline', 'network');
      return;
    }
    if (e instanceof InvalidResponseError) {
      fail('error', 'protocol');
      return;
    }
    if (e instanceof VaultCoreError) {
      switch (e.code) {
        case 'E_ROLLBACK_DETECTED':
          halt();
          publish({ ...status, kind: 'rollback', errorKind: undefined, retryInMs: undefined });
          return;
        case 'E_LOCKED':
          // Nothing to do while locked; the unlock event requests a new sync.
          publish({ ...previous, kind: previous.kind === 'syncing' ? 'synced' : previous.kind });
          return;
        case 'E_NEEDS_MASTER_PASSWORD':
          publish({
            ...status,
            kind: 'error',
            errorKind: 'protocol',
            needsMasterPassword: true,
            retryInMs: undefined,
          });
          return;
        default:
          fail('error', 'unknown');
          return;
      }
    }
    fail('error', 'unknown');
  }

  async function runOnce(): Promise<void> {
    const previous = status;
    publish({ ...status, kind: 'syncing', errorKind: undefined, retryInMs: undefined });
    try {
      const { needsMasterPassword } = await syncOnce({ core: deps.core, api: deps.api });
      failures = 0;
      clearRetry();
      publish({
        kind: 'synced',
        lastSyncedAt: new Date(now()).toISOString(),
        needsMasterPassword,
      });
    } catch (e) {
      await handleError(e, previous);
    }
  }

  function requestSync(reason: SyncReason): Promise<void> {
    if (halted) return Promise.resolve();
    if (reason === 'saved') {
      clearDebounce();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void requestSync('manual');
      }, syncConfig.saveDebounceMs);
      return Promise.resolve();
    }
    if (reason !== 'retry') clearRetry();
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await runOnce();
        } while (rerun && !halted);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  const startInterval = () => {
    clearInterval_();
    intervalTimer = setInterval(() => void requestSync('timer'), syncConfig.intervalMs);
  };

  return {
    start() {
      halted = false;
      foreground = true;
      startInterval();
      void requestSync('launch');
    },
    stop() {
      halt();
      foreground = false;
    },
    setForeground(next) {
      if (next === foreground) return;
      foreground = next;
      if (next) {
        startInterval();
        void requestSync('foreground');
      } else {
        clearInterval_();
        clearDebounce();
        clearRetry();
      }
    },
    requestSync,
    notifySyncNeeded() {
      void requestSync('saved');
    },
    async acceptRollback() {
      await deps.core.acceptServerState();
      halted = false;
      failures = 0;
      if (foreground) startInterval();
      await requestSync('manual');
    },
    resume() {
      halted = false;
      failures = 0;
      if (foreground) startInterval();
    },
    getStatus: () => status,
  };
}
