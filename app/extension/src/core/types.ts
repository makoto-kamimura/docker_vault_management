// Injected dependencies of the platform-independent core. Nothing in `core/` touches `chrome.*`,
// `indexedDB`, `fetch` or `Date` directly: everything arrives through `Env`.
import type { CryptoProvider, PublicSuffixList } from '@localvault/core';

/** The subset of `chrome.storage.StorageArea` the core needs. */
export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

/**
 * The device signing key (spec 5.6 PC column): a NON-EXTRACTABLE ECDSA P-256 `CryptoKey`. The
 * private scalar is never visible to JavaScript; only signing is possible.
 */
export interface DeviceKeyStore {
  /** Generates a fresh key pair (replacing any existing one) and returns the 65-byte public key. */
  create(): Promise<Uint8Array>;
  /** Public key of the stored key, or null when there is none. */
  getPublicKey(): Promise<Uint8Array | null>;
  /** ECDSA P-256 / SHA-256 signature, 64-byte r || s (IEEE P1363). Throws when no key exists. */
  sign(message: Uint8Array): Promise<Uint8Array>;
  delete(): Promise<void>;
}

export type BrowserName = 'chrome' | 'edge' | 'brave';

export interface Platform {
  browser: BrowserName;
  /** Human readable OS name used in the default device name, e.g. "Windows". */
  os: string;
}

export interface Env {
  local: StorageArea;
  /** `chrome.storage.session` (default access level: not readable from content scripts). */
  session: StorageArea;
  fetch: typeof fetch;
  crypto: CryptoProvider;
  clock: Clock;
  deviceKey: DeviceKeyStore;
  psl: PublicSuffixList;
  platform: Platform;
  /** Compile-time flag LV_DEV_ALLOW_HTTP (G11). Production builds pass false. */
  allowInsecureLocalhost: boolean;
}
