// In-memory VaultCore for tests and visual checks. NOT secure: it keeps the master password in
// memory and does no cryptography except generating a well-formed recovery key. Methods that no
// screen of this wave needs reject with E_INVALID_INPUT("not supported by FakeVaultCore").
import {
  attemptsBeforeThrottle,
  defaultProvider,
  formatRecoveryKey,
  generateRecoveryKeyBytes,
  type ItemDetail,
  type ItemInput,
  type ItemSummary,
  type LockState,
  type ServerRequest,
  type Settings,
  throttleState,
  type VaultCore,
  VaultCoreError,
  type VaultCoreEventName,
  type VaultCoreEvents,
} from '@localvault/core';
import { base64urlEncode } from '@localvault/protocol';

type Listener<E extends VaultCoreEventName> = (payload: VaultCoreEvents[E]) => void;

export function fakeId(): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

export const fakeB64 = (n: number, fill = 1): string =>
  base64urlEncode(new Uint8Array(n).fill(fill));

export const fakeKeyset = () => ({
  keysetVersion: 1,
  vkVersion: 1,
  kdf: { alg: 'PBKDF2-HMAC-SHA256' as const, iterations: 600_000, salt: fakeB64(16) },
  wrappedVK: { nonce: fakeB64(12), ct: fakeB64(48) },
});

const unsupported = (): never => {
  throw new VaultCoreError('E_INVALID_INPUT', 'not supported by FakeVaultCore');
};

export type FakeOptions = {
  lockState?: LockState;
  masterPassword?: string;
  biometrics?: 'faceId' | 'touchId' | 'biometric' | 'none';
  now?: () => number;
};

export class FakeVaultCore implements VaultCore {
  private state: LockState;
  private password: string | null;
  private biometricKind: 'faceId' | 'touchId' | 'biometric' | 'none';
  private biometricsOn = false;
  private failedCount = 0;
  private lastFailureAtMs: number | null = null;
  private account: {
    accountId: string;
    accountName: string;
    serverUrl: string;
    deviceId: string;
  } | null = null;
  private pending: { accountName: string; serverUrl: string; password: string } | null = null;
  private claim: { claimId: string; availableAt: string; serverUrl: string } | null = null;
  private items = new Map<string, ItemDetail>();
  private settings: Settings = {
    autoLockSec: 60,
    clipboardClearSec: 30,
    showUsernameBeforeAuth: false,
    pcSessionMaxSec: 3600,
  };
  private listeners: { [E in VaultCoreEventName]?: Set<Listener<E>> } = {};
  private readonly now: () => number;

  /** Test hooks. */
  pendingChanges: ReturnType<VaultCore['getPendingChanges']> extends Promise<infer R> ? R : never =
    [];
  syncCursor = 0;
  pulled: Parameters<VaultCore['applyPulled']>[0][] = [];
  pushedResults: Parameters<VaultCore['applyPushResults']>[0][] = [];
  applyPulledImpl:
    | ((
        p: Parameters<VaultCore['applyPulled']>[0],
      ) => Promise<{ conflicts: number; needsMasterPassword: boolean }>)
    | null = null;
  accepted = 0;
  wiped = 0;
  biometricFails: VaultCoreError | null = null;

  constructor(opts: FakeOptions = {}) {
    this.state = opts.lockState ?? 'uninitialized';
    this.password = opts.masterPassword ?? null;
    this.biometricKind = opts.biometrics ?? 'faceId';
    this.now = opts.now ?? Date.now;
    if (this.state !== 'uninitialized') {
      this.account = {
        accountId: fakeId(),
        accountName: 'alice',
        serverUrl: 'https://vault.example.com',
        deviceId: fakeId(),
      };
    }
  }

  // ---- events
  on<E extends VaultCoreEventName>(event: E, listener: Listener<E>): () => void {
    const bag = this.listeners as Record<string, Set<unknown>>;
    let existing = bag[event];
    if (existing === undefined) {
      existing = new Set();
      bag[event] = existing;
    }
    const set = existing as Set<Listener<E>>;
    set.add(listener);
    return () => set.delete(listener);
  }

  emit<E extends VaultCoreEventName>(event: E, payload: VaultCoreEvents[E]): void {
    for (const l of (this.listeners[event] as Set<Listener<E>> | undefined) ?? []) l(payload);
  }

  private setState(next: LockState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('onLockStateChange', { state: next });
  }

  // ---- state and unlocking
  async getLockState() {
    return this.state;
  }
  async getBiometricAvailability() {
    return { available: this.biometricKind !== 'none', kind: this.biometricKind };
  }
  async enableBiometrics() {
    if (this.biometricKind === 'none') throw new VaultCoreError('E_BIOMETRY_UNAVAILABLE');
    this.biometricsOn = true;
  }
  async disableBiometrics() {
    this.biometricsOn = false;
  }
  async unlockWithBiometrics() {
    if (this.biometricFails) throw this.biometricFails;
    if (!this.biometricsOn) throw new VaultCoreError('E_BIOMETRY_UNAVAILABLE');
    this.setState('unlocked');
  }
  async unlockWithPassword(masterPassword: string) {
    const st = await this.getThrottleState();
    if (st.retryAfterSec > 0) {
      throw new VaultCoreError('E_THROTTLED', 'throttled', { retryAfterSec: st.retryAfterSec });
    }
    if (masterPassword !== this.password) {
      this.failedCount += 1;
      this.lastFailureAtMs = this.now();
      const after = await this.getThrottleState();
      if (after.retryAfterSec > 0) {
        throw new VaultCoreError('E_THROTTLED', 'throttled', {
          retryAfterSec: after.retryAfterSec,
        });
      }
      throw new VaultCoreError(
        'E_WRONG_PASSWORD',
        String(attemptsBeforeThrottle(this.failedCount)),
      );
    }
    this.failedCount = 0;
    this.setState('unlocked');
  }
  async lock() {
    if (this.state === 'unlocked') this.setState('locked');
  }

  // ---- account
  async createAccount(p: {
    serverUrl: string;
    accountName: string;
    masterPassword: string;
    inviteCode: string;
  }) {
    const provider = defaultProvider();
    const recoveryKey = await formatRecoveryKey(provider, await generateRecoveryKeyBytes(provider));
    this.pending = {
      accountName: p.accountName,
      serverUrl: p.serverUrl,
      password: p.masterPassword,
    };
    const request: ServerRequest = {
      method: 'POST',
      path: '/v1/accounts',
      body: {
        inviteCode: p.inviteCode === '' ? 'open' : p.inviteCode,
        accountId: fakeId(),
        accountName: p.accountName,
        keyset: fakeKeyset(),
        verifier: fakeB64(32),
        device: {
          deviceId: fakeId(),
          type: 'mobile',
          platform: 'ios',
          signPub: fakeB64(65),
          adminPub: fakeB64(65),
        },
      },
    };
    return { request, recoveryKey };
  }
  async commitAccount() {
    if (!this.pending) throw new VaultCoreError('E_NOT_FOUND');
    this.account = {
      accountId: fakeId(),
      accountName: this.pending.accountName,
      serverUrl: this.pending.serverUrl,
      deviceId: fakeId(),
    };
    this.password = this.pending.password;
    this.pending = null;
    this.setState('unlocked');
  }
  async discardPendingAccount() {
    this.pending = null;
  }
  async deriveAuthKey() {
    return fakeB64(32);
  }
  async buildRecoverRequest(p: { accountName: string; authKey: string }): Promise<ServerRequest> {
    return {
      method: 'POST',
      path: '/v1/auth/recover',
      body: {
        accountId: fakeId(),
        authKey: p.authKey,
        device: {
          deviceId: fakeId(),
          type: 'mobile',
          platform: 'ios',
          signPub: fakeB64(65),
          adminPub: fakeB64(65),
        },
      },
    };
  }
  async restoreAccount(p: {
    serverUrl: string;
    accountName: string;
    accountId: string;
    masterPassword: string;
  }) {
    this.account = {
      accountId: p.accountId,
      accountName: p.accountName,
      serverUrl: p.serverUrl,
      deviceId: fakeId(),
    };
    this.password = p.masterPassword;
    this.setState('unlocked');
  }
  async signAuthChallenge(_challenge: string) {
    return { deviceId: this.account?.deviceId ?? fakeId(), sig: fakeB64(64) };
  }
  async getRecoveryKey(): Promise<string> {
    return unsupported();
  }
  async changeMasterPassword(): Promise<ServerRequest> {
    return unsupported();
  }
  async resetMasterPassword(): Promise<ServerRequest> {
    return unsupported();
  }
  async regenerateRecoveryKey(masterPassword: string) {
    const provider = defaultProvider();
    const recoveryKey = await formatRecoveryKey(provider, await generateRecoveryKeyBytes(provider));
    this.password = masterPassword;
    const request: ServerRequest = {
      method: 'PUT',
      path: '/v1/keyset',
      body: { keyset: { ...fakeKeyset(), keysetVersion: 2 }, verifier: fakeB64(32) },
    };
    return { request, recoveryKey };
  }
  async confirmKeysetAccepted() {}
  async reregisterAdminKey(): Promise<ServerRequest> {
    return unsupported();
  }
  async buildDeleteAccount(): Promise<ServerRequest> {
    return unsupported();
  }
  async wipeLocal() {
    this.wiped += 1;
    this.account = null;
    this.password = null;
    this.claim = null;
    this.items.clear();
    this.setState('uninitialized');
  }
  async getAccountInfo() {
    if (!this.account) throw new VaultCoreError('E_NOT_FOUND');
    return this.account;
  }
  async getThrottleState() {
    return throttleState({
      failedCount: this.failedCount,
      lastFailureAtMs: this.lastFailureAtMs,
      nowMs: this.now(),
    });
  }
  async changeServerUrl(): Promise<void> {
    return unsupported();
  }
  async buildSignOutDevice(): Promise<ServerRequest[]> {
    return unsupported();
  }

  // ---- items (minimal)
  private summary(d: ItemDetail): ItemSummary {
    const {
      urls: _u,
      androidApps: _a,
      notes: _n,
      createdAt: _c,
      conflictOf: _o,
      hasPassword: _h,
      ...s
    } = d;
    return s;
  }
  async listItems(opts?: { includeTrashed?: boolean }) {
    return [...this.items.values()]
      .filter((i) => opts?.includeTrashed || i.trashedAt === null)
      .map((i) => this.summary(i));
  }
  async getItem(id: string) {
    const i = this.items.get(id);
    if (!i) throw new VaultCoreError('E_NOT_FOUND');
    return i;
  }
  async revealPassword(): Promise<string> {
    return unsupported();
  }
  async saveItem(input: ItemInput) {
    const id = input.id ?? fakeId();
    const iso = new Date(this.now()).toISOString();
    const prev = this.items.get(id);
    const detail: ItemDetail = {
      id,
      title: input.title,
      username: input.username,
      hosts: [],
      favorite: input.favorite,
      updatedAt: iso,
      lastUsedAt: null,
      isConflictCopy: false,
      trashedAt: null,
      urls: input.urls,
      androidApps: [],
      notes: input.notes,
      createdAt: prev?.createdAt ?? iso,
      conflictOf: null,
      hasPassword: input.password !== undefined || (prev?.hasPassword ?? false),
    };
    this.items.set(id, detail);
    this.emit('onVaultChanged', {});
    this.emit('onSyncNeeded', {});
    return detail;
  }
  async trashItem(id: string) {
    const i = await this.getItem(id);
    this.items.set(id, { ...i, trashedAt: new Date(this.now()).toISOString() });
  }
  async restoreItem(id: string) {
    const i = await this.getItem(id);
    this.items.set(id, { ...i, trashedAt: null });
  }
  async purgeItem(id: string) {
    this.items.delete(id);
  }
  async resolveConflict(): Promise<void> {
    return unsupported();
  }
  async unlinkAndroidApp(): Promise<void> {
    return unsupported();
  }
  async getPasswordHistory(): Promise<{ index: number; changedAt: string }[]> {
    return [];
  }
  async revealHistoricPassword(): Promise<string> {
    return unsupported();
  }
  async copyHistoricPassword(): Promise<{ clearsAt: string | null }> {
    return unsupported();
  }
  async clearPasswordHistory(): Promise<void> {}
  async copy(): Promise<{ clearsAt: string | null }> {
    return { clearsAt: null };
  }
  async generatePassword(): Promise<string> {
    return unsupported();
  }

  // ---- sync
  async getSyncState() {
    return {
      cursor: this.syncCursor,
      maxSeenRev: this.syncCursor,
      lastSyncedAt: null,
      pendingCount: this.pendingChanges.length,
    };
  }
  async getPendingChanges(limit: number) {
    const out = this.pendingChanges.slice(0, limit);
    return out;
  }
  async applyPushResults(results: Parameters<VaultCore['applyPushResults']>[0]) {
    this.pushedResults.push(results);
    // Accepted changes are no longer pending.
    this.pendingChanges = this.pendingChanges.slice(results.length);
    return { conflicts: 0 };
  }
  async applyPulled(p: Parameters<VaultCore['applyPulled']>[0]) {
    this.pulled.push(p);
    if (this.applyPulledImpl) return this.applyPulledImpl(p);
    this.syncCursor = p.cursor;
    return { conflicts: 0, needsMasterPassword: false };
  }
  async acceptServerState() {
    this.accepted += 1;
    this.syncCursor = 0;
  }

  // ---- devices / PC approval (not in this wave)
  async listDevices() {
    return [];
  }
  async renameDevice(): Promise<void> {
    return unsupported();
  }
  async parsePairingQr(): Promise<{
    pairingId: string;
    serverOrigin: string;
    fingerprint: string;
  }> {
    return unsupported();
  }
  async approvePairing(): Promise<ServerRequest> {
    return unsupported();
  }
  async verifyUnlockRequest(): Promise<never> {
    return unsupported();
  }
  async approveUnlock(): Promise<ServerRequest> {
    return unsupported();
  }
  async revokeDevice(): Promise<ServerRequest[]> {
    return unsupported();
  }
  async getDeviceRegistration() {
    return {
      deviceId: this.account?.deviceId ?? fakeId(),
      platform: 'ios',
      signPub: fakeB64(65),
      adminPub: fakeB64(65),
    };
  }

  // ---- recovery code
  async issueRecoveryCode(): Promise<never> {
    return unsupported();
  }
  async buildSetRecoveryWait(): Promise<ServerRequest> {
    return unsupported();
  }
  async buildRevokeRecoveryCode(): Promise<ServerRequest> {
    return unsupported();
  }
  async startRecoveryClaim(): Promise<{ request: ServerRequest }> {
    return {
      request: {
        method: 'POST',
        path: '/v1/recovery-claims',
        body: {
          accountId: fakeId(),
          rcId: fakeB64(16),
          authRC: fakeB64(32),
          device: {
            deviceId: fakeId(),
            type: 'mobile',
            platform: 'ios',
            signPub: fakeB64(65),
            adminPub: fakeB64(65),
          },
        },
      },
    };
  }
  async rememberRecoveryClaim(p: { claimId: string; claimToken: string; availableAt: string }) {
    this.claim = {
      claimId: p.claimId,
      availableAt: p.availableAt,
      serverUrl: 'https://vault.example.com',
    };
  }
  async getPendingRecoveryClaim() {
    return this.claim;
  }
  async buildCompleteRecoveryClaim(): Promise<ServerRequest> {
    if (!this.claim) throw new VaultCoreError('E_NOT_FOUND');
    return {
      method: 'POST',
      path: `/v1/recovery-claims/${this.claim.claimId}/complete`,
      body: {},
      headers: { Authorization: `Claim ${fakeB64(32)}` },
    };
  }
  async completeRecoveryClaim(response: { accountName: string }) {
    this.account = {
      accountId: fakeId(),
      accountName: response.accountName,
      serverUrl: this.claim?.serverUrl ?? 'https://vault.example.com',
      deviceId: fakeId(),
    };
    this.claim = null;
    this.setState('unlocked');
  }
  async setMasterPasswordAfterCodeRecovery(next: string): Promise<ServerRequest> {
    this.password = next;
    return {
      method: 'PUT',
      path: '/v1/keyset',
      body: { keyset: { ...fakeKeyset(), keysetVersion: 2 }, verifier: fakeB64(32) },
    };
  }
  async abandonRecoveryClaim() {
    this.claim = null;
  }
  async buildCancelRecoveryClaim(): Promise<ServerRequest> {
    return unsupported();
  }
  async buildApproveRecoveryClaimNow(): Promise<ServerRequest> {
    return unsupported();
  }

  // ---- backup, settings, autofill
  async exportVault(): Promise<{ fileUri: string }> {
    return unsupported();
  }
  async deleteExportFile(): Promise<void> {}
  async inspectImport(): Promise<{ itemCount: number; conflictCount: number }> {
    return unsupported();
  }
  async importVault(): Promise<{ added: number; updated: number }> {
    return unsupported();
  }
  async inspectCsvImport(): Promise<never> {
    return unsupported();
  }
  async importCsv(): Promise<{ added: number; skipped: number }> {
    return unsupported();
  }
  async getBackupInfo() {
    return { lastExportAt: null };
  }
  async listTrustedBrowsers() {
    return [];
  }
  async addTrustedBrowser(): Promise<void> {
    return unsupported();
  }
  async removeTrustedBrowser(): Promise<void> {
    return unsupported();
  }
  async getSettings() {
    return this.settings;
  }
  async updateSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
  }
  async getAutofillStatus() {
    return { supported: true, enabled: false, textInsertionSupported: true };
  }
  async requestEnableAutofill() {
    return false;
  }
}
