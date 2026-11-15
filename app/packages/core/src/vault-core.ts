// The VaultCore contract — spec §15 plus every v0.4 addition (docs/spec-review.md: G2, G8, G9, G14,
// F1, F2). TYPES ONLY (plus the re-exported error class): the mobile native modules, the
// development VaultCore of the mobile app and the stateful engine all implement or consume this.
//
// Principles (spec §15):
//  - Requests that carry secrets are BUILT by VaultCore and returned as `ServerRequest`; JS only
//    sends them. The VK, KEK, SK, RC and private keys never cross into JS, except where a method
//    below says otherwise (issueRecoveryCode returns the RC sheet once; revealPassword on demand).
//  - Every method may reject with a `VaultCoreError` (see `VaultCoreErrorCode`).
//  - Methods that "require unlocked" reject with `E_LOCKED` otherwise.
import type {
  AndroidAppLink,
  EncryptedRecord,
  Kdf,
  Keyset,
  PushResult,
  RecordChange,
  UrlEntry,
  WrappedVk,
} from '@localvault/protocol';
import type { GeneratorOptions } from './generator';
import type { VerifyUnlockResult } from './signing';

export type { VaultCoreErrorCode, VaultCoreErrorDetails } from './errors';
export { VaultCoreError } from './errors';
export type { GeneratorOptions } from './generator';
export type { VerifyUnlockResult } from './signing';
export type { EncryptedRecord, Kdf, Keyset, PushResult, RecordChange, WrappedVk };

// ---------------------------------------------------------------- common types

export type LockState = 'uninitialized' | 'locked' | 'unlocked';
export type CopyField = 'username' | 'password';

/** A request VaultCore built for JS to send as-is. `headers` carries X-LV-Admin / X-LV-AuthKey. */
export type ServerRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path exactly as it must be sent, including any query string (it is part of the signature). */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export type ItemSummary = {
  id: string;
  title: string;
  username: string;
  /** Normalised hosts of the item's URLs. */
  hosts: string[];
  favorite: boolean;
  updatedAt: string;
  lastUsedAt: string | null;
  isConflictCopy: boolean;
  trashedAt: string | null;
};

export type ItemDetail = ItemSummary & {
  urls: UrlEntry[];
  androidApps: AndroidAppLink[];
  notes: string;
  createdAt: string;
  conflictOf: string | null;
  /** The password itself is never part of the detail; use `revealPassword`. */
  hasPassword: boolean;
};

export type ItemInput = {
  /** Omit to create. */
  id?: string;
  title: string;
  username: string;
  /** Omit to leave unchanged. A changed password pushes the old one onto the history (F2). */
  password?: string;
  urls: UrlEntry[];
  notes: string;
  favorite: boolean;
};

export type AutoLockSec = 0 | 30 | 60 | 300;
export type ClipboardClearSec = 30 | 60 | 120 | null;
export type PcSessionMaxSec = 0 | 900 | 3600 | 28800;
export type RecoveryWaitSec = 86400 | 172800 | 259200;

export type Settings = {
  autoLockSec: AutoLockSec;
  /** null = never clear. */
  clipboardClearSec: ClipboardClearSec;
  showUsernameBeforeAuth: boolean;
  /** Stored in the meta record and therefore synced. */
  pcSessionMaxSec: PcSessionMaxSec;
  /** Read-only through updateSettings; change via enableBiometrics / disableBiometrics. */
  biometricsEnabled: boolean;
};

export type DeviceInfo = {
  deviceId: string;
  name: string;
  type: 'mobile' | 'extension';
  platform: string;
  addedAt: string;
  /** From the trust-list record (spec §6.1). */
  addedVia: 'setup' | 'pairing' | 'recovery-key' | 'recovery-code';
  revokedAt: string | null;
  isThisDevice: boolean;
};

export type PendingUnlockRequest = {
  requestId: string;
  deviceId: string;
  expiresAt: string;
  payload: { requestNonce: string; ephPub: string; code: string; issuedAt: string; sig: string };
};

export type PairingInfo = {
  pairingId: string;
  deviceId: string;
  platform: string;
  signPub: string;
  ephPub: string;
};

export type SyncState = {
  cursor: number;
  maxSeenRev: number;
  lastSyncedAt: string | null;
  pendingCount: number;
};

export type RecoverySheet = {
  /** `lvrc:v1?s=…&a=…&c=…` */
  qr: string;
  /** `LVRC-XXXXXX-…` (54 characters in 9 groups) */
  text: string;
};

export type RecoveryClaimResponse = {
  accessToken: string;
  accountName: string;
  keyset: Keyset;
  wrappedVK: WrappedVk;
  vkVersion: number;
};

export type CsvFormatName = 'chrome' | 'safari' | 'bitwarden' | '1password';

export type TrustedBrowser = { packageName: string; label: string; builtIn: boolean };

export type AccountInfo = {
  accountId: string;
  accountName: string;
  serverUrl: string;
  deviceId: string;
};

export type DeviceRegistration = {
  deviceId: string;
  platform: string;
  signPub: string;
  adminPub: string;
};

// ---------------------------------------------------------------- the interface

export interface VaultCore {
  // ---- state and unlocking ----
  getLockState(): Promise<LockState>;
  getBiometricAvailability(): Promise<{
    available: boolean;
    kind: 'faceId' | 'touchId' | 'biometric' | 'none';
  }>;
  enableBiometrics(): Promise<void>;
  disableBiometrics(): Promise<void>;
  unlockWithBiometrics(): Promise<void>;
  /** Rejects with E_WRONG_PASSWORD (with remaining attempts) or E_THROTTLED (`retryAfterSec`). */
  unlockWithPassword(masterPassword: string): Promise<void>;
  lock(): Promise<void>;

  // ---- account ----
  /** Builds `POST /v1/accounts`; the account is only pending until `commitAccount`. */
  createAccount(p: {
    serverUrl: string;
    accountName: string;
    masterPassword: string;
    inviteCode: string;
  }): Promise<{ request: ServerRequest; recoveryKey: string }>;
  /** Call after the server accepted the account. */
  commitAccount(): Promise<void>;
  /** Call when account creation failed. */
  discardPendingAccount(): Promise<void>;
  /** base64url authKey for the recover request (derives KEK material; nothing is stored). */
  deriveAuthKey(p: {
    accountId: string;
    kdf: Kdf;
    masterPassword: string;
    recoveryKey: string;
  }): Promise<string>;
  /** Includes generating the new device's keys. */
  buildRecoverRequest(p: { accountName: string; authKey: string }): Promise<ServerRequest>;
  restoreAccount(p: {
    serverUrl: string;
    accountName: string;
    accountId: string;
    keyset: Keyset;
    masterPassword: string;
    recoveryKey: string;
  }): Promise<void>;
  signAuthChallenge(challenge: string): Promise<{ deviceId: string; sig: string }>;
  /** Biometric-gated; for re-creating the emergency kit. */
  getRecoveryKey(): Promise<string>;
  /** Builds `PUT /v1/keyset`. */
  changeMasterPassword(current: string, next: string): Promise<ServerRequest>;
  /** Only while unlocked (§8.10). Builds `PUT /v1/keyset`. */
  resetMasterPassword(recoveryKey: string, next: string): Promise<ServerRequest>;
  regenerateRecoveryKey(
    masterPassword: string,
  ): Promise<{ request: ServerRequest; recoveryKey: string }>;
  /** Call after the server accepted a keyset change. */
  confirmKeysetAccepted(): Promise<void>;
  reregisterAdminKey(masterPassword: string): Promise<ServerRequest>;
  buildDeleteAccount(masterPassword: string): Promise<ServerRequest>;
  wipeLocal(): Promise<void>;
  // v0.4
  getAccountInfo(): Promise<AccountInfo>;
  /** FR-12 counters, shared by the app and the autofill extension / auth activity (G15). */
  getThrottleState(): Promise<{ failedCount: number; retryAfterSec: number }>;
  /** JS first verifies the new server returns the same accountId and accepts device login (G14). */
  changeServerUrl(newUrl: string): Promise<void>;
  /** FR-111: `DELETE /v1/devices/{self}`; afterwards the app calls `wipeLocal`. */
  buildSignOutDevice(): Promise<ServerRequest[]>;

  // ---- items ----
  listItems(opts?: { includeTrashed?: boolean }): Promise<ItemSummary[]>;
  getItem(id: string): Promise<ItemDetail>;
  /** Only when the user explicitly asks to show the password. */
  revealPassword(id: string): Promise<string>;
  saveItem(input: ItemInput): Promise<ItemDetail>;
  trashItem(id: string): Promise<void>;
  restoreItem(id: string): Promise<void>;
  purgeItem(id: string): Promise<void>;
  resolveConflict(copyId: string, keep: 'copy' | 'original'): Promise<void>;
  unlinkAndroidApp(id: string, packageName: string): Promise<void>;
  // v0.4 (F2 / FR-28): history passwords are only handed out by reveal / copy
  getPasswordHistory(id: string): Promise<{ index: number; changedAt: string }[]>;
  revealHistoricPassword(id: string, index: number): Promise<string>;
  copyHistoricPassword(id: string, index: number): Promise<{ clearsAt: string | null }>;
  clearPasswordHistory(id: string): Promise<void>;

  // ---- copy and generate ----
  copy(id: string, field: CopyField): Promise<{ clearsAt: string | null }>;
  /** Copies arbitrary text (e.g. a generated password) with the same protections as `copy` (§5.10). */
  copyText(text: string): Promise<{ clearsAt: string | null }>;
  generatePassword(options: GeneratorOptions): Promise<string>;

  // ---- sync (JS only carries ciphertext) ----
  getSyncState(): Promise<SyncState>;
  getPendingChanges(limit: number): Promise<RecordChange[]>;
  applyPushResults(results: PushResult[]): Promise<{ conflicts: number }>;
  /**
   * Rejects with E_ROLLBACK_DETECTED when the server state went backwards (§7.5).
   * During a full resync (spec-review "サーバー実装で確定した解釈"), the caller passes
   * `fullResync: true` on EVERY page of the restart from `since=0`, and `hasMore` from the server
   * response so VaultCore knows when the restart is complete (records missing on the server are
   * removed only then).
   */
  applyPulled(p: {
    records: EncryptedRecord[];
    cursor: number;
    keyset?: Keyset;
    fullResync: boolean;
    hasMore?: boolean;
  }): Promise<{ conflicts: number; needsMasterPassword: boolean }>;
  /** After the user accepted a rollback (§7.5). */
  acceptServerState(): Promise<void>;
  /** Notices queued since the last call (also emitted as `onNotice`). */
  drainNotices(): Promise<VaultNotice[]>;

  // ---- devices and PC approval ----
  listDevices(): Promise<DeviceInfo[]>;
  renameDevice(deviceId: string, name: string): Promise<void>;
  parsePairingQr(
    qr: string,
  ): Promise<{ pairingId: string; serverOrigin: string; fingerprint: string }>;
  /** Biometric. E_FINGERPRINT_MISMATCH / E_SERVER_MISMATCH on mismatch. */
  approvePairing(p: {
    pairing: PairingInfo;
    fingerprint: string;
    name: string;
  }): Promise<ServerRequest>;
  verifyUnlockRequest(req: PendingUnlockRequest): Promise<VerifyUnlockResult>;
  /** Biometric. E_CODE_MISMATCH carries `attemptsLeft`; at 0 the caller sends a rejection. */
  approveUnlock(p: { request: PendingUnlockRequest; typedCode: string }): Promise<ServerRequest>;
  /**
   * Requests are returned in the order they must be sent. With `rotateKey`, the chain ends with
   * `POST /v1/rotations`; send it, then call `continueRotation` with the returned `rotationId`.
   * `rotateKey` needs `masterPassword` (the new keyset is wrapped with it), else
   * `E_NEEDS_MASTER_PASSWORD`. (v0.4, chunked rotation G12)
   */
  revokeDevice(p: {
    deviceId: string;
    rotateKey: boolean;
    masterPassword?: string;
  }): Promise<ServerRequest[]>;
  /** Rotation step 2: the staging uploads (`PUT …/records`, ≤ 100 each) and the admin-signed commit, in order. */
  continueRotation(rotationId: string): Promise<ServerRequest[]>;
  /** Rotation step 3: after the commit succeeded; switches to the new VK and resets the cursor. */
  confirmRotation(r: { cursor: number }): Promise<void>;
  /** Abandons a rotation (any failure before the commit succeeded). Returns the `DELETE` to send. */
  abortRotation(rotationId: string): Promise<ServerRequest>;
  /** True while a rotation was started but neither confirmed nor aborted (resume after a crash). */
  isRotationPending(): Promise<boolean>;
  getDeviceRegistration(): Promise<DeviceRegistration>;

  // ---- recovery code (§8.11) ----
  /** Biometric. The RC leaves VaultCore only in this return value; JS discards it after the sheet. */
  issueRecoveryCode(p: {
    waitSec: RecoveryWaitSec;
  }): Promise<{ request: ServerRequest; sheet: RecoverySheet }>;
  buildSetRecoveryWait(waitSec: RecoveryWaitSec): Promise<ServerRequest>;
  buildRevokeRecoveryCode(): Promise<ServerRequest>;
  /** Generates the device keys and stores the RC temporarily (this device only). */
  startRecoveryClaim(
    p: { qr: string } | { serverUrl: string; accountId: string; text: string },
  ): Promise<{ request: ServerRequest }>;
  rememberRecoveryClaim(p: {
    claimId: string;
    claimToken: string;
    availableAt: string;
  }): Promise<void>;
  getPendingRecoveryClaim(): Promise<{
    claimId: string;
    availableAt: string;
    serverUrl: string;
  } | null>;
  buildCompleteRecoveryClaim(): Promise<ServerRequest>;
  /** Unwraps the VK, stores it, and erases the temporary RC / claimToken. */
  completeRecoveryClaim(response: RecoveryClaimResponse): Promise<void>;
  /** After all records were pulled. Builds `PUT /v1/keyset`. */
  setMasterPasswordAfterCodeRecovery(next: string): Promise<ServerRequest>;
  abandonRecoveryClaim(): Promise<void>;
  /** Biometric. */
  buildCancelRecoveryClaim(claimId: string): Promise<ServerRequest>;
  /** Biometric. */
  buildApproveRecoveryClaimNow(claimId: string): Promise<ServerRequest>;

  // ---- backup, settings, autofill ----
  exportVault(exportPassword: string): Promise<{ fileUri: string }>;
  deleteExportFile(fileUri: string): Promise<void>;
  inspectImport(
    fileUri: string,
    password: string,
  ): Promise<{ itemCount: number; conflictCount: number }>;
  importVault(
    fileUri: string,
    password: string,
    strategy: 'append' | 'newer' | 'replace',
  ): Promise<{ added: number; updated: number }>;
  // v0.4 (F1 / FR-54): parsing happens inside VaultCore
  inspectCsvImport(fileUri: string): Promise<{
    format: CsvFormatName;
    itemCount: number;
    duplicateCount: number;
    skippedCount: number;
  }>;
  importCsv(
    fileUri: string,
    opts: { skipDuplicates: boolean },
  ): Promise<{ added: number; skipped: number }>;
  getBackupInfo(): Promise<{ lastExportAt: string | null }>;
  // v0.4 (G8): Android only; stored on this device, never synced
  listTrustedBrowsers(): Promise<TrustedBrowser[]>;
  addTrustedBrowser(packageName: string): Promise<void>;
  /** Built-in entries cannot be removed. */
  removeTrustedBrowser(packageName: string): Promise<void>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  getAutofillStatus(): Promise<{
    supported: boolean;
    enabled: boolean;
    textInsertionSupported: boolean;
  }>;
  requestEnableAutofill(): Promise<boolean>;
}

// ---------------------------------------------------------------- notices

/**
 * Things the user must be told about after a sync (spec §7.4 "利用者に通知する").
 * Delivered with the `onNotice` event and also queued for `drainNotices()`.
 */
export type VaultNotice =
  | { kind: 'server-edit-won'; id: string }
  | { kind: 'restored-as-new'; id: string; originalId: string }
  | { kind: 'dropped-local-edits'; count: number };

// ---------------------------------------------------------------- events

/** Event names and payloads emitted by VaultCore. */
export type VaultCoreEvents = {
  /** Lock state changed. */
  onLockStateChange: { state: LockState };
  /** After a save or after pulled records were applied (reload lists). */
  onVaultChanged: Record<string, never>;
  /** After a local save: ask the sync engine to push. */
  onSyncNeeded: Record<string, never>;
  /** A sync produced something the user must be told (see `VaultNotice`). */
  onNotice: { notice: VaultNotice };
};

export type VaultCoreEventName = keyof VaultCoreEvents;
