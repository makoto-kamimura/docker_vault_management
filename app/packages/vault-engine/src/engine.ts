// The stateful reference implementation of `VaultCore` (spec §15 + v0.4). It never talks to the
// network: secret-bearing operations return `ServerRequest`s for the caller to send.
import {
  type AccountInfo,
  attemptsBeforeThrottle,
  buildAdminHeader,
  type CopyField,
  CryptoError,
  type CsvFormatName,
  signAuthChallenge as coreSignAuthChallenge,
  verifyUnlockRequest as coreVerifyUnlock,
  createExportFile,
  createKeyset,
  createRecoveryCodeRegistration,
  type DeviceInfo,
  type DeviceRegistration,
  decryptRecord,
  deriveMasterKeys,
  deriveRecoveryCodeKeys,
  encryptRecord,
  evaluateCodeAttempt,
  findDuplicateDrafts,
  formatRecoveryCode,
  formatRecoveryKey,
  generatePassword,
  generateRecoveryCode,
  generateRecoveryKeyBytes,
  hostOfStoredUrl,
  type ItemDetail,
  type ItemInput,
  type ItemSummary,
  type LockState,
  matchesQuery,
  openExportFile,
  type PairingInfo,
  type PendingUnlockRequest,
  parseCsvImport,
  parseRecoveryCode,
  parseRecoveryKey,
  type RecoveryClaimResponse,
  type RecoverySheet,
  type RecoveryWaitSec,
  resolveConflict,
  rewrapKeyset,
  type ServerRequest,
  type Settings,
  type SyncState,
  seal,
  type TrustedBrowser,
  throttleState,
  unwrapVaultKey,
  unwrapVaultKeyWithRecoveryCode,
  uuidV4FromRandom,
  type VaultCore,
  VaultCoreError,
  type VaultCoreEventName,
  type VaultCoreEvents,
  type VaultNotice,
  type VerifyUnlockResult,
  verifyPairingFingerprint,
  wipe,
} from '@localvault/core';
import { defaultPsl } from '@localvault/core/psl-data';
import {
  base64urlDecode,
  base64urlEncode,
  type DeviceData,
  type EncryptedRecord,
  type ExportPayload,
  FIELD,
  formatRcQr,
  type Kdf,
  type Keyset,
  keysetSchema,
  type LoginData,
  META_RECORD_ID,
  type MetaData,
  normalizeAccountName,
  type PushResult,
  parsePairQr,
  parseRcQr,
  parseServerUrl,
  QrParseError,
  type RecordChange,
  type RecordPlain,
  sealContextPair,
  sealContextUnlock,
  TTL_SEC,
  UNLOCK_CODE_MAX_ATTEMPTS,
  utf8Decode,
  utf8Encode,
  type VaultFile,
  type VaultFileRecord,
  vaultFileSchema,
} from '@localvault/protocol';
import type { AuthToken, EngineDeps } from './deps';
import { readWithRecovery, removeAll, writeAtomic } from './store';

// ---------------------------------------------------------------- public extras

/** Same as the contract's `VaultNotice` (kept as an alias for existing imports). */
export type EngineNotice = VaultNotice;

export interface EngineExtras {
  on<E extends VaultCoreEventName>(name: E, fn: (p: VaultCoreEvents[E]) => void): () => void;
  /** Auto-lock bookkeeping (FR-11): the native layer reports lifecycle changes. */
  onBackground(): Promise<void>;
  onForeground(): Promise<void>;
  searchItems(query: string): Promise<ItemSummary[]>;
  /** Trash older than 30 days becomes real deletions (§7.6). */
  purgeExpiredTrash(): Promise<number>;
  isLastApprover(): Promise<boolean>;
  /** Like `VaultCore.revokeDevice`, plus the master password a key rotation needs (new keyset wrapping). */
  revokeDevice(p: {
    deviceId: string;
    rotateKey: boolean;
    masterPassword?: string;
  }): Promise<ServerRequest[]>;
  /** E_DEVICE_REVOKED received (G1): lock and stop syncing. */
  markRevoked(): Promise<void>;
  /** A VK rotation was detected by sync: the master password is needed (§7.7). */
  isRotationPending(): Promise<boolean>;
  rememberUnlockNonce(nonce: string): Promise<void>;
  /** The requests after `POST /v1/rotations` (their paths and signatures need the rotationId). */
  continueRotation(rotationId: string): Promise<ServerRequest[]>;
  confirmRotation(r: { cursor: number }): Promise<void>;
  abortRotation(rotationId: string): Promise<ServerRequest>;
  getStorageStatus(): Promise<{ recoveredFromBackup: boolean; corrupted: boolean }>;
}

type LocalState = {
  v: 1;
  deviceId: string;
  deviceName: string;
  signPub: string;
  adminPub: string;
  biometricsEnabled: boolean;
  autoLockSec: Settings['autoLockSec'];
  clipboardClearSec: Settings['clipboardClearSec'];
  showUsernameBeforeAuth: boolean;
  pcSessionMaxSec: Settings['pcSessionMaxSec'];
  lastExportAt: string | null;
  seenNonces: Record<string, number>;
  pendingRotation: Keyset | null;
  rollbackDetected: boolean;
  allowDowngrade: boolean;
  revoked: boolean;
};

type Session = {
  vk: Uint8Array;
  plains: Map<string, RecordPlain>;
  usage: Record<string, { lastUsedAt: string; count: number }>;
};

type Staged =
  | { kind: 'keyset'; keyset: Keyset; newSk: Uint8Array | null }
  | {
      kind: 'rotation';
      keyset: Keyset;
      verifier: string;
      newVk: Uint8Array;
      expectedRev: number;
      records: { id: string; deleted: boolean; nonce: string | null; ct: string | null }[];
    };

type PendingAccount = {
  file: VaultFile;
  local: LocalState;
  vk: Uint8Array;
  sk: Uint8Array;
  signPriv: Uint8Array;
  adminPriv: Uint8Array;
};

type ClaimSlot = {
  serverUrl: string;
  accountId: string;
  rc: string;
  deviceId: string;
  platform: string;
  signPriv: string;
  adminPriv: string;
  signPub: string;
  adminPub: string;
  claimId?: string;
  claimToken?: string;
  availableAt?: string;
};

const DEFAULT_BROWSERS: TrustedBrowser[] = [
  { packageName: 'com.android.chrome', label: 'Chrome', builtIn: true },
  { packageName: 'org.mozilla.firefox', label: 'Firefox', builtIn: true },
  { packageName: 'com.sec.android.app.sbrowser', label: 'Samsung Internet', builtIn: true },
  { packageName: 'com.microsoft.emmx', label: 'Edge', builtIn: true },
  { packageName: 'com.brave.browser', label: 'Brave', builtIn: true },
];

const b64 = base64urlEncode;
const unb64 = base64urlDecode;
const TRASH_MS = TTL_SEC.trash * 1000;
const NONCE_MS = TTL_SEC.unlockNonceMemory * 1000;

export function createVaultEngine(deps: EngineDeps): VaultCore & EngineExtras {
  return new VaultEngine(deps);
}

class VaultEngine implements VaultCore, EngineExtras {
  #file: VaultFile | null = null;
  #recs = new Map<string, VaultFileRecord>();
  #local: LocalState | null = null;
  #loaded = false;
  #fatalCorrupt = false;
  #recovered = false;
  #session: Session | null = null;
  #pendingAccount: PendingAccount | null = null;
  #pendingRestore: {
    accountId: string;
    deviceId: string;
    signPriv: Uint8Array;
    adminPriv: Uint8Array;
    signPub: string;
    adminPub: string;
  } | null = null;
  #staged: Staged | null = null;
  #inflight = new Map<string, string>();
  #resyncSeen: Set<string> | null = null;
  #unlockFails = new Map<string, number>();
  #notices: EngineNotice[] = [];
  #backgroundedAt: number | null = null;
  #lastState: LockState | null = null;
  #listeners = new Map<VaultCoreEventName, Set<(p: never) => void>>();

  constructor(private readonly d: EngineDeps) {}

  // ================================================================ internals

  #now(): Date {
    return this.d.clock.now();
  }
  #nowIso(): string {
    return this.#now().toISOString();
  }

  #emit<E extends VaultCoreEventName>(name: E, payload: VaultCoreEvents[E]): void {
    for (const fn of this.#listeners.get(name) ?? [])
      (fn as (p: VaultCoreEvents[E]) => void)(payload);
  }
  on<E extends VaultCoreEventName>(name: E, fn: (p: VaultCoreEvents[E]) => void): () => void {
    const set = this.#listeners.get(name) ?? new Set<(p: never) => void>();
    this.#listeners.set(name, set);
    set.add(fn as (p: never) => void);
    return () => void set.delete(fn as (p: never) => void);
  }

  async #emitLockState(): Promise<void> {
    const s = await this.getLockState();
    if (s !== this.#lastState) {
      this.#lastState = s;
      this.#emit('onLockStateChange', { state: s });
    }
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) return;
    const st = this.d.storage;
    const lres = await readWithRecovery<LocalState>(st, 'local.json', (j) =>
      typeof j === 'object' && j !== null && (j as { v?: unknown }).v === 1
        ? (j as LocalState)
        : null,
    );
    const fres = await readWithRecovery<VaultFile>(st, 'vault.lv', (j) => {
      const p = vaultFileSchema.safeParse(j);
      return p.success ? p.data : null;
    });
    if (fres.loaded && lres.loaded) {
      this.#file = fres.loaded.value;
      this.#local = lres.loaded.value;
      this.#recovered = fres.loaded.source !== 'main';
      this.#recs = new Map(this.#file.records.map((r) => [r.id, r]));
      if (this.#recovered) await this.#persistFile();
    } else if (fres.anyFilePresent || lres.anyFilePresent) {
      this.#fatalCorrupt = true;
    }
    this.#loaded = true;
    this.#lastState = null;
  }

  async #persistFile(): Promise<void> {
    const f = this.#file as VaultFile;
    f.records = [...this.#recs.values()];
    await writeAtomic(this.d.storage, 'vault.lv', f);
  }
  async #persistLocal(): Promise<void> {
    await writeAtomic(this.d.storage, 'local.json', this.#local);
  }

  #acct(): { file: VaultFile; local: LocalState } {
    if (!this.#file || !this.#local) {
      if (this.#fatalCorrupt) throw new VaultCoreError('E_CORRUPTED');
      throw new VaultCoreError('E_NOT_FOUND', 'no account on this device');
    }
    return { file: this.#file, local: this.#local };
  }

  #unlocked(): Session & { file: VaultFile; local: LocalState } {
    const a = this.#acct();
    if (!this.#session) throw new VaultCoreError('E_LOCKED');
    return { ...a, ...this.#session, file: a.file, local: a.local } as never;
  }
  #sess(): Session {
    if (!this.#session) throw new VaultCoreError('E_LOCKED');
    return this.#session;
  }

  async #newId(): Promise<string> {
    return uuidV4(await this.d.crypto.randomBytes(16));
  }

  #loginOf(id: string): Extract<RecordPlain, { kind: 'login' }> {
    const p = this.#sess().plains.get(id);
    if (p?.kind !== 'login') throw new VaultCoreError('E_NOT_FOUND');
    return p;
  }

  #devices(): DeviceData[] {
    const out: DeviceData[] = [];
    for (const p of this.#sess().plains.values()) if (p.kind === 'device') out.push(p.data);
    return out;
  }
  #meta(): Extract<RecordPlain, { kind: 'meta' }> | undefined {
    const m = this.#sess().plains.get(META_RECORD_ID);
    return m?.kind === 'meta' ? m : undefined;
  }

  /** Encrypts `plain` for record `id` and stores it as a local (dirty) revision. */
  async #putLocal(id: string, plain: RecordPlain): Promise<void> {
    const { file } = this.#acct();
    const s = this.#sess();
    const enc = await encryptRecord(
      this.d.crypto,
      s.vk,
      { accountId: file.accountId, recordId: id, vkVersion: file.keyset.vkVersion },
      plain,
    );
    const ex = this.#recs.get(id);
    this.#recs.set(id, {
      id,
      deleted: false,
      rev: ex?.rev ?? 0,
      vkVersion: file.keyset.vkVersion,
      nonce: enc.nonce,
      ct: enc.ct,
      dirty: true,
      baseRev: ex ? (ex.dirty ? ex.baseRev : ex.rev) : 0,
    });
    s.plains.set(id, plain);
  }

  #putTombstone(id: string): void {
    const s = this.#sess();
    const ex = this.#recs.get(id);
    s.plains.delete(id);
    if (!ex) return;
    if (ex.rev === 0 && ex.baseRev === 0) {
      this.#recs.delete(id); // never reached the server
      return;
    }
    const { file } = this.#acct();
    this.#recs.set(id, {
      id,
      deleted: true,
      rev: ex.rev,
      vkVersion: file.keyset.vkVersion,
      nonce: null,
      ct: null,
      dirty: true,
      baseRev: ex.dirty ? ex.baseRev : ex.rev,
    });
  }

  async #save(): Promise<void> {
    await this.#persistFile();
    this.#emit('onVaultChanged', {});
    this.#emit('onSyncNeeded', {});
  }

  async #auth(reason: string): Promise<AuthToken> {
    return this.d.biometric.authenticate(reason);
  }

  async #signing(): Promise<{ priv: Uint8Array; deviceId: string }> {
    const { local } = this.#acct();
    const priv = await this.d.keystore.read('sign.key');
    if (!priv) throw new VaultCoreError('E_NOT_FOUND', 'device key missing');
    return { priv, deviceId: local.deviceId };
  }

  /** Builds a request with the `X-LV-Admin` header (§8.7). The body is signed as JSON.stringify(body). */
  async #adminRequest(
    method: ServerRequest['method'],
    path: string,
    body?: unknown,
    opts: { auth?: AuthToken; headers?: Record<string, string> } = {},
  ): Promise<ServerRequest> {
    const { local } = this.#acct();
    const token = opts.auth ?? (await this.#auth('管理操作'));
    const priv = await this.d.keystore.read('admin.key', token);
    if (!priv) throw new VaultCoreError('E_NOT_FOUND', 'admin key missing');
    const header = await buildAdminHeader(this.d.crypto, priv, {
      method,
      path,
      body: body === undefined ? undefined : utf8Encode(JSON.stringify(body)),
      deviceId: local.deviceId,
      nowSec: Math.floor(this.#now().getTime() / 1000),
    });
    const req: ServerRequest = { method, path, headers: { 'X-LV-Admin': header, ...opts.headers } };
    if (body !== undefined) req.body = body;
    return req;
  }

  // ---- throttle (FR-12, G15) ----
  async #readThrottle(): Promise<{ failedCount: number; lastFailureAtMs: number | null }> {
    const raw = await this.d.keystore.read('throttle');
    if (!raw) return { failedCount: 0, lastFailureAtMs: null };
    try {
      return JSON.parse(utf8Decode(raw));
    } catch {
      return { failedCount: 0, lastFailureAtMs: null };
    }
  }
  async #writeThrottle(v: { failedCount: number; lastFailureAtMs: number | null }): Promise<void> {
    await this.d.keystore.write('throttle', utf8Encode(JSON.stringify(v)));
  }
  async getThrottleState(): Promise<{ failedCount: number; retryAfterSec: number }> {
    const t = await this.#readThrottle();
    return throttleState({ ...t, nowMs: this.#now().getTime() });
  }

  /** Derives the master keys and unwraps the VK of `keyset`; null when the password is wrong. */
  async #tryUnwrap(
    password: string,
    keyset: Keyset,
  ): Promise<{ vk: Uint8Array; authKey: Uint8Array; sk: Uint8Array } | null> {
    const { file } = this.#acct();
    const sk = await this.d.keystore.read('sk');
    if (!sk) throw new VaultCoreError('E_CORRUPTED', 'recovery key missing on this device');
    const keys = await deriveMasterKeys(this.d.crypto, {
      masterPassword: password,
      kdf: keyset.kdf,
      recoveryKey: sk,
      accountId: file.accountId,
    });
    try {
      const vk = await unwrapVaultKey(
        this.d.crypto,
        keys.kek,
        keyset.wrappedVK,
        file.accountId,
        keyset.keysetVersion,
      );
      return { vk, authKey: keys.authKey, sk };
    } catch (e) {
      if (e instanceof CryptoError) return null;
      throw e;
    } finally {
      wipe(keys.kek);
    }
  }

  /** Counted and throttled master-password check shared by every password-taking method. */
  async #verifyPassword(password: string, keyset?: Keyset) {
    const { file } = this.#acct();
    const t = await this.getThrottleState();
    if (t.retryAfterSec > 0)
      throw new VaultCoreError('E_THROTTLED', 'too many attempts', {
        retryAfterSec: t.retryAfterSec,
      });
    const r = await this.#tryUnwrap(password, keyset ?? file.keyset);
    if (r) {
      if (t.failedCount > 0) await this.#writeThrottle({ failedCount: 0, lastFailureAtMs: null });
      return r;
    }
    const failedCount = t.failedCount + 1;
    const nowMs = this.#now().getTime();
    await this.#writeThrottle({ failedCount, lastFailureAtMs: nowMs });
    const after = throttleState({ failedCount, lastFailureAtMs: nowMs, nowMs });
    throw new VaultCoreError('E_WRONG_PASSWORD', 'wrong master password', {
      attemptsLeft: attemptsBeforeThrottle(failedCount),
      retryAfterSec: after.retryAfterSec,
    });
  }

  // ---- opening a session ----
  async #decryptAll(file: VaultFile, vk: Uint8Array): Promise<Map<string, RecordPlain>> {
    const out = new Map<string, RecordPlain>();
    for (const r of file.records) {
      if (r.deleted) continue;
      out.set(
        r.id,
        await decryptRecord(
          this.d.crypto,
          vk,
          { accountId: file.accountId, recordId: r.id, vkVersion: r.vkVersion },
          { nonce: r.nonce, ct: r.ct },
        ),
      );
    }
    return out;
  }

  async #loadUsage(vk: Uint8Array): Promise<Session['usage']> {
    const { file } = this.#acct();
    const raw = await this.d.storage.read('usage.lv');
    if (!raw || raw.length < 29) return {};
    try {
      const pt = await this.d.crypto.aesGcmDecrypt(
        vk,
        raw.slice(0, 12),
        raw.slice(12),
        utf8Encode(`lv|v2|usage|${file.accountId}`),
      );
      return JSON.parse(utf8Decode(pt));
    } catch {
      return {};
    }
  }
  async #saveUsage(): Promise<void> {
    const { file } = this.#acct();
    const s = this.#sess();
    const nonce = await this.d.crypto.randomBytes(12);
    const ct = await this.d.crypto.aesGcmEncrypt(
      s.vk,
      nonce,
      utf8Encode(JSON.stringify(s.usage)),
      utf8Encode(`lv|v2|usage|${file.accountId}`),
    );
    const out = new Uint8Array(12 + ct.length);
    out.set(nonce, 0);
    out.set(ct, 12);
    const st = this.d.storage;
    await st.write('usage.lv.tmp', out);
    if (await st.exists('usage.lv')) await st.rename('usage.lv', 'usage.lv.bak');
    await st.rename('usage.lv.tmp', 'usage.lv');
  }

  /** Decrypts everything; on damage falls back to the .bak generation, else E_CORRUPTED (AC-12). */
  async #open(vk: Uint8Array): Promise<void> {
    const { file } = this.#acct();
    let plains: Map<string, RecordPlain>;
    try {
      plains = await this.#decryptAll(file, vk);
    } catch (e) {
      if (!(e instanceof CryptoError) && !(e instanceof VaultCoreError)) throw e;
      let cand: VaultFile | undefined;
      try {
        const raw = await this.d.storage.read('vault.lv.bak');
        const p = raw ? vaultFileSchema.safeParse(JSON.parse(utf8Decode(raw))) : null;
        if (p?.success && p.data.accountId === file.accountId) cand = p.data;
      } catch {
        cand = undefined;
      }
      if (!cand) throw new VaultCoreError('E_CORRUPTED', 'vault file is damaged');
      try {
        plains = await this.#decryptAll(cand, vk);
      } catch {
        throw new VaultCoreError('E_CORRUPTED', 'vault file and its backup are damaged');
      }
      this.#file = cand;
      this.#recs = new Map(cand.records.map((r) => [r.id, r]));
      this.#recovered = true;
      await this.#persistFile();
    }
    this.#session = { vk, plains, usage: {} };
    this.#session.usage = await this.#loadUsage(vk);
    await this.#emitLockState();
    await this.purgeExpiredTrash();
  }

  // ================================================================ state and unlocking

  async getLockState(): Promise<LockState> {
    await this.#ensureLoaded();
    if (this.#pendingAccount && !this.#file) return 'uninitialized';
    if (!this.#file && !this.#fatalCorrupt) return 'uninitialized';
    return this.#session ? 'unlocked' : 'locked';
  }

  async getBiometricAvailability() {
    return this.d.biometric.availability();
  }

  async enableBiometrics(): Promise<void> {
    const { local } = this.#acct();
    const s = this.#sess();
    const a = await this.d.biometric.availability();
    if (!a.available) throw new VaultCoreError('E_BIOMETRY_UNAVAILABLE');
    await this.#auth('生体認証を有効にする');
    await this.d.keystore.write('vk.bio', s.vk);
    local.biometricsEnabled = true;
    await this.#persistLocal();
  }

  async disableBiometrics(): Promise<void> {
    const { local } = this.#acct();
    await this.d.keystore.delete('vk.bio');
    local.biometricsEnabled = false;
    await this.#persistLocal();
  }

  async unlockWithBiometrics(): Promise<void> {
    await this.#ensureLoaded();
    const { local } = this.#acct();
    if (this.#fatalCorrupt) throw new VaultCoreError('E_CORRUPTED');
    if (!local.biometricsEnabled) throw new VaultCoreError('E_BIOMETRY_UNAVAILABLE');
    const token = await this.#auth('ロックを解除');
    const vk = await this.d.keystore.read('vk.bio', token);
    if (!vk) throw new VaultCoreError('E_BIOMETRY_INVALIDATED');
    await this.#open(vk);
  }

  async unlockWithPassword(masterPassword: string): Promise<void> {
    await this.#ensureLoaded();
    if (this.#fatalCorrupt) throw new VaultCoreError('E_CORRUPTED');
    const { file, local } = this.#acct();
    if (local.pendingRotation) {
      const next = await this.#verifyPassword(masterPassword, local.pendingRotation);
      let oldVk: Uint8Array | null = this.#session?.vk ?? null;
      if (!oldVk) oldVk = (await this.#tryUnwrap(masterPassword, file.keyset))?.vk ?? null;
      await this.#applyRotation(next.vk, oldVk, local.pendingRotation);
      return;
    }
    const r = await this.#verifyPassword(masterPassword);
    if (this.#session) {
      this.#session.vk = r.vk;
      await this.#emitLockState();
      return;
    }
    await this.#open(r.vk);
  }

  /** Another device rotated the VK: re-key local edits, drop stale clean copies, refetch (§7.7). */
  async #applyRotation(newVk: Uint8Array, oldVk: Uint8Array | null, ks: Keyset): Promise<void> {
    const { file, local } = this.#acct();
    let dropped = 0;
    const kept = new Map<string, VaultFileRecord>();
    for (const r of this.#recs.values()) {
      if (!r.dirty) continue;
      if (r.deleted) {
        kept.set(r.id, { ...r, vkVersion: ks.vkVersion });
        continue;
      }
      if (!oldVk) {
        dropped++;
        continue;
      }
      const plain = await decryptRecord(
        this.d.crypto,
        oldVk,
        { accountId: file.accountId, recordId: r.id, vkVersion: r.vkVersion },
        { nonce: r.nonce, ct: r.ct },
      );
      const enc = await encryptRecord(
        this.d.crypto,
        newVk,
        { accountId: file.accountId, recordId: r.id, vkVersion: ks.vkVersion },
        plain,
      );
      kept.set(r.id, { ...r, vkVersion: ks.vkVersion, nonce: enc.nonce, ct: enc.ct });
    }
    if (dropped > 0) this.#notify({ kind: 'dropped-local-edits', count: dropped });
    this.#recs = kept;
    file.keyset = ks;
    file.sync.cursor = 0;
    local.pendingRotation = null;
    this.#session = null;
    await this.#persistFile();
    if (local.biometricsEnabled) await this.d.keystore.write('vk.bio', newVk);
    await this.#persistLocal();
    await this.#open(newVk);
    this.#emit('onVaultChanged', {});
    this.#emit('onSyncNeeded', {});
  }

  async lock(): Promise<void> {
    if (this.#session) {
      wipe(this.#session.vk);
      this.#session = null;
    }
    await this.#emitLockState();
  }

  async onBackground(): Promise<void> {
    this.#backgroundedAt = this.#now().getTime();
  }
  async onForeground(): Promise<void> {
    const at = this.#backgroundedAt;
    this.#backgroundedAt = null;
    if (!this.#session || !this.#local || at === null) return;
    if (this.#now().getTime() - at >= this.#local.autoLockSec * 1000) await this.lock();
  }

  async drainNotices(): Promise<VaultNotice[]> {
    const n = this.#notices;
    this.#notices = [];
    return n;
  }

  /** Queues a notice for `drainNotices` and emits `onNotice`. */
  #notify(notice: VaultNotice): void {
    this.#notices.push(notice);
    this.#emit('onNotice', { notice });
  }

  async getStorageStatus() {
    await this.#ensureLoaded();
    return { recoveredFromBackup: this.#recovered, corrupted: this.#fatalCorrupt };
  }

  async markRevoked(): Promise<void> {
    const { local } = this.#acct();
    local.revoked = true;
    await this.#persistLocal();
    await this.lock();
  }
  async isRotationPending(): Promise<boolean> {
    await this.#ensureLoaded();
    return this.#local?.pendingRotation != null;
  }

  // ================================================================ account

  async createAccount(p: {
    serverUrl: string;
    accountName: string;
    masterPassword: string;
    inviteCode: string;
  }): Promise<{ request: ServerRequest; recoveryKey: string }> {
    await this.#ensureLoaded();
    if (this.#file) throw new VaultCoreError('E_INVALID_INPUT', 'an account already exists');
    const name = normalizeAccountName(p.accountName);
    if (!name.ok) throw new VaultCoreError('E_INVALID_INPUT', 'invalid account name');
    if (p.masterPassword.length < FIELD.masterPasswordMin)
      throw new VaultCoreError('E_INVALID_INPUT', 'master password too short');
    const url = this.#serverUrl(p.serverUrl);
    const c = this.d.crypto;
    const accountId = await this.#newId();
    const deviceId = await this.#newId();
    const sk = await generateRecoveryKeyBytes(c);
    const bundle = await createKeyset(c, {
      masterPassword: p.masterPassword,
      recoveryKey: sk,
      accountId,
    });
    const sign = await c.generateKeyPair();
    const admin = await c.generateKeyPair();
    const now = this.#nowIso();
    const name0 = this.d.deviceName ?? (this.d.platform === 'ios' ? 'iPhone' : 'Android');
    const meta: RecordPlain = {
      kind: 'meta',
      data: {
        recoveryKey: await formatRecoveryKey(c, sk),
        pcSessionMaxSec: 3600,
        createdAt: now,
      },
      updatedAt: now,
      updatedBy: deviceId,
    };
    const device: RecordPlain = {
      kind: 'device',
      data: {
        deviceId,
        name: name0,
        type: 'mobile',
        platform: this.d.platform,
        signPub: b64(sign.publicKey),
        adminPub: b64(admin.publicKey),
        addedAt: now,
        addedBy: deviceId,
        addedVia: 'setup',
        revokedAt: null,
      },
      updatedAt: now,
      updatedBy: deviceId,
    };
    const records: VaultFileRecord[] = [];
    for (const [id, plain] of [
      [META_RECORD_ID, meta],
      [deviceId, device],
    ] as const) {
      const enc = await encryptRecord(
        c,
        bundle.vk,
        { accountId, recordId: id, vkVersion: 1 },
        plain,
      );
      records.push({
        id,
        rev: 0,
        deleted: false,
        vkVersion: 1,
        nonce: enc.nonce,
        ct: enc.ct,
        dirty: true,
        baseRev: 0,
      });
    }
    const file: VaultFile = {
      format: 'localvault',
      version: 2,
      accountId,
      accountName: name.name,
      serverUrl: url,
      keyset: bundle.keyset,
      records,
      sync: { cursor: 0, maxSeenRev: 0, lastSyncedAt: null },
    };
    this.#pendingAccount = {
      file,
      local: this.#newLocal(deviceId, name0, b64(sign.publicKey), b64(admin.publicKey)),
      vk: bundle.vk,
      sk,
      signPriv: sign.privateKey,
      adminPriv: admin.privateKey,
    };
    const request: ServerRequest = {
      method: 'POST',
      path: '/v1/accounts',
      body: {
        inviteCode: p.inviteCode,
        accountId,
        accountName: name.name,
        keyset: bundle.keyset,
        verifier: bundle.verifier,
        device: {
          deviceId,
          type: 'mobile',
          platform: this.d.platform,
          signPub: b64(sign.publicKey),
          adminPub: b64(admin.publicKey),
        },
      },
    };
    wipe(bundle.authKey, bundle.kek);
    return { request, recoveryKey: (meta.data as MetaData).recoveryKey };
  }

  #serverUrl(url: string): string {
    const r = parseServerUrl(url, {
      allowInsecureLocalhost: this.d.allowInsecureLocalhost === true,
    });
    if (!r.ok) throw new VaultCoreError('E_INVALID_INPUT', `invalid server url (${r.reason})`);
    return r.origin;
  }

  #newLocal(deviceId: string, deviceName: string, signPub: string, adminPub: string): LocalState {
    return {
      v: 1,
      deviceId,
      deviceName,
      signPub,
      adminPub,
      biometricsEnabled: false,
      autoLockSec: 60,
      clipboardClearSec: 60,
      showUsernameBeforeAuth: true,
      pcSessionMaxSec: 3600,
      lastExportAt: null,
      seenNonces: {},
      pendingRotation: null,
      rollbackDetected: false,
      allowDowngrade: false,
      revoked: false,
    };
  }

  /** Installs a brand-new account state and opens the session. */
  async #install(a: {
    file: VaultFile;
    local: LocalState;
    vk: Uint8Array;
    sk: Uint8Array | null;
    signPriv: Uint8Array;
    adminPriv: Uint8Array;
  }): Promise<void> {
    this.#file = a.file;
    this.#local = a.local;
    this.#recs = new Map(a.file.records.map((r) => [r.id, r]));
    this.#fatalCorrupt = false;
    this.#recovered = false;
    if (a.sk) await this.d.keystore.write('sk', a.sk);
    await this.d.keystore.write('sign.key', a.signPriv);
    await this.d.keystore.write('admin.key', a.adminPriv);
    await this.#persistFile();
    await this.#persistLocal();
    this.#session = { vk: a.vk, plains: new Map(), usage: {} };
    this.#session.plains = await this.#decryptAll(a.file, a.vk);
    await this.#emitLockState();
  }

  async commitAccount(): Promise<void> {
    const p = this.#pendingAccount;
    if (!p) throw new VaultCoreError('E_NOT_FOUND', 'no pending account');
    this.#pendingAccount = null;
    await this.#install({ ...p });
  }

  async discardPendingAccount(): Promise<void> {
    if (this.#pendingAccount) wipe(this.#pendingAccount.vk, this.#pendingAccount.sk);
    this.#pendingAccount = null;
  }

  async deriveAuthKey(p: {
    accountId: string;
    kdf: Kdf;
    masterPassword: string;
    recoveryKey: string;
  }): Promise<string> {
    const sk = await parseRecoveryKey(this.d.crypto, p.recoveryKey);
    const keys = await deriveMasterKeys(this.d.crypto, {
      masterPassword: p.masterPassword,
      kdf: p.kdf,
      recoveryKey: sk,
      accountId: p.accountId,
    });
    this.#restoreAccountId = p.accountId;
    wipe(keys.kek, sk);
    return b64(keys.authKey);
  }
  #restoreAccountId: string | null = null;

  async buildRecoverRequest(p: { accountName: string; authKey: string }): Promise<ServerRequest> {
    const accountId = this.#restoreAccountId;
    if (!accountId) throw new VaultCoreError('E_INVALID_INPUT', 'call deriveAuthKey first');
    const c = this.d.crypto;
    const sign = await c.generateKeyPair();
    const admin = await c.generateKeyPair();
    const deviceId = await this.#newId();
    this.#pendingRestore = {
      accountId,
      deviceId,
      signPriv: sign.privateKey,
      adminPriv: admin.privateKey,
      signPub: b64(sign.publicKey),
      adminPub: b64(admin.publicKey),
    };
    return {
      method: 'POST',
      path: '/v1/auth/recover',
      body: {
        accountId,
        authKey: p.authKey,
        device: {
          deviceId,
          type: 'mobile',
          platform: this.d.platform,
          signPub: b64(sign.publicKey),
          adminPub: b64(admin.publicKey),
        },
      },
    };
  }

  async restoreAccount(p: {
    serverUrl: string;
    accountName: string;
    accountId: string;
    keyset: Keyset;
    masterPassword: string;
    recoveryKey: string;
  }): Promise<void> {
    const r = this.#pendingRestore;
    if (!r || r.accountId !== p.accountId)
      throw new VaultCoreError('E_INVALID_INPUT', 'no recover request in progress');
    const sk = await parseRecoveryKey(this.d.crypto, p.recoveryKey);
    const ks = keysetSchema.safeParse(p.keyset);
    if (!ks.success) throw new VaultCoreError('E_INVALID_INPUT', 'bad keyset');
    const keys = await deriveMasterKeys(this.d.crypto, {
      masterPassword: p.masterPassword,
      kdf: ks.data.kdf,
      recoveryKey: sk,
      accountId: p.accountId,
    });
    let vk: Uint8Array;
    try {
      vk = await unwrapVaultKey(
        this.d.crypto,
        keys.kek,
        ks.data.wrappedVK,
        p.accountId,
        ks.data.keysetVersion,
      );
    } catch (e) {
      if (e instanceof CryptoError) throw new VaultCoreError('E_WRONG_CREDENTIALS');
      throw e;
    }
    const name = normalizeAccountName(p.accountName);
    if (!name.ok) throw new VaultCoreError('E_INVALID_INPUT', 'invalid account name');
    const now = this.#nowIso();
    const deviceName = this.d.deviceName ?? (this.d.platform === 'ios' ? 'iPhone' : 'Android');
    const file: VaultFile = {
      format: 'localvault',
      version: 2,
      accountId: p.accountId,
      accountName: name.name,
      serverUrl: this.#serverUrl(p.serverUrl),
      keyset: ks.data,
      records: [],
      sync: { cursor: 0, maxSeenRev: 0, lastSyncedAt: null },
    };
    const local = this.#newLocal(r.deviceId, deviceName, r.signPub, r.adminPub);
    const device: RecordPlain = {
      kind: 'device',
      data: {
        deviceId: r.deviceId,
        name: deviceName,
        type: 'mobile',
        platform: this.d.platform,
        signPub: r.signPub,
        adminPub: r.adminPub,
        addedAt: now,
        addedBy: r.deviceId,
        addedVia: 'recovery-key',
        revokedAt: null,
      },
      updatedAt: now,
      updatedBy: r.deviceId,
    };
    const enc = await encryptRecord(
      this.d.crypto,
      vk,
      { accountId: p.accountId, recordId: r.deviceId, vkVersion: ks.data.vkVersion },
      device,
    );
    file.records.push({
      id: r.deviceId,
      rev: 0,
      deleted: false,
      vkVersion: ks.data.vkVersion,
      nonce: enc.nonce,
      ct: enc.ct,
      dirty: true,
      baseRev: 0,
    });
    this.#pendingRestore = null;
    this.#restoreAccountId = null;
    await this.#install({ file, local, vk, sk, signPriv: r.signPriv, adminPriv: r.adminPriv });
    wipe(keys.kek, keys.authKey);
  }

  async signAuthChallenge(challenge: string): Promise<{ deviceId: string; sig: string }> {
    await this.#ensureLoaded();
    const { priv, deviceId } = await this.#signing();
    return { deviceId, sig: await coreSignAuthChallenge(this.d.crypto, priv, deviceId, challenge) };
  }

  async getRecoveryKey(): Promise<string> {
    this.#sess();
    await this.#auth('リカバリーキーを表示');
    const sk = await this.d.keystore.read('sk');
    if (!sk) throw new VaultCoreError('E_NOT_FOUND');
    return formatRecoveryKey(this.d.crypto, sk);
  }

  async changeMasterPassword(current: string, next: string): Promise<ServerRequest> {
    const { file } = this.#unlocked();
    if (next.length < FIELD.masterPasswordMin)
      throw new VaultCoreError('E_INVALID_INPUT', 'master password too short');
    const r = await this.#verifyPassword(current);
    return this.#stageKeyset(file, next, r.sk, r.vk, null);
  }

  async resetMasterPassword(recoveryKey: string, next: string): Promise<ServerRequest> {
    const { file } = this.#unlocked();
    if (next.length < FIELD.masterPasswordMin)
      throw new VaultCoreError('E_INVALID_INPUT', 'master password too short');
    const sk = await parseRecoveryKey(this.d.crypto, recoveryKey);
    const stored = await this.d.keystore.read('sk');
    const metaKey = this.#meta()?.data.recoveryKey;
    const ok =
      (stored !== null && eqBytes(stored, sk)) ||
      (metaKey !== undefined && metaKey === (await formatRecoveryKey(this.d.crypto, sk)));
    if (!ok) throw new VaultCoreError('E_INVALID_RECOVERY_KEY', 'recovery key does not match');
    return this.#stageKeyset(file, next, sk, this.#sess().vk, null);
  }

  async regenerateRecoveryKey(
    masterPassword: string,
  ): Promise<{ request: ServerRequest; recoveryKey: string }> {
    const { file } = this.#unlocked();
    const r = await this.#verifyPassword(masterPassword);
    const newSk = await generateRecoveryKeyBytes(this.d.crypto);
    const request = await this.#stageKeyset(file, masterPassword, newSk, r.vk, newSk);
    return { request, recoveryKey: await formatRecoveryKey(this.d.crypto, newSk) };
  }

  async #stageKeyset(
    file: VaultFile,
    password: string,
    sk: Uint8Array,
    vk: Uint8Array,
    newSk: Uint8Array | null,
  ): Promise<ServerRequest> {
    const b = await rewrapKeyset(this.d.crypto, {
      masterPassword: password,
      recoveryKey: sk,
      accountId: file.accountId,
      vk,
      previous: file.keyset,
    });
    this.#staged = { kind: 'keyset', keyset: b.keyset, newSk };
    wipe(b.authKey, b.kek);
    return this.#adminRequest('PUT', '/v1/keyset', { keyset: b.keyset, verifier: b.verifier });
  }

  async confirmKeysetAccepted(): Promise<void> {
    const st = this.#staged;
    if (st?.kind !== 'keyset') throw new VaultCoreError('E_NOT_FOUND', 'no pending keyset');
    const { file } = this.#acct();
    this.#staged = null;
    file.keyset = st.keyset;
    if (st.newSk) {
      await this.d.keystore.write('sk', st.newSk);
      const m = this.#meta();
      if (m) {
        await this.#putLocal(META_RECORD_ID, {
          ...m,
          data: { ...m.data, recoveryKey: await formatRecoveryKey(this.d.crypto, st.newSk) },
          updatedAt: this.#nowIso(),
          updatedBy: this.#local?.deviceId ?? m.updatedBy,
        });
      }
    }
    await this.#save();
  }

  async reregisterAdminKey(masterPassword: string): Promise<ServerRequest> {
    const { local } = this.#acct();
    const r = await this.#verifyPassword(masterPassword);
    const admin = await this.d.crypto.generateKeyPair();
    await this.d.keystore.write('admin.key', admin.privateKey);
    local.adminPub = b64(admin.publicKey);
    await this.#persistLocal();
    if (this.#session) {
      const dev = this.#session.plains.get(local.deviceId);
      if (dev?.kind === 'device') {
        await this.#putLocal(local.deviceId, {
          ...dev,
          data: { ...dev.data, adminPub: local.adminPub },
          updatedAt: this.#nowIso(),
          updatedBy: local.deviceId,
        });
        await this.#save();
      }
    }
    return {
      method: 'PUT',
      path: '/v1/devices/self/admin-key',
      body: { adminPub: local.adminPub },
      headers: { 'X-LV-AuthKey': b64(r.authKey) },
    };
  }

  async buildDeleteAccount(masterPassword: string): Promise<ServerRequest> {
    const r = await this.#verifyPassword(masterPassword);
    return this.#adminRequest('DELETE', '/v1/account', undefined, {
      headers: { 'X-LV-AuthKey': b64(r.authKey) },
    });
  }

  async wipeLocal(): Promise<void> {
    await this.#ensureLoaded();
    if (this.#session) wipe(this.#session.vk);
    this.#session = null;
    for (const n of ['vault.lv', 'local.json', 'usage.lv']) await removeAll(this.d.storage, n);
    for (const s of [
      'vk.bio',
      'sk',
      'sign.key',
      'admin.key',
      'claim',
      'throttle',
      'usage.key',
    ] as const)
      await this.d.keystore.delete(s);
    this.#file = null;
    this.#local = null;
    this.#recs = new Map();
    this.#staged = null;
    this.#pendingAccount = null;
    this.#pendingRestore = null;
    this.#fatalCorrupt = false;
    this.#notices = [];
    await this.#emitLockState();
  }

  async getAccountInfo(): Promise<AccountInfo> {
    await this.#ensureLoaded();
    const { file, local } = this.#acct();
    return {
      accountId: file.accountId,
      accountName: file.accountName,
      serverUrl: file.serverUrl,
      deviceId: local.deviceId,
    };
  }

  async changeServerUrl(newUrl: string): Promise<void> {
    const { file } = this.#acct();
    file.serverUrl = this.#serverUrl(newUrl);
    await this.#persistFile();
  }

  async buildSignOutDevice(): Promise<ServerRequest[]> {
    const { local } = this.#unlocked();
    const token = await this.#auth('この端末からサインアウト');
    await this.#markDeviceRevoked(local.deviceId);
    await this.#save();
    const out: ServerRequest[] = [];
    const batch = this.#batchRequest(100);
    if (batch) out.push(batch);
    out.push(
      await this.#adminRequest('DELETE', `/v1/devices/${local.deviceId}`, undefined, {
        auth: token,
      }),
    );
    return out;
  }

  async isLastApprover(): Promise<boolean> {
    this.#unlocked();
    return this.#devices().filter((d) => d.type === 'mobile' && d.revokedAt === null).length <= 1;
  }

  async #markDeviceRevoked(deviceId: string): Promise<void> {
    const dev = this.#sess().plains.get(deviceId);
    if (dev?.kind !== 'device') throw new VaultCoreError('E_NOT_FOUND', 'unknown device');
    if (dev.data.revokedAt !== null) return;
    const { local } = this.#acct();
    await this.#putLocal(deviceId, {
      ...dev,
      data: { ...dev.data, revokedAt: this.#nowIso() },
      updatedAt: this.#nowIso(),
      updatedBy: local.deviceId,
    });
  }

  #batchRequest(limit: number): ServerRequest | null {
    const changes = this.#collectPending(limit);
    if (changes.length === 0) return null;
    return { method: 'POST', path: '/v1/records/batch', body: { changes } };
  }

  // ================================================================ items

  #summary(id: string, p: Extract<RecordPlain, { kind: 'login' }>): ItemSummary {
    const hosts: string[] = [];
    for (const u of p.data.urls) {
      const h = hostOfStoredUrl(u.url);
      if (h !== null && !hosts.includes(h)) hosts.push(h);
    }
    return {
      id,
      title: p.data.title,
      username: p.data.username,
      hosts,
      favorite: p.data.favorite,
      updatedAt: p.updatedAt,
      lastUsedAt: this.#sess().usage[id]?.lastUsedAt ?? null,
      isConflictCopy: p.data.conflictOf !== null,
      trashedAt: p.data.trashedAt,
    };
  }

  async listItems(opts?: { includeTrashed?: boolean }): Promise<ItemSummary[]> {
    const s = this.#sess();
    const out: ItemSummary[] = [];
    for (const [id, p] of s.plains) {
      if (p.kind !== 'login') continue;
      if (p.data.trashedAt !== null && opts?.includeTrashed !== true) continue;
      out.push(this.#summary(id, p));
    }
    return out;
  }

  async searchItems(query: string): Promise<ItemSummary[]> {
    return (await this.listItems()).filter((i) =>
      matchesQuery(query, [i.title, i.username, ...i.hosts]),
    );
  }

  async getItem(id: string): Promise<ItemDetail> {
    const p = this.#loginOf(id);
    return {
      ...this.#summary(id, p),
      urls: p.data.urls,
      androidApps: p.data.androidApps,
      notes: p.data.notes,
      createdAt: p.data.createdAt,
      conflictOf: p.data.conflictOf,
      hasPassword: p.data.password !== '',
    };
  }

  async revealPassword(id: string): Promise<string> {
    return this.#loginOf(id).data.password;
  }

  async saveItem(input: ItemInput): Promise<ItemDetail> {
    const { local } = this.#unlocked();
    const now = this.#nowIso();
    const ex = input.id === undefined ? undefined : this.#loginOf(input.id);
    const id = input.id ?? (await this.#newId());
    let history = ex ? (ex.data.passwordHistory ?? []) : [];
    const password = input.password ?? ex?.data.password ?? '';
    if (ex && input.password !== undefined && input.password !== ex.data.password) {
      if (ex.data.password !== '')
        history = [{ password: ex.data.password, changedAt: now }, ...history].slice(
          0,
          FIELD.passwordHistoryMax,
        );
    }
    const data: LoginData = {
      title: input.title,
      username: input.username,
      password,
      urls: input.urls,
      androidApps: ex?.data.androidApps ?? [],
      notes: input.notes,
      favorite: input.favorite,
      createdAt: ex?.data.createdAt ?? now,
      trashedAt: ex?.data.trashedAt ?? null,
      conflictOf: ex?.data.conflictOf ?? null,
      passwordHistory: history,
    };
    await this.#putLocal(id, { kind: 'login', data, updatedAt: now, updatedBy: local.deviceId });
    await this.#save();
    return this.getItem(id);
  }

  async #editLogin(id: string, f: (d: LoginData) => LoginData): Promise<void> {
    const { local } = this.#unlocked();
    const p = this.#loginOf(id);
    await this.#putLocal(id, {
      kind: 'login',
      data: f(p.data),
      updatedAt: this.#nowIso(),
      updatedBy: local.deviceId,
    });
    await this.#save();
  }

  async trashItem(id: string): Promise<void> {
    await this.#editLogin(id, (d) => ({ ...d, trashedAt: this.#nowIso() }));
  }
  async restoreItem(id: string): Promise<void> {
    await this.#editLogin(id, (d) => ({ ...d, trashedAt: null }));
  }
  async purgeItem(id: string): Promise<void> {
    this.#loginOf(id);
    this.#putTombstone(id);
    await this.#save();
  }

  async purgeExpiredTrash(): Promise<number> {
    if (!this.#session) return 0;
    const cutoff = this.#now().getTime() - TRASH_MS;
    let n = 0;
    for (const [id, p] of [...this.#session.plains]) {
      if (
        p.kind === 'login' &&
        p.data.trashedAt !== null &&
        Date.parse(p.data.trashedAt) <= cutoff
      ) {
        this.#putTombstone(id);
        n++;
      }
    }
    if (n > 0) await this.#save();
    return n;
  }

  async resolveConflict(copyId: string, keep: 'copy' | 'original'): Promise<void> {
    const copy = this.#loginOf(copyId);
    const originalId = copy.data.conflictOf;
    if (originalId === null) throw new VaultCoreError('E_INVALID_INPUT', 'not a conflict copy');
    if (keep === 'original') {
      await this.#editLogin(copyId, (d) => ({ ...d, trashedAt: this.#nowIso() }));
      return;
    }
    // Keep the copy: it becomes a normal item and the original goes to the trash.
    const orig = this.#sess().plains.get(originalId);
    await this.#editLogin(copyId, (d) => ({ ...d, conflictOf: null }));
    if (orig?.kind === 'login')
      await this.#editLogin(originalId, (d) => ({ ...d, trashedAt: this.#nowIso() }));
  }

  async unlinkAndroidApp(id: string, packageName: string): Promise<void> {
    await this.#editLogin(id, (d) => ({
      ...d,
      androidApps: d.androidApps.filter((a) => a.packageName !== packageName),
    }));
  }

  async getPasswordHistory(id: string): Promise<{ index: number; changedAt: string }[]> {
    return (this.#loginOf(id).data.passwordHistory ?? []).map((h, index) => ({
      index,
      changedAt: h.changedAt,
    }));
  }
  #historic(id: string, index: number): string {
    const h = (this.#loginOf(id).data.passwordHistory ?? [])[index];
    if (!h) throw new VaultCoreError('E_NOT_FOUND', 'no such history entry');
    return h.password;
  }
  async revealHistoricPassword(id: string, index: number): Promise<string> {
    return this.#historic(id, index);
  }
  async copyHistoricPassword(id: string, index: number): Promise<{ clearsAt: string | null }> {
    return this.#toClipboard(this.#historic(id, index));
  }
  async clearPasswordHistory(id: string): Promise<void> {
    await this.#editLogin(id, (d) => ({ ...d, passwordHistory: [] }));
  }

  async #toClipboard(text: string): Promise<{ clearsAt: string | null }> {
    const { local } = this.#acct();
    const ttl = local.clipboardClearSec;
    await this.d.clipboard.setSensitive(text, ttl);
    return {
      clearsAt: ttl === null ? null : new Date(this.#now().getTime() + ttl * 1000).toISOString(),
    };
  }

  async copy(id: string, field: CopyField): Promise<{ clearsAt: string | null }> {
    const p = this.#loginOf(id);
    const r = await this.#toClipboard(field === 'password' ? p.data.password : p.data.username);
    const u = this.#sess().usage[id];
    this.#sess().usage[id] = { lastUsedAt: this.#nowIso(), count: (u?.count ?? 0) + 1 };
    await this.#saveUsage();
    return r;
  }

  async generatePassword(options: Parameters<VaultCore['generatePassword']>[0]): Promise<string> {
    return generatePassword(this.d.crypto, options);
  }

  // ================================================================ sync

  #collectPending(limit: number): RecordChange[] {
    const { file } = this.#acct();
    const out: RecordChange[] = [];
    for (const r of this.#recs.values()) {
      if (!r.dirty) continue;
      if (out.length >= limit) break;
      this.#inflight.set(r.id, r.nonce ?? 'tombstone');
      out.push(
        r.deleted
          ? {
              id: r.id,
              baseRev: r.baseRev,
              vkVersion: r.vkVersion,
              deleted: true,
              nonce: null,
              ct: null,
            }
          : {
              id: r.id,
              baseRev: r.baseRev,
              vkVersion: r.vkVersion,
              deleted: false,
              nonce: r.nonce as string,
              ct: r.ct as string,
            },
      );
    }
    void file;
    return out;
  }

  #syncGuard(): { file: VaultFile; local: LocalState } {
    const a = this.#acct();
    if (a.local.revoked) throw new VaultCoreError('E_DEVICE_REVOKED');
    if (a.local.rollbackDetected) throw new VaultCoreError('E_ROLLBACK_DETECTED');
    return a;
  }

  async getSyncState(): Promise<SyncState> {
    await this.#ensureLoaded();
    const { file } = this.#acct();
    return {
      cursor: file.sync.cursor,
      maxSeenRev: file.sync.maxSeenRev,
      lastSyncedAt: file.sync.lastSyncedAt,
      pendingCount: [...this.#recs.values()].filter((r) => r.dirty).length,
    };
  }

  async getPendingChanges(limit: number): Promise<RecordChange[]> {
    await this.#ensureLoaded();
    const { local } = this.#syncGuard();
    if (local.pendingRotation) return [];
    await this.purgeExpiredTrash();
    return this.#collectPending(limit);
  }

  async #rollback(): Promise<never> {
    const { local } = this.#acct();
    local.rollbackDetected = true;
    await this.#persistLocal();
    throw new VaultCoreError('E_ROLLBACK_DETECTED', 'server state went backwards');
  }

  #setServerRecord(rec: EncryptedRecord, plain: RecordPlain | null): void {
    this.#recs.set(rec.id, { ...rec, dirty: false, baseRev: rec.rev });
    if (plain) this.#sess().plains.set(rec.id, plain);
    else this.#sess().plains.delete(rec.id);
  }

  async #decryptServer(rec: EncryptedRecord): Promise<RecordPlain | null> {
    if (rec.deleted) return null;
    const { file } = this.#acct();
    try {
      return await decryptRecord(
        this.d.crypto,
        this.#sess().vk,
        { accountId: file.accountId, recordId: rec.id, vkVersion: rec.vkVersion },
        { nonce: rec.nonce, ct: rec.ct },
      );
    } catch (e) {
      if (e instanceof CryptoError || e instanceof VaultCoreError)
        throw new VaultCoreError('E_CORRUPTED', 'a record from the server failed authentication');
      throw e;
    }
  }

  /** Resolves one conflict between our dirty record and the server's (§7.4). Returns true if counted. */
  async #resolve(rec: EncryptedRecord, serverPlain: RecordPlain | null): Promise<boolean> {
    const { local } = this.#acct();
    const s = this.#sess();
    const mine = this.#recs.get(rec.id);
    const localPlain = mine && !mine.deleted ? (s.plains.get(rec.id) ?? null) : null;
    const newIds: string[] = [];
    for (let i = 0; i < 2; i++) newIds.push(await this.#newId());
    let n = 0;
    const out = resolveConflict({
      id: rec.id,
      local: localPlain,
      server: serverPlain,
      now: this.#now(),
      deviceId: local.deviceId,
      newId: () => newIds[n++] as string,
    });
    this.#setServerRecord(rec, serverPlain);
    switch (out.kind) {
      case 'use-server':
        if (out.notify) this.#notify({ kind: 'server-edit-won', id: rec.id });
        return out.notify;
      case 'use-server-and-copy':
        await this.#putLocal(out.copy.id, out.copy.plain);
        return true;
      case 'restore-as-new':
        await this.#putLocal(out.record.id, out.record.plain);
        this.#notify({ kind: 'restored-as-new', id: out.record.id, originalId: rec.id });
        return true;
      case 'push':
        await this.#putLocal(rec.id, out.record);
        return false;
    }
  }

  async applyPushResults(results: PushResult[]): Promise<{ conflicts: number }> {
    const { file } = this.#syncGuard();
    this.#sess();
    let conflicts = 0;
    for (const r of results) {
      const mine = this.#recs.get(r.id);
      if (r.status === 'ok') {
        file.sync.maxSeenRev = Math.max(file.sync.maxSeenRev, r.rev);
        if (!mine) continue;
        const sent = this.#inflight.get(r.id);
        const same = sent === (mine.nonce ?? 'tombstone');
        this.#inflight.delete(r.id);
        if (mine.deleted && same) {
          // Keep the tombstone: rotations must include every id the server still holds.
          this.#recs.set(r.id, { ...mine, rev: r.rev, baseRev: r.rev, dirty: false });
        } else {
          this.#recs.set(r.id, {
            ...mine,
            rev: same ? r.rev : mine.rev,
            baseRev: r.rev,
            dirty: !same,
          });
        }
        continue;
      }
      const cur = r.current;
      if (cur.vkVersion !== file.keyset.vkVersion) throw new VaultCoreError('E_STALE_KEY');
      file.sync.maxSeenRev = Math.max(file.sync.maxSeenRev, cur.rev);
      this.#inflight.delete(r.id);
      const sp = await this.#decryptServer(cur);
      if (await this.#resolve(cur, sp)) conflicts++;
    }
    await this.#adoptMeta();
    await this.#save();
    return { conflicts };
  }

  async applyPulled(p: {
    records: EncryptedRecord[];
    cursor: number;
    keyset?: Keyset;
    fullResync: boolean;
    hasMore?: boolean;
  }): Promise<{ conflicts: number; needsMasterPassword: boolean }> {
    await this.#ensureLoaded();
    const { file, local } = this.#syncGuard();
    this.#sess();
    const last = p.hasMore !== true;

    // ---- keyset: monotonic, and a VK change needs the master password (§7.7) ----
    let keysetUpdate: Keyset | null = null;
    if (p.keyset) {
      const k = keysetSchema.safeParse(p.keyset);
      if (!k.success) throw new VaultCoreError('E_CORRUPTED', 'malformed keyset');
      if (
        !local.allowDowngrade &&
        (k.data.keysetVersion < file.keyset.keysetVersion ||
          k.data.vkVersion < file.keyset.vkVersion)
      )
        return this.#rollback();
      if (k.data.vkVersion !== file.keyset.vkVersion) {
        local.pendingRotation = k.data;
        local.allowDowngrade = false;
        await this.#persistLocal();
      } else if (k.data.keysetVersion !== file.keyset.keysetVersion) {
        keysetUpdate = k.data;
      }
    }
    if (local.pendingRotation) return { conflicts: 0, needsMasterPassword: true };

    // ---- rollback checks (not gap-free across keyset changes: compare monotonicity only) ----
    if (!p.fullResync && p.cursor < file.sync.cursor) return this.#rollback();
    if (last && p.cursor < file.sync.maxSeenRev) return this.#rollback();
    let maxRev = p.cursor;
    for (const r of p.records) {
      if (r.rev > p.cursor) return this.#rollback();
      if (r.vkVersion < file.keyset.vkVersion) return this.#rollback();
      maxRev = Math.max(maxRev, r.rev);
      const mine = this.#recs.get(r.id);
      if (mine && !mine.dirty && mine.rev > r.rev) return this.#rollback();
    }
    if (p.records.some((r) => r.vkVersion > file.keyset.vkVersion))
      return { conflicts: 0, needsMasterPassword: true };

    // ---- authenticate everything before touching state ----
    const plains = new Map<string, RecordPlain | null>();
    for (const r of p.records) plains.set(r.id, await this.#decryptServer(r));

    // ---- apply ----
    let conflicts = 0;
    if (p.fullResync && this.#resyncSeen === null) this.#resyncSeen = new Set();
    if (!p.fullResync) this.#resyncSeen = null;
    for (const r of p.records) {
      this.#resyncSeen?.add(r.id);
      const mine = this.#recs.get(r.id);
      const sp = plains.get(r.id) ?? null;
      if (!mine?.dirty) {
        this.#setServerRecord(r, sp);
      } else if (r.rev > mine.baseRev) {
        if (await this.#resolve(r, sp)) conflicts++;
      }
    }
    if (keysetUpdate) {
      file.keyset = keysetUpdate;
      local.allowDowngrade = false;
    }
    if (last && this.#resyncSeen) {
      for (const [id, r] of [...this.#recs]) {
        if (!r.dirty && !this.#resyncSeen.has(id)) {
          this.#recs.delete(id);
          this.#sess().plains.delete(id);
        }
      }
      this.#resyncSeen = null;
    }
    file.sync.cursor = p.cursor;
    file.sync.maxSeenRev = Math.max(file.sync.maxSeenRev, maxRev);
    if (last) file.sync.lastSyncedAt = this.#nowIso();
    await this.#adoptMeta();
    await this.#persistLocal();
    await this.#save();
    return { conflicts, needsMasterPassword: false };
  }

  /** Picks up a reissued recovery key / PC session length from the synced meta record (§7.7). */
  async #adoptMeta(): Promise<void> {
    const m = this.#meta();
    const { local } = this.#acct();
    if (!m) return;
    if (local.pcSessionMaxSec !== m.data.pcSessionMaxSec) {
      local.pcSessionMaxSec = m.data.pcSessionMaxSec;
      await this.#persistLocal();
    }
    try {
      const sk = await parseRecoveryKey(this.d.crypto, m.data.recoveryKey);
      const cur = await this.d.keystore.read('sk');
      if (!cur || !eqBytes(cur, sk)) await this.d.keystore.write('sk', sk);
    } catch {
      // an unparsable key in the meta record is ignored; the stored key stays
    }
  }

  async acceptServerState(): Promise<void> {
    const { file, local } = this.#acct();
    local.rollbackDetected = false;
    local.allowDowngrade = true;
    file.sync.cursor = 0;
    file.sync.maxSeenRev = 0;
    for (const [id, r] of [...this.#recs]) if (!r.dirty) this.#recs.delete(id);
    if (this.#session) {
      for (const id of [...this.#session.plains.keys()])
        if (!this.#recs.has(id)) this.#session.plains.delete(id);
    }
    await this.#persistLocal();
    await this.#persistFile();
  }

  // ================================================================ settings

  async getSettings(): Promise<Settings> {
    await this.#ensureLoaded();
    const { local } = this.#acct();
    return {
      autoLockSec: local.autoLockSec,
      clipboardClearSec: local.clipboardClearSec,
      showUsernameBeforeAuth: local.showUsernameBeforeAuth,
      pcSessionMaxSec: local.pcSessionMaxSec,
    };
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const { local } = this.#acct();
    if (patch.autoLockSec !== undefined) local.autoLockSec = patch.autoLockSec;
    if (patch.clipboardClearSec !== undefined) local.clipboardClearSec = patch.clipboardClearSec;
    if (patch.showUsernameBeforeAuth !== undefined)
      local.showUsernameBeforeAuth = patch.showUsernameBeforeAuth;
    if (patch.pcSessionMaxSec !== undefined && patch.pcSessionMaxSec !== local.pcSessionMaxSec) {
      const m = this.#meta();
      this.#sess();
      if (!m) throw new VaultCoreError('E_NOT_FOUND', 'meta record missing');
      local.pcSessionMaxSec = patch.pcSessionMaxSec;
      await this.#putLocal(META_RECORD_ID, {
        ...m,
        data: { ...m.data, pcSessionMaxSec: patch.pcSessionMaxSec },
        updatedAt: this.#nowIso(),
        updatedBy: local.deviceId,
      });
      await this.#save();
    }
    await this.#persistLocal();
  }

  async getAutofillStatus() {
    return { supported: false, enabled: false, textInsertionSupported: false };
  }
  async requestEnableAutofill(): Promise<boolean> {
    return false;
  }

  async listTrustedBrowsers(): Promise<TrustedBrowser[]> {
    if (this.d.platform !== 'android') return [];
    const extra = (await this.d.trustedBrowsers?.load()) ?? [];
    return [...DEFAULT_BROWSERS, ...extra.map((e) => ({ ...e, builtIn: false }))];
  }
  async addTrustedBrowser(packageName: string): Promise<void> {
    if (this.d.platform !== 'android') throw new VaultCoreError('E_INVALID_INPUT', 'Android only');
    if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName))
      throw new VaultCoreError('E_INVALID_INPUT', 'invalid package name');
    const list = (await this.d.trustedBrowsers?.load()) ?? [];
    if (
      list.some((x) => x.packageName === packageName) ||
      DEFAULT_BROWSERS.some((x) => x.packageName === packageName)
    )
      return;
    await this.d.trustedBrowsers?.save([...list, { packageName, label: packageName }]);
  }
  async removeTrustedBrowser(packageName: string): Promise<void> {
    if (DEFAULT_BROWSERS.some((x) => x.packageName === packageName))
      throw new VaultCoreError('E_INVALID_INPUT', 'built-in entries cannot be removed');
    const list = (await this.d.trustedBrowsers?.load()) ?? [];
    await this.d.trustedBrowsers?.save(list.filter((x) => x.packageName !== packageName));
  }

  // ================================================================ devices and PC approval

  async listDevices(): Promise<DeviceInfo[]> {
    const { local } = this.#unlocked();
    return this.#devices().map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      type: d.type,
      platform: d.platform,
      addedAt: d.addedAt,
      revokedAt: d.revokedAt,
      isThisDevice: d.deviceId === local.deviceId,
    }));
  }

  async renameDevice(deviceId: string, name: string): Promise<void> {
    const { local } = this.#unlocked();
    if (name.length < FIELD.deviceNameMin || name.length > FIELD.deviceNameMax)
      throw new VaultCoreError('E_INVALID_INPUT', 'device name length');
    const dev = this.#sess().plains.get(deviceId);
    if (dev?.kind !== 'device') throw new VaultCoreError('E_NOT_FOUND');
    await this.#putLocal(deviceId, {
      ...dev,
      data: { ...dev.data, name },
      updatedAt: this.#nowIso(),
      updatedBy: local.deviceId,
    });
    if (deviceId === local.deviceId) {
      local.deviceName = name;
      await this.#persistLocal();
    }
    await this.#save();
  }

  async parsePairingQr(qr: string) {
    const { file } = this.#acct();
    let q: ReturnType<typeof parsePairQr>;
    try {
      q = parsePairQr(qr, { allowInsecureLocalhost: this.d.allowInsecureLocalhost === true });
    } catch (e) {
      if (e instanceof QrParseError)
        throw new VaultCoreError('E_INVALID_INPUT', 'malformed pairing QR');
      throw e;
    }
    if (q.serverOrigin !== file.serverUrl)
      throw new VaultCoreError('E_SERVER_MISMATCH', 'QR belongs to a different server');
    return { pairingId: q.pairingId, serverOrigin: q.serverOrigin, fingerprint: q.fingerprint };
  }

  async approvePairing(p: {
    pairing: PairingInfo;
    fingerprint: string;
    name: string;
  }): Promise<ServerRequest> {
    const { file, local } = this.#unlocked();
    const s = this.#sess();
    const c = this.d.crypto;
    if (!(await verifyPairingFingerprint(c, p.pairing.signPub, p.pairing.ephPub, p.fingerprint)))
      throw new VaultCoreError('E_FINGERPRINT_MISMATCH', 'QR and server public keys differ');
    if (
      p.pairing.platform !== 'chrome' &&
      p.pairing.platform !== 'edge' &&
      p.pairing.platform !== 'brave'
    )
      throw new VaultCoreError('E_INVALID_INPUT', 'unsupported platform');
    if (p.name.length < FIELD.deviceNameMin || p.name.length > FIELD.deviceNameMax)
      throw new VaultCoreError('E_INVALID_INPUT', 'device name length');
    const token = await this.#auth('PC を登録');
    const now = this.#nowIso();
    await this.#putLocal(p.pairing.deviceId, {
      kind: 'device',
      data: {
        deviceId: p.pairing.deviceId,
        name: p.name,
        type: 'extension',
        platform: p.pairing.platform,
        signPub: p.pairing.signPub,
        adminPub: null,
        addedAt: now,
        addedBy: local.deviceId,
        addedVia: 'pairing',
        revokedAt: null,
      },
      updatedAt: now,
      updatedBy: local.deviceId,
    });
    const env = await seal(c, unb64(p.pairing.ephPub), sealContextPair(p.pairing.pairingId), {
      vk: b64(s.vk),
      vkVersion: file.keyset.vkVersion,
      sessionMaxSec: this.#meta()?.data.pcSessionMaxSec ?? local.pcSessionMaxSec,
      issuedAt: now,
    });
    await this.#save();
    return this.#adminRequest(
      'POST',
      `/v1/pairings/${p.pairing.pairingId}/approve`,
      { response: env },
      { auth: token },
    );
  }

  #nonceSeen(nonce: string): boolean {
    const { local } = this.#acct();
    const at = local.seenNonces[nonce];
    return at !== undefined && this.#now().getTime() - at < NONCE_MS;
  }

  async rememberUnlockNonce(nonce: string): Promise<void> {
    const { local } = this.#acct();
    const t = this.#now().getTime();
    for (const [k, v] of Object.entries(local.seenNonces))
      if (t - v >= NONCE_MS) delete local.seenNonces[k];
    local.seenNonces[nonce] = t;
    await this.#persistLocal();
  }

  async verifyUnlockRequest(req: PendingUnlockRequest): Promise<VerifyUnlockResult> {
    const { file } = this.#unlocked();
    return coreVerifyUnlock(this.d.crypto, {
      accountId: file.accountId,
      request: { deviceId: req.deviceId, ...req.payload },
      trust: this.#devices(),
      now: this.#now(),
      isNonceSeen: (n) => this.#nonceSeen(n),
    });
  }

  async approveUnlock(p: {
    request: PendingUnlockRequest;
    typedCode: string;
  }): Promise<ServerRequest> {
    const { file, local } = this.#unlocked();
    const s = this.#sess();
    const v = await this.verifyUnlockRequest(p.request);
    if (!v.ok) throw new VaultCoreError('E_UNTRUSTED_DEVICE', v.reason);
    const id = p.request.requestId;
    const failed = this.#unlockFails.get(id) ?? 0;
    if (failed >= UNLOCK_CODE_MAX_ATTEMPTS)
      throw new VaultCoreError('E_CODE_MISMATCH', 'too many wrong codes', { attemptsLeft: 0 });
    const r = evaluateCodeAttempt({
      typedCode: p.typedCode,
      signedCode: p.request.payload.code,
      failedAttempts: failed,
    });
    if (!r.ok) {
      this.#unlockFails.set(id, failed + 1);
      throw new VaultCoreError('E_CODE_MISMATCH', 'wrong code', { attemptsLeft: r.attemptsLeft });
    }
    await this.#auth('PC の解錠を承認');
    const env = await seal(this.d.crypto, unb64(p.request.payload.ephPub), sealContextUnlock(id), {
      vk: b64(s.vk),
      vkVersion: file.keyset.vkVersion,
      sessionMaxSec: this.#meta()?.data.pcSessionMaxSec ?? local.pcSessionMaxSec,
      issuedAt: this.#nowIso(),
    });
    await this.rememberUnlockNonce(p.request.payload.requestNonce);
    return { method: 'POST', path: `/v1/unlock-requests/${id}/approve`, body: { response: env } };
  }

  async revokeDevice(p: {
    deviceId: string;
    rotateKey: boolean;
    /** Needed for a key rotation: the new keyset is wrapped under the master password. */
    masterPassword?: string;
  }): Promise<ServerRequest[]> {
    const { file } = this.#unlocked();
    const token = await this.#auth('端末を解除');
    const c = this.d.crypto;
    let pw: Awaited<ReturnType<VaultEngine['__verify']>> | null = null;
    if (p.rotateKey) {
      if (p.masterPassword === undefined)
        throw new VaultCoreError('E_NEEDS_MASTER_PASSWORD', 'rotation needs the master password');
      pw = await this.#verifyPassword(p.masterPassword);
    }
    await this.#markDeviceRevoked(p.deviceId);
    const del = await this.#adminRequest('DELETE', `/v1/devices/${p.deviceId}`, undefined, {
      auth: token,
    });
    if (!p.rotateKey || !pw || p.masterPassword === undefined) {
      await this.#save();
      const batch = this.#batchRequest(100);
      return batch ? [batch, del] : [del];
    }
    const newVk = await c.randomBytes(32);
    const newVkVersion = file.keyset.vkVersion + 1;
    const bundle = await createKeyset(c, {
      masterPassword: p.masterPassword,
      recoveryKey: pw.sk,
      accountId: file.accountId,
      vk: newVk,
      keysetVersion: file.keyset.keysetVersion + 1,
      vkVersion: newVkVersion,
    });
    const records: { id: string; deleted: boolean; nonce: string | null; ct: string | null }[] = [];
    for (const r of this.#recs.values()) {
      const plain = this.#sess().plains.get(r.id);
      if (r.deleted || !plain) {
        records.push({ id: r.id, deleted: true, nonce: null, ct: null });
        continue;
      }
      const enc = await encryptRecord(
        c,
        newVk,
        { accountId: file.accountId, recordId: r.id, vkVersion: newVkVersion },
        plain,
      );
      records.push({ id: r.id, deleted: false, nonce: enc.nonce, ct: enc.ct });
    }
    const expectedRev = file.sync.cursor;
    this.#staged = {
      kind: 'rotation',
      keyset: bundle.keyset,
      verifier: bundle.verifier,
      newVk,
      expectedRev,
      records,
    };
    wipe(bundle.authKey, bundle.kek);
    await this.#persistFile();
    const start = await this.#adminRequest(
      'POST',
      '/v1/rotations',
      { expectedRev, newVkVersion },
      { auth: token },
    );
    return [del, start];
  }
  // Only used to name the return type of #verifyPassword above.
  async __verify(pw: string) {
    return this.#verifyPassword(pw);
  }

  async continueRotation(rotationId: string): Promise<ServerRequest[]> {
    const st = this.#staged;
    if (st?.kind !== 'rotation') throw new VaultCoreError('E_NOT_FOUND', 'no rotation in progress');
    const out: ServerRequest[] = [];
    for (let i = 0; i < st.records.length; i += 100) {
      out.push({
        method: 'PUT',
        path: `/v1/rotations/${rotationId}/records`,
        body: { records: st.records.slice(i, i + 100) },
      });
    }
    out.push(
      await this.#adminRequest('POST', `/v1/rotations/${rotationId}/commit`, {
        keyset: st.keyset,
        verifier: st.verifier,
        recordCount: st.records.length,
      }),
    );
    return out;
  }

  async abortRotation(rotationId: string): Promise<ServerRequest> {
    this.#staged = null;
    return { method: 'DELETE', path: `/v1/rotations/${rotationId}` };
  }

  async confirmRotation(r: { cursor: number }): Promise<void> {
    const st = this.#staged;
    if (st?.kind !== 'rotation') throw new VaultCoreError('E_NOT_FOUND', 'no rotation in progress');
    const { file, local } = this.#acct();
    this.#staged = null;
    const next = new Map<string, VaultFileRecord>();
    for (const x of st.records) {
      const old = this.#recs.get(x.id);
      const base = {
        id: x.id,
        rev: old?.rev ?? 0,
        vkVersion: st.keyset.vkVersion,
        dirty: false,
        baseRev: old?.rev ?? 0,
      };
      next.set(
        x.id,
        x.deleted || x.nonce === null || x.ct === null
          ? { ...base, deleted: true, nonce: null, ct: null }
          : { ...base, deleted: false, nonce: x.nonce, ct: x.ct },
      );
    }
    this.#recs = next;
    file.keyset = st.keyset;
    this.#sess().vk = st.newVk;
    // The server renumbered every record: refetch everything (fullResync) to learn the new revs.
    file.sync.cursor = 0;
    file.sync.maxSeenRev = Math.max(file.sync.maxSeenRev, r.cursor);
    if (local.biometricsEnabled) await this.d.keystore.write('vk.bio', st.newVk);
    await this.#save();
  }

  async getDeviceRegistration(): Promise<DeviceRegistration> {
    await this.#ensureLoaded();
    const { local } = this.#acct();
    return {
      deviceId: local.deviceId,
      platform: this.d.platform,
      signPub: local.signPub,
      adminPub: local.adminPub,
    };
  }

  // ================================================================ recovery code (§8.11)

  async issueRecoveryCode(p: {
    waitSec: RecoveryWaitSec;
  }): Promise<{ request: ServerRequest; sheet: RecoverySheet }> {
    const { file } = this.#unlocked();
    const s = this.#sess();
    const token = await this.#auth('復旧コードを発行');
    const rc = await generateRecoveryCode(this.d.crypto);
    const reg = await createRecoveryCodeRegistration(
      this.d.crypto,
      rc,
      file.accountId,
      s.vk,
      file.keyset.vkVersion,
    );
    const request = await this.#adminRequest(
      'PUT',
      '/v1/recovery-code',
      {
        rcId: reg.rcId,
        verifier: reg.verifier,
        wrappedVK: reg.wrappedVK,
        vkVersion: reg.vkVersion,
        waitSec: p.waitSec,
      },
      { auth: token },
    );
    const sheet = {
      qr: formatRcQr(
        { serverUrl: file.serverUrl, accountId: file.accountId, rc: b64(rc) },
        { allowInsecureLocalhost: this.d.allowInsecureLocalhost === true },
      ),
      text: await formatRecoveryCode(this.d.crypto, rc),
    };
    wipe(rc);
    return { request, sheet };
  }

  async buildSetRecoveryWait(waitSec: RecoveryWaitSec): Promise<ServerRequest> {
    this.#acct();
    return this.#adminRequest('PUT', '/v1/recovery-code/wait-period', { waitSec });
  }
  async buildRevokeRecoveryCode(): Promise<ServerRequest> {
    this.#acct();
    return this.#adminRequest('DELETE', '/v1/recovery-code');
  }

  async #readClaim(): Promise<ClaimSlot | null> {
    const raw = await this.d.keystore.read('claim');
    return raw ? (JSON.parse(utf8Decode(raw)) as ClaimSlot) : null;
  }
  async #writeClaim(c: ClaimSlot): Promise<void> {
    await this.d.keystore.write('claim', utf8Encode(JSON.stringify(c)));
  }

  async startRecoveryClaim(
    p: { qr: string } | { serverUrl: string; accountId: string; text: string },
  ): Promise<{ request: ServerRequest }> {
    await this.#ensureLoaded();
    const c = this.d.crypto;
    let rc: Uint8Array;
    let serverUrl: string;
    let accountId: string;
    try {
      if ('qr' in p) {
        const q = parseRcQr(p.qr, {
          allowInsecureLocalhost: this.d.allowInsecureLocalhost === true,
        });
        rc = unb64(q.rc);
        serverUrl = q.serverUrl;
        accountId = q.accountId;
      } else {
        rc = await parseRecoveryCode(c, p.text);
        serverUrl = this.#serverUrl(p.serverUrl);
        accountId = p.accountId;
      }
    } catch (e) {
      if (e instanceof QrParseError) throw new VaultCoreError('E_INVALID_RECOVERY_CODE');
      throw e;
    }
    const keys = await deriveRecoveryCodeKeys(c, rc, accountId);
    const sign = await c.generateKeyPair();
    const admin = await c.generateKeyPair();
    const deviceId = await this.#newId();
    await this.#writeClaim({
      serverUrl,
      accountId,
      rc: b64(rc),
      deviceId,
      platform: this.d.platform,
      signPriv: b64(sign.privateKey),
      adminPriv: b64(admin.privateKey),
      signPub: b64(sign.publicKey),
      adminPub: b64(admin.publicKey),
    });
    return {
      request: {
        method: 'POST',
        path: '/v1/recovery-claims',
        body: {
          accountId,
          rcId: b64(keys.rcId),
          authRC: b64(keys.authRC),
          device: {
            deviceId,
            type: 'mobile',
            platform: this.d.platform,
            signPub: b64(sign.publicKey),
            adminPub: b64(admin.publicKey),
          },
        },
      },
    };
  }

  async rememberRecoveryClaim(p: {
    claimId: string;
    claimToken: string;
    availableAt: string;
  }): Promise<void> {
    const c = await this.#readClaim();
    if (!c) throw new VaultCoreError('E_NOT_FOUND', 'no recovery claim in progress');
    await this.#writeClaim({ ...c, ...p });
  }

  async getPendingRecoveryClaim() {
    const c = await this.#readClaim();
    if (!c || c.claimId === undefined || c.availableAt === undefined) return null;
    return { claimId: c.claimId, availableAt: c.availableAt, serverUrl: c.serverUrl };
  }

  async buildCompleteRecoveryClaim(): Promise<ServerRequest> {
    const c = await this.#readClaim();
    if (!c || c.claimId === undefined || c.claimToken === undefined)
      throw new VaultCoreError('E_NOT_FOUND', 'no recovery claim in progress');
    return {
      method: 'POST',
      path: `/v1/recovery-claims/${c.claimId}/complete`,
      body: {},
      headers: { Authorization: `Claim ${c.claimToken}` },
    };
  }

  async completeRecoveryClaim(response: RecoveryClaimResponse): Promise<void> {
    const c = await this.#readClaim();
    if (!c) throw new VaultCoreError('E_NOT_FOUND', 'no recovery claim in progress');
    let vk: Uint8Array;
    try {
      vk = await unwrapVaultKeyWithRecoveryCode(
        this.d.crypto,
        unb64(c.rc),
        c.accountId,
        response.wrappedVK,
        response.vkVersion,
      );
    } catch (e) {
      if (e instanceof CryptoError)
        throw new VaultCoreError('E_CORRUPTED', 'recovery code did not unwrap the key');
      throw e;
    }
    const ks = keysetSchema.safeParse(response.keyset);
    if (!ks.success || ks.data.vkVersion !== response.vkVersion)
      throw new VaultCoreError('E_CORRUPTED', 'inconsistent keyset');
    const now = this.#nowIso();
    const name = normalizeAccountName(response.accountName);
    if (!name.ok) throw new VaultCoreError('E_INVALID_INPUT', 'invalid account name');
    const deviceName = this.d.deviceName ?? (this.d.platform === 'ios' ? 'iPhone' : 'Android');
    const file: VaultFile = {
      format: 'localvault',
      version: 2,
      accountId: c.accountId,
      accountName: name.name,
      serverUrl: c.serverUrl,
      keyset: ks.data,
      records: [],
      sync: { cursor: 0, maxSeenRev: 0, lastSyncedAt: null },
    };
    const enc = await encryptRecord(
      this.d.crypto,
      vk,
      { accountId: c.accountId, recordId: c.deviceId, vkVersion: ks.data.vkVersion },
      {
        kind: 'device',
        data: {
          deviceId: c.deviceId,
          name: deviceName,
          type: 'mobile',
          platform: this.d.platform,
          signPub: c.signPub,
          adminPub: c.adminPub,
          addedAt: now,
          addedBy: c.deviceId,
          addedVia: 'recovery-code',
          revokedAt: null,
        },
        updatedAt: now,
        updatedBy: c.deviceId,
      },
    );
    file.records.push({
      id: c.deviceId,
      rev: 0,
      deleted: false,
      vkVersion: ks.data.vkVersion,
      nonce: enc.nonce,
      ct: enc.ct,
      dirty: true,
      baseRev: 0,
    });
    await this.#install({
      file,
      local: this.#newLocal(c.deviceId, deviceName, c.signPub, c.adminPub),
      vk,
      sk: null,
      signPriv: unb64(c.signPriv),
      adminPriv: unb64(c.adminPriv),
    });
    await this.d.keystore.delete('claim'); // RC and claimToken are gone
  }

  async setMasterPasswordAfterCodeRecovery(next: string): Promise<ServerRequest> {
    const { file } = this.#unlocked();
    if (next.length < FIELD.masterPasswordMin)
      throw new VaultCoreError('E_INVALID_INPUT', 'master password too short');
    const m = this.#meta();
    if (!m) throw new VaultCoreError('E_NOT_FOUND', 'pull all records first');
    const sk = await parseRecoveryKey(this.d.crypto, m.data.recoveryKey);
    await this.d.keystore.write('sk', sk);
    return this.#stageKeyset(file, next, sk, this.#sess().vk, null);
  }

  async abandonRecoveryClaim(): Promise<void> {
    await this.d.keystore.delete('claim');
  }

  async buildCancelRecoveryClaim(claimId: string): Promise<ServerRequest> {
    this.#acct();
    return this.#adminRequest('POST', `/v1/recovery-claims/${claimId}/cancel`, {});
  }
  async buildApproveRecoveryClaimNow(claimId: string): Promise<ServerRequest> {
    this.#acct();
    return this.#adminRequest('POST', `/v1/recovery-claims/${claimId}/approve-now`, {});
  }

  // ================================================================ backup

  #logins(): { id: string; p: Extract<RecordPlain, { kind: 'login' }> }[] {
    const out: { id: string; p: Extract<RecordPlain, { kind: 'login' }> }[] = [];
    for (const [id, p] of this.#sess().plains) if (p.kind === 'login') out.push({ id, p });
    return out;
  }

  async exportVault(exportPassword: string): Promise<{ fileUri: string }> {
    const { local } = this.#unlocked();
    const items = this.#logins()
      .filter((x) => x.p.data.trashedAt === null)
      .map((x) => ({ id: x.id, data: x.p.data, updatedAt: x.p.updatedAt }));
    const file = await createExportFile(this.d.crypto, {
      exportPassword,
      payload: { items },
      exportedAt: this.#nowIso(),
    });
    const uri = await this.d.files.write(
      `localvault-${this.#nowIso().slice(0, 10)}.lvbackup`,
      utf8Encode(JSON.stringify(file)),
    );
    local.lastExportAt = this.#nowIso();
    await this.#persistLocal();
    return { fileUri: uri };
  }

  async deleteExportFile(fileUri: string): Promise<void> {
    await this.d.files.delete(fileUri);
  }

  async #readExport(fileUri: string, password: string): Promise<ExportPayload> {
    let json: unknown;
    try {
      json = JSON.parse(utf8Decode(await this.d.files.read(fileUri)));
    } catch (e) {
      if (e instanceof VaultCoreError) throw e;
      throw new VaultCoreError('E_IMPORT_FORMAT', 'not JSON');
    }
    return (await openExportFile(this.d.crypto, password, json)).payload;
  }

  async inspectImport(fileUri: string, password: string) {
    this.#unlocked();
    const payload = await this.#readExport(fileUri, password);
    const have = new Set(this.#logins().map((x) => x.id));
    return {
      itemCount: payload.items.length,
      conflictCount: payload.items.filter((i) => have.has(i.id)).length,
    };
  }

  async importVault(fileUri: string, password: string, strategy: 'append' | 'newer' | 'replace') {
    const { local } = this.#unlocked();
    const payload = await this.#readExport(fileUri, password);
    const now = this.#nowIso();
    const existing = new Map(this.#logins().map((x) => [x.id, x.p]));
    let added = 0;
    let updated = 0;
    if (strategy === 'replace') {
      const incoming = new Set(payload.items.map((i) => i.id));
      for (const id of existing.keys()) if (!incoming.has(id)) this.#putTombstone(id);
    }
    for (const it of payload.items) {
      const cur = existing.get(it.id);
      let id = it.id;
      if (cur) {
        if (strategy === 'append') id = await this.#newId();
        else if (strategy === 'newer' && !(it.updatedAt > cur.updatedAt)) continue;
      }
      const target = id === it.id ? cur : undefined;
      await this.#putLocal(id, {
        kind: 'login',
        data: { ...it.data, passwordHistory: it.data.passwordHistory ?? [] },
        updatedAt: now,
        updatedBy: local.deviceId,
      });
      if (target) updated++;
      else added++;
    }
    await this.#save();
    return { added, updated };
  }

  async #parseCsv(fileUri: string) {
    const text = utf8Decode(await this.d.files.read(fileUri));
    const res = parseCsvImport(text);
    const psl = this.d.psl ?? defaultPsl();
    const dup = new Set(
      findDuplicateDrafts(
        psl,
        res.drafts,
        this.#logins()
          .filter((x) => x.p.data.trashedAt === null)
          .map((x) => ({ username: x.p.data.username, urls: x.p.data.urls })),
      ),
    );
    return { res, dup };
  }

  async inspectCsvImport(fileUri: string) {
    this.#unlocked();
    const { res, dup } = await this.#parseCsv(fileUri);
    return {
      format: res.format as CsvFormatName,
      itemCount: res.drafts.length,
      duplicateCount: dup.size,
      skippedCount: res.skipped.length,
    };
  }

  async importCsv(fileUri: string, opts: { skipDuplicates: boolean }) {
    const { local } = this.#unlocked();
    const { res, dup } = await this.#parseCsv(fileUri);
    const now = this.#nowIso();
    let added = 0;
    let skipped = res.skipped.length;
    for (const [i, d] of res.drafts.entries()) {
      if (opts.skipDuplicates && dup.has(i)) {
        skipped++;
        continue;
      }
      await this.#putLocal(await this.#newId(), {
        kind: 'login',
        data: {
          title: d.title,
          username: d.username,
          password: d.password,
          urls: d.urls,
          androidApps: [],
          notes: d.notes,
          favorite: d.favorite,
          createdAt: now,
          trashedAt: null,
          conflictOf: null,
          passwordHistory: [],
        },
        updatedAt: now,
        updatedBy: local.deviceId,
      });
      added++;
    }
    await this.#save();
    return { added, skipped };
  }

  async getBackupInfo(): Promise<{ lastExportAt: string | null }> {
    await this.#ensureLoaded();
    return { lastExportAt: this.#acct().local.lastExportAt };
  }
}

// ---------------------------------------------------------------- helpers

function uuidV4(random: Uint8Array): string {
  return uuidV4FromRandom(random);
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number);
  return d === 0;
}
