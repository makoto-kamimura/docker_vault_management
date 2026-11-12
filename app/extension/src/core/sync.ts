// Pull-only sync (7.2, 7.8) with rollback detection (7.5). The PC never pushes.
import type { EncryptedRecord, Keyset } from '@localvault/protocol';
import type { ApiClient } from './api';
import { lock } from './session';
import { type Account, type RecordCache, type SyncState, store } from './storage';
import type { Env } from './types';

export type SyncOutcome =
  | { status: 'ok'; changed: boolean; vkChanged: boolean }
  | { status: 'halted'; detail: string };

const PAGE = 500;
const MAX_PAGES = 2000;

class Rollback extends Error {}

function sameCipher(a: EncryptedRecord, b: EncryptedRecord): boolean {
  return (
    a.deleted === b.deleted && a.vkVersion === b.vkVersion && a.nonce === b.nonce && a.ct === b.ct
  );
}

/**
 * Fetches everything newer than the stored cursor. All pages are validated in memory first and
 * written once, so a detected rollback leaves the local cache exactly as it was.
 */
export async function pullRecords(
  env: Env,
  api: ApiClient,
  account: Account,
): Promise<SyncOutcome> {
  const state = await store.sync(env);
  if (state.warning !== null) return { status: 'halted', detail: state.warning.detail };

  let working: RecordCache = { ...(await store.records(env)) };
  let since = state.cursor;
  let fresh = false; // true once the server told us to refetch everything
  let maxSeenRev = state.maxSeenRev;
  let latestKeyset: Keyset | undefined;
  let finalCursor = state.cursor;
  let changed = false;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await api.authed('getRecords', account.deviceId, {
        query: { since, limit: PAGE },
      });

      if (res.fullResync && !fresh) {
        // 7.6: our cursor predates the tombstone horizon. Restart from zero into a fresh cache;
        // records absent from the server are dropped. Revision regressions are expected here.
        fresh = true;
        working = {};
        since = 0;
        changed = true;
        continue;
      }

      if (!fresh && res.cursor < state.cursor) {
        throw new Rollback('cursor went backwards');
      }
      if (res.keyset !== undefined) {
        if (res.keyset.keysetVersion < state.keysetVersion)
          throw new Rollback('keyset version went backwards');
        if (res.keyset.vkVersion < state.vkVersion) throw new Rollback('vk version went backwards');
        latestKeyset = res.keyset;
      }
      for (const r of res.records) {
        if (!fresh) {
          if (r.rev <= since) throw new Rollback('record is older than the requested cursor');
          if (r.vkVersion < state.vkVersion) throw new Rollback('record uses an older vault key');
          const prev = working[r.id];
          if (prev !== undefined) {
            if (r.rev < prev.rev) throw new Rollback('record revision went backwards');
            if (r.rev === prev.rev && !sameCipher(r, prev))
              throw new Rollback('record content changed without a new revision');
          }
        }
        working[r.id] = r;
        if (r.rev > maxSeenRev) maxSeenRev = r.rev;
        changed = true;
      }
      finalCursor = res.cursor;
      if (!res.hasMore) break;
      since = res.cursor;
    }
  } catch (e) {
    if (e instanceof Rollback) {
      const next: SyncState = {
        ...state,
        warning: { kind: 'rollback', detail: e.message, at: env.clock.now() },
      };
      await store.setSync(env, next);
      return { status: 'halted', detail: e.message };
    }
    throw e;
  }

  const prevVk = state.vkVersion;
  const next: SyncState = {
    cursor: finalCursor,
    maxSeenRev,
    keysetVersion: Math.max(state.keysetVersion, latestKeyset?.keysetVersion ?? 0),
    vkVersion: Math.max(state.vkVersion, latestKeyset?.vkVersion ?? 0),
    lastSyncedAt: env.clock.now(),
    warning: null,
  };
  if (changed) await store.setRecords(env, working);
  await store.setSync(env, next);

  // 7.7: after a key rotation our VK is stale. Lock; the next unlock via the phone yields the new VK.
  const vkChanged = prevVk > 0 && next.vkVersion > prevVk;
  if (vkChanged) {
    const s = await store.session(env);
    if (s !== null && s.vkVersion < next.vkVersion) await lock(env, 'vk_changed');
  }
  return { status: 'ok', changed, vkChanged };
}

/** "Accept the server state" (7.5): forget cursor, cache and warning; the next pull is a full one. */
export async function acceptServerState(env: Env): Promise<void> {
  await env.local.remove(['lv.records', 'lv.sync']);
}
