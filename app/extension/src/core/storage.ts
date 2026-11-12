// Typed storage layout. Each key is read and validated on use; no module-level state (12.4).
import type { EncryptedRecord } from '@localvault/protocol';
import { encryptedRecordSchema, uuidSchema } from '@localvault/protocol';
import { z } from 'zod';
import type { Env, StorageArea } from './types';

export const KEY = {
  // chrome.storage.local
  config: 'lv.config',
  account: 'lv.account',
  sync: 'lv.sync',
  records: 'lv.records',
  notice: 'lv.notice',
  clipboard: 'lv.clipboard',
  // chrome.storage.session
  session: 'lvs.session',
  index: 'lvs.index',
  pending: 'lvs.pending',
  token: 'lvs.token',
  tabs: 'lvs.tabs',
} as const;

/** Clipboard clear delays (seconds) offered in the options page; null = never. */
export const CLIPBOARD_CLEAR_CHOICES = [30, 60, 120, null] as const;
export type ClipboardClearSec = (typeof CLIPBOARD_CLEAR_CHOICES)[number];

export const configSchema = z.strictObject({
  serverUrl: z.string().nullable(),
  clipboardClearSec: z.union([z.literal(30), z.literal(60), z.literal(120), z.null()]),
});
export type Config = z.infer<typeof configSchema>;
export const DEFAULT_CONFIG: Config = { serverUrl: null, clipboardClearSec: 60 };

export const accountSchema = z.strictObject({
  accountId: uuidSchema,
  deviceId: uuidSchema,
  serverUrl: z.string(),
  deviceName: z.string(),
  pairedAt: z.string(),
});
export type Account = z.infer<typeof accountSchema>;

export const syncWarningSchema = z.strictObject({
  kind: z.literal('rollback'),
  detail: z.string(),
  at: z.number(),
});
export type SyncWarning = z.infer<typeof syncWarningSchema>;

export const syncStateSchema = z.strictObject({
  cursor: z.int().min(0),
  maxSeenRev: z.int().min(0),
  keysetVersion: z.int().min(0),
  vkVersion: z.int().min(0),
  lastSyncedAt: z.number().nullable(),
  /** Set when sync is halted (7.5). Cleared only by `acceptServerState`. */
  warning: syncWarningSchema.nullable(),
});
export type SyncState = z.infer<typeof syncStateSchema>;
export const EMPTY_SYNC: SyncState = {
  cursor: 0,
  maxSeenRev: 0,
  keysetVersion: 0,
  vkVersion: 0,
  lastSyncedAt: null,
  warning: null,
};

export const noticeSchema = z.strictObject({
  kind: z.enum(['revoked', 'account_deleted', 'unpaired']),
  at: z.number(),
});
export type Notice = z.infer<typeof noticeSchema>;

export const sessionSchema = z.strictObject({
  /** base64url, 32 bytes */
  vk: z.string(),
  vkVersion: z.int().min(1),
  sessionMaxSec: z.number(),
  /** Epoch ms. Always set: single-use sessions (sessionMaxSec 0) get a short safety cap. */
  expiresAt: z.number(),
  /** sessionMaxSec 0: lock right after one fill / copy. */
  singleUse: z.boolean(),
  unlockedAt: z.number(),
});
export type SessionData = z.infer<typeof sessionSchema>;

export const indexEntrySchema = z.strictObject({
  id: uuidSchema,
  title: z.string(),
  username: z.string(),
  urls: z.array(z.strictObject({ url: z.string(), match: z.enum(['domain', 'host']) })),
});
export type IndexEntry = z.infer<typeof indexEntrySchema>;
export const indexSchema = z.strictObject({
  entries: z.array(indexEntrySchema),
  /** Records that could not be decrypted (wrong vkVersion, corruption). */
  skipped: z.int().min(0),
});
export type IndexData = z.infer<typeof indexSchema>;

export const pendingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('pair'),
    pairingId: uuidSchema,
    pollToken: z.string(),
    deviceId: uuidSchema,
    serverUrl: z.string(),
    /** Ephemeral ECDH private scalar, base64url (the one secret allowed in session storage). */
    ephPriv: z.string(),
    ephPub: z.string(),
    signPub: z.string(),
    expiresAt: z.number(),
    deviceName: z.string(),
  }),
  z.strictObject({
    kind: z.literal('unlock'),
    requestId: uuidSchema,
    ephPriv: z.string(),
    code: z.string(),
    expiresAt: z.number(),
  }),
]);
export type Pending = z.infer<typeof pendingSchema>;

export const tokenSchema = z.strictObject({ accessToken: z.string(), expiresAt: z.number() });
export type TokenData = z.infer<typeof tokenSchema>;

export const clipboardSchema = z.strictObject({ clearAt: z.number() });

export const tabsSchema = z.record(
  z.string(),
  z.strictObject({ origin: z.string(), at: z.number() }),
);
export type TabsData = z.infer<typeof tabsSchema>;

const recordsSchema = z.record(z.string(), encryptedRecordSchema);
export type RecordCache = Record<string, EncryptedRecord>;

async function read<S extends z.ZodType>(
  area: StorageArea,
  key: string,
  schema: S,
): Promise<z.output<S> | null> {
  const raw = (await area.get(key))[key];
  if (raw === undefined) return null;
  const r = schema.safeParse(raw);
  // A value that does not validate is treated as absent (never trusted).
  return r.success ? r.data : null;
}

export const store = {
  async config(env: Env): Promise<Config> {
    return (await read(env.local, KEY.config, configSchema)) ?? DEFAULT_CONFIG;
  },
  setConfig: (env: Env, c: Config) => env.local.set({ [KEY.config]: c }),
  account: (env: Env) => read(env.local, KEY.account, accountSchema),
  setAccount: (env: Env, a: Account) => env.local.set({ [KEY.account]: a }),
  async sync(env: Env): Promise<SyncState> {
    return (await read(env.local, KEY.sync, syncStateSchema)) ?? EMPTY_SYNC;
  },
  setSync: (env: Env, s: SyncState) => env.local.set({ [KEY.sync]: s }),
  async records(env: Env): Promise<RecordCache> {
    return (await read(env.local, KEY.records, recordsSchema)) ?? {};
  },
  setRecords: (env: Env, r: RecordCache) => env.local.set({ [KEY.records]: r }),
  notice: (env: Env) => read(env.local, KEY.notice, noticeSchema),
  setNotice: (env: Env, n: Notice | null) =>
    n === null ? env.local.remove(KEY.notice) : env.local.set({ [KEY.notice]: n }),
  clipboardAt: (env: Env) => read(env.local, KEY.clipboard, clipboardSchema),

  session: (env: Env) => read(env.session, KEY.session, sessionSchema),
  setSession: (env: Env, s: SessionData) => env.session.set({ [KEY.session]: s }),
  index: (env: Env) => read(env.session, KEY.index, indexSchema),
  setIndex: (env: Env, i: IndexData) => env.session.set({ [KEY.index]: i }),
  pending: (env: Env) => read(env.session, KEY.pending, pendingSchema),
  setPending: (env: Env, p: Pending) => env.session.set({ [KEY.pending]: p }),
  clearPending: (env: Env) => env.session.remove(KEY.pending),
  token: (env: Env) => read(env.session, KEY.token, tokenSchema),
  setToken: (env: Env, t: TokenData) => env.session.set({ [KEY.token]: t }),
  tabs: async (env: Env): Promise<TabsData> =>
    (await read(env.session, KEY.tabs, tabsSchema)) ?? {},
  setTabs: (env: Env, t: TabsData) => env.session.set({ [KEY.tabs]: t }),
};

/** In-memory `StorageArea` for tests and fakes. Values are structured-cloned like the real one. */
export function createMemoryStorage(): StorageArea & { dump(): Record<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      const names =
        keys === null ? [...data.keys()] : typeof keys === 'string' ? [keys] : [...keys];
      for (const k of names) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys) {
      for (const k of typeof keys === 'string' ? [keys] : keys) data.delete(k);
    },
    async clear() {
      data.clear();
    },
    dump() {
      return Object.fromEntries(data);
    },
  };
}
