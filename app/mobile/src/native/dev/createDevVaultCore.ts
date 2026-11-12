// Development VaultCore: `@localvault/vault-engine` (the TypeScript reference implementation)
// running on React Native dependencies from this directory. Loaded through a dynamic import from
// native/VaultCore.ts, only when __DEV__ and EXPO_PUBLIC_LV_DEV_CORE=1, so production bundles
// never contain the engine. NOT a security boundary: see keystore.ts / clipboard.ts.
import {
  createNobleProvider,
  type VaultCore,
  type VaultCoreEventName,
  type VaultCoreEvents,
} from '@localvault/core';
import { createVaultEngine } from '@localvault/vault-engine';
import { AppState, Platform } from 'react-native';
import { startDevAutomation } from './automation';
import { DevBiometric } from './biometric';
import { DevClipboard } from './clipboard';
import { DevFiles } from './files';
import { DevKeystore } from './keystore';
import { FileStorage } from './storage';
import { FileTrustedBrowsers } from './trustedBrowsers';

export type DevVaultCoreHandle = {
  core: VaultCore;
  on: <E extends VaultCoreEventName>(
    event: E,
    listener: (payload: VaultCoreEvents[E]) => void,
  ) => () => void;
};

export async function createDevVaultCore(): Promise<DevVaultCoreHandle> {
  const biometric = new DevBiometric();
  const engine = createVaultEngine({
    // Long ticks: Hermes (debug, no JIT) needs minutes for PBKDF2 at 600k iterations; fewer yields = faster.
    crypto: createNobleProvider({ pbkdf2AsyncTick: 100 }),
    storage: new FileStorage(),
    keystore: new DevKeystore(biometric),
    biometric,
    clipboard: new DevClipboard(),
    files: new DevFiles(),
    clock: { now: () => new Date() },
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    trustedBrowsers: new FileTrustedBrowsers(),
    allowInsecureLocalhost: true, // G11: this file is development-only
    deviceName: Platform.OS === 'android' ? 'Android (dev)' : 'iPhone (dev)',
  });

  // FR-11 bookkeeping lives in the engine in the dev core; the native module watches the lifecycle itself.
  AppState.addEventListener('change', (next) => {
    void (next === 'active' ? engine.onForeground() : engine.onBackground()).catch(() => undefined);
  });
  // §7.6: purge trash older than 30 days after each unlock.
  engine.on('onLockStateChange', ({ state }) => {
    if (state === 'unlocked') void engine.purgeExpiredTrash().catch(() => undefined);
  });

  startDevAutomation(engine, biometric);
  return { core: engine, on: (event, listener) => engine.on(event, listener) };
}
