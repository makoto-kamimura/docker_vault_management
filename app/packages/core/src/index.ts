// @localvault/core — API style: every function that needs cryptography takes the CryptoProvider as
// its FIRST argument (no factory, no global state). `defaultProvider()` picks WebCrypto when
// available. The bundled public suffix list is NOT imported here: use `@localvault/core/psl-data`.
export * from './bytes';
export * from './conflict';
export * from './crypto';
export * from './csv-import';
export * from './errors';
export * from './export-file';
export * from './generator';
export * from './keys';
export * from './matcher/match';
export * from './matcher/psl';
export * from './matcher/punycode';
export * from './records';
export * from './recovery-code';
export * from './recovery-key';
export * from './seal';
export * from './search';
export * from './signing';
export * from './throttle';
export type {
  AccountInfo,
  AutoLockSec,
  ClipboardClearSec,
  CopyField,
  CsvFormatName,
  DeviceInfo,
  DeviceRegistration,
  ItemDetail,
  ItemInput,
  ItemSummary,
  LockState,
  PairingInfo,
  PcSessionMaxSec,
  PendingUnlockRequest,
  RecoveryClaimResponse,
  RecoverySheet,
  RecoveryWaitSec,
  ServerRequest,
  Settings,
  SyncState,
  TrustedBrowser,
  VaultCore,
  VaultCoreEventName,
  VaultCoreEvents,
} from './vault-core';

import { type CryptoProvider, createNobleProvider, createWebCryptoProvider } from './crypto';

let cached: CryptoProvider | undefined;

/** WebCrypto when `crypto.subtle` exists (Node, browsers, service workers), else noble (Hermes). */
export function defaultProvider(): CryptoProvider {
  cached ??=
    typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle !== undefined
      ? createWebCryptoProvider()
      : createNobleProvider();
  return cached;
}
