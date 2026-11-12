// Injected dependencies of the engine. Everything platform-specific (files, Keychain / Keystore,
// biometrics, clipboard, clock) sits behind these interfaces so that the same engine runs in
// tests, in the React Native development build and as the reference for the native ports.
// No Node built-ins here: this package must run on Hermes.
import type { CryptoProvider, PublicSuffixList } from '@localvault/core';

/**
 * File-like store (App Group `vault/` directory, `noBackupFilesDir`). The engine implements the
 * write protocol of spec §6.6 on top of these primitives, so a crash between any two operations
 * is recoverable:  write `<name>.tmp` -> rename `<name>` to `<name>.bak` -> rename tmp to `<name>`.
 */
export interface Storage {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, data: Uint8Array): Promise<void>;
  /** Replaces `to` if it exists. Rejects when `from` does not exist. */
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  exists(name: string): Promise<boolean>;
}

/** Keychain / Keystore slots. `vk.bio` and `admin.key` are only readable after a biometric success. */
export type KeystoreSlot =
  | 'vk.bio'
  | 'sk'
  | 'sign.key'
  | 'admin.key'
  | 'claim'
  | 'throttle'
  | 'usage.key';

export const BIOMETRIC_GATED_SLOTS: readonly KeystoreSlot[] = ['vk.bio', 'admin.key'];

/** Opaque proof that the user just passed a biometric prompt. */
export type AuthToken = { readonly kind: 'biometric-auth' };

export interface Keystore {
  /** Gated slots reject unless `auth` came from `Biometric.authenticate`. */
  read(slot: KeystoreSlot, auth?: AuthToken): Promise<Uint8Array | null>;
  write(slot: KeystoreSlot, value: Uint8Array): Promise<void>;
  delete(slot: KeystoreSlot): Promise<void>;
}

export type BiometricKind = 'faceId' | 'touchId' | 'biometric' | 'none';

export interface Biometric {
  availability(): Promise<{ available: boolean; kind: BiometricKind }>;
  /**
   * Rejects with a `VaultCoreError` (`E_AUTH_CANCELED`, `E_AUTH_FAILED`, `E_BIOMETRY_INVALIDATED`,
   * `E_BIOMETRY_UNAVAILABLE`).
   */
  authenticate(reason: string): Promise<AuthToken>;
}

export interface Clipboard {
  /** Marks the item sensitive (no sync, no preview) and clears it after `ttlSec` (null = never). */
  setSensitive(text: string, ttlSec: number | null): Promise<void>;
}

/** Export / import / CSV files chosen or produced through the OS share sheet / file picker. */
export interface FileAccess {
  /** Writes a new file and returns its URI. */
  write(suggestedName: string, data: Uint8Array): Promise<string>;
  read(uri: string): Promise<Uint8Array>;
  delete(uri: string): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/** Android trusted-browser allow list (G8): stored on this device only. */
export interface TrustedBrowserStore {
  load(): Promise<{ packageName: string; label: string }[]>;
  save(list: { packageName: string; label: string }[]): Promise<void>;
}

export type EngineDeps = {
  crypto: CryptoProvider;
  storage: Storage;
  keystore: Keystore;
  biometric: Biometric;
  clipboard: Clipboard;
  files: FileAccess;
  clock: Clock;
  platform: 'ios' | 'android';
  trustedBrowsers?: TrustedBrowserStore;
  /** Defaults to the bundled list from `@localvault/core/psl-data`. */
  psl?: PublicSuffixList;
  /** Development builds only (G11): accept http://localhost, 127.0.0.1, 10.0.2.2. */
  allowInsecureLocalhost?: boolean;
  /** Default name for this device's record. */
  deviceName?: string;
};
