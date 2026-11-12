// Development VaultCore (JS reference implementation). The next wave connects this to
// `@localvault/vault-engine` (with `createNobleProvider()` from @localvault/core; the
// `getRandomValues` source is installed by src/polyfills.ts). Loaded through a dynamic import from
// native/VaultCore.ts, only when __DEV__ and EXPO_PUBLIC_LV_DEV_CORE=1.
import type { VaultCore } from '@localvault/core';

export type DevVaultCoreHandle = {
  core: VaultCore;
  on: <E extends 'onLockStateChange' | 'onVaultChanged' | 'onSyncNeeded'>(
    event: E,
    listener: (payload: import('@localvault/core').VaultCoreEvents[E]) => void,
  ) => () => void;
};

export async function createDevVaultCore(): Promise<DevVaultCoreHandle> {
  throw new Error('Development VaultCore is not wired yet (next wave: @localvault/vault-engine).');
}
