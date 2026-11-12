// `PcClient`: the facade over the whole core. Stateless: every call re-reads storage (12.4), so a
// freshly built client over the same storage continues exactly where a stopped worker left off.
import type { ApiError } from '@localvault/protocol';
import { parseServerUrl } from '@localvault/protocol';
import { wipeAll } from './account';
import { ApiClient } from './api';
import { PcError } from './errors';
import { cancelPairing, type PairPoll, type PairStart, pollPairing, startPairing } from './pairing';
import { afterUse, getSession, getVk, type LockReason, lock } from './session';
import {
  type ClipboardClearSec,
  type Config,
  type Notice,
  type SyncWarning,
  store,
} from './storage';
import { acceptServerState, pullRecords, type SyncOutcome } from './sync';
import type { Env } from './types';
import { cancelUnlock, pollUnlock, startUnlock, type UnlockPoll } from './unlock';
import {
  buildIndex,
  decryptLogin,
  type ItemSummary,
  matchOrigin,
  parseSenderOrigin,
  searchEntries,
  summaryOf,
} from './vault-index';

export type PcStatus = {
  paired: boolean;
  serverUrl: string | null;
  deviceName: string | null;
  locked: boolean;
  /** Epoch ms; null when locked. */
  expiresAt: number | null;
  singleUse: boolean;
  pending:
    | null
    | { kind: 'unlock'; code: string; expiresAt: number }
    | { kind: 'pair'; expiresAt: number };
  itemCount: number;
  skipped: number;
  lastSyncedAt: number | null;
  warning: SyncWarning | null;
  notice: Notice | null;
  clipboardClearSec: ClipboardClearSec;
};

export type SenderOrigin = { origin: string | undefined; frameId: number | undefined };

export type CandidatesResult =
  | { kind: 'locked'; paired: boolean }
  | { kind: 'insecure'; host: string }
  | { kind: 'unsupported' }
  | {
      kind: 'ok';
      host: string;
      /** True when the form lives in an iframe: the UI labels the list with `host`. */
      framed: boolean;
      items: (ItemSummary & { rank: 'host' | 'domain' })[];
    };

export type FillFields = 'both' | 'username' | 'password';
export type FillRequest = { id: string; fields: FillFields; insecureConfirmed?: boolean };
export type FillResult = { username?: string; password?: string };

export type PopupItem = ItemSummary & { matched: boolean };

export function createPcClient(env: Env) {
  const makeApi = (origin: string) =>
    new ApiClient(env, origin, async (e: ApiError) => {
      // 8.8-4 / G1 / G3: the server says this device is gone -> wipe everything, back to initial.
      if (e.code === 'E_DEVICE_REVOKED') await wipeAll(env, 'revoked');
      else if (e.code === 'E_ACCOUNT_DELETED') await wipeAll(env, 'account_deleted');
    });

  async function requireAccount() {
    const a = await store.account(env);
    if (a === null) throw new PcError('E_NOT_PAIRED', 'not paired');
    return a;
  }

  async function requireVk() {
    const account = await requireAccount();
    const v = await getVk(env);
    if (v === null) throw new PcError('E_LOCKED', 'locked');
    return { account, ...v };
  }

  const client = {
    async status(): Promise<PcStatus> {
      const [config, account, session, pending, sync, notice, index] = await Promise.all([
        store.config(env),
        store.account(env),
        getSession(env),
        store.pending(env),
        store.sync(env),
        store.notice(env),
        store.index(env),
      ]);
      const now = env.clock.now();
      return {
        paired: account !== null,
        serverUrl: account?.serverUrl ?? config.serverUrl,
        deviceName: account?.deviceName ?? null,
        locked: session === null,
        expiresAt: session?.expiresAt ?? null,
        singleUse: session?.singleUse ?? false,
        pending:
          pending === null || now > pending.expiresAt
            ? null
            : pending.kind === 'unlock'
              ? { kind: 'unlock', code: pending.code, expiresAt: pending.expiresAt }
              : { kind: 'pair', expiresAt: pending.expiresAt },
        itemCount: session === null ? 0 : (index?.entries.length ?? 0),
        skipped: session === null ? 0 : (index?.skipped ?? 0),
        lastSyncedAt: sync.lastSyncedAt,
        warning: sync.warning,
        notice,
        clipboardClearSec: config.clipboardClearSec,
      };
    },

    // ---- config
    async setClipboardClear(sec: ClipboardClearSec): Promise<void> {
      await store.setConfig(env, { ...(await store.config(env)), clipboardClearSec: sec });
    },
    async config(): Promise<Config> {
      return store.config(env);
    },
    /** Validates (https only; G11 exception behind the build flag) and returns the origin. */
    checkServerUrl(input: string): string {
      const r = parseServerUrl(input.trim(), {
        allowInsecureLocalhost: env.allowInsecureLocalhost,
      });
      if (!r.ok) throw new PcError('E_BAD_SERVER_URL', r.reason);
      return r.origin;
    },

    // ---- pairing
    startPairing(serverUrl: string): Promise<PairStart> {
      return startPairing(env, makeApi, serverUrl);
    },
    pollPairing(): Promise<PairPoll> {
      return pollPairing(env, makeApi);
    },
    cancelPairing: () => cancelPairing(env),
    /** Local unpair: session, cache and key are deleted. The phone still lists the device. */
    unpair: () => wipeAll(env, 'unpaired'),

    // ---- unlock / lock
    startUnlock: () => startUnlock(env, makeApi),
    pollUnlock(): Promise<UnlockPoll> {
      return pollUnlock(env, makeApi);
    },
    cancelUnlock: () => cancelUnlock(env),
    lock: (reason: LockReason = 'manual') => lock(env, reason),
    /** Alarm tick and pre-operation check: an expired session is locked. */
    async checkSession(): Promise<boolean> {
      return (await getSession(env)) !== null;
    },

    // ---- sync
    async sync(): Promise<SyncOutcome | { status: 'skipped' }> {
      const account = await store.account(env);
      if (account === null) return { status: 'skipped' };
      const out = await pullRecords(env, makeApi(account.serverUrl), account);
      if (out.status === 'ok' && out.changed) {
        const v = await getVk(env);
        if (v !== null) {
          await store.setIndex(
            env,
            await buildIndex(
              env,
              account.accountId,
              v.vk,
              v.session.vkVersion,
              await store.records(env),
            ),
          );
        }
      }
      return out;
    },
    /** 7.5: the user accepts the (possibly rolled-back) server state and refetches everything. */
    async acceptServerState(): Promise<SyncOutcome> {
      const account = await requireAccount();
      await acceptServerState(env);
      const out = await pullRecords(env, makeApi(account.serverUrl), account);
      await lock(env, 'manual'); // the index must be rebuilt through a fresh unlock
      return out;
    },

    // ---- matching (9.4): only the sender's origin counts, never a URL the page claims
    async candidates(sender: SenderOrigin): Promise<CandidatesResult> {
      const account = await store.account(env);
      const session = await getSession(env);
      if (account === null || session === null) return { kind: 'locked', paired: account !== null };
      const origin = parseSenderOrigin(sender.origin);
      if (origin === null) return { kind: 'unsupported' };
      if (origin.scheme !== 'https') return { kind: 'insecure', host: origin.host };
      const index = (await store.index(env)) ?? { entries: [], skipped: 0 };
      const byId = new Map(index.entries.map((e) => [e.id, e]));
      const items = matchOrigin(env.psl, origin, index.entries).flatMap((m) => {
        const e = byId.get(m.id);
        return e === undefined ? [] : [{ ...summaryOf(e), rank: m.rank }];
      });
      return { kind: 'ok', host: origin.host, framed: (sender.frameId ?? 0) !== 0, items };
    },

    /** Manual search from a content script: only on http pages, after the user confirmed. */
    async searchForInsecurePage(sender: SenderOrigin, query: string): Promise<ItemSummary[]> {
      const origin = parseSenderOrigin(sender.origin);
      if (origin === null || origin.scheme !== 'http') {
        throw new PcError('E_FORBIDDEN_ORIGIN', 'search is only available on http pages');
      }
      await requireVk();
      const index = (await store.index(env)) ?? { entries: [], skipped: 0 };
      return searchEntries(index.entries, query).slice(0, 50).map(summaryOf);
    },

    /** Returns credentials after re-checking the sender's origin against the item (12.6-4). */
    async fill(sender: SenderOrigin, req: FillRequest): Promise<FillResult> {
      const { account, vk } = await requireVk();
      const origin = parseSenderOrigin(sender.origin);
      if (origin === null) throw new PcError('E_FORBIDDEN_ORIGIN', 'origin not usable');
      const index = (await store.index(env)) ?? { entries: [], skipped: 0 };
      if (origin.scheme === 'http') {
        // 9.1-2: http only by manual selection, after an explicit warning + confirmation.
        if (req.insecureConfirmed !== true)
          throw new PcError('E_INSECURE_PAGE', 'confirmation required');
        if (!index.entries.some((e) => e.id === req.id))
          throw new PcError('E_NOT_FOUND', 'no such item');
      } else if (origin.scheme === 'https') {
        if (!matchOrigin(env.psl, origin, index.entries).some((m) => m.id === req.id)) {
          throw new PcError('E_FORBIDDEN_ORIGIN', 'item does not match this origin');
        }
      } else {
        throw new PcError('E_FORBIDDEN_ORIGIN', 'origin not usable');
      }
      const login = await decryptLogin(env, account.accountId, vk, req.id);
      const out: FillResult = {};
      if (req.fields !== 'password') out.username = login.username;
      if (req.fields !== 'username') out.password = login.password;
      await afterUse(env);
      return out;
    },

    // ---- popup
    async listForPopup(query: string, tabId: number | undefined): Promise<PopupItem[]> {
      await requireVk();
      const index = (await store.index(env)) ?? { entries: [], skipped: 0 };
      let matchedIds = new Set<string>();
      if (tabId !== undefined) {
        const tab = (await store.tabs(env))[String(tabId)];
        const origin = parseSenderOrigin(tab?.origin);
        if (origin !== null && origin.scheme === 'https') {
          matchedIds = new Set(matchOrigin(env.psl, origin, index.entries).map((m) => m.id));
        }
      }
      const found = searchEntries(index.entries, query);
      const items = found.map((e) => ({ ...summaryOf(e), matched: matchedIds.has(e.id) }));
      return [...items.filter((i) => i.matched), ...items.filter((i) => !i.matched)];
    },

    /** Only for extension pages (the router enforces that). The password is never rendered. */
    async copyValue(id: string, field: 'username' | 'password'): Promise<string> {
      const { account, vk } = await requireVk();
      const login = await decryptLogin(env, account.accountId, vk, id);
      const value = field === 'username' ? login.username : login.password;
      await afterUse(env);
      return value;
    },

    // ---- tab registry (so the popup knows the current tab's trusted origin)
    async recordTab(tabId: number, origin: string | undefined): Promise<void> {
      if (parseSenderOrigin(origin) === null || origin === undefined) return;
      const tabs = await store.tabs(env);
      tabs[String(tabId)] = { origin, at: env.clock.now() };
      await store.setTabs(env, tabs);
    },
    async forgetTab(tabId: number): Promise<void> {
      const tabs = await store.tabs(env);
      if (String(tabId) in tabs) {
        delete tabs[String(tabId)];
        await store.setTabs(env, tabs);
      }
    },
  };
  return client;
}

export type PcClient = ReturnType<typeof createPcClient>;
