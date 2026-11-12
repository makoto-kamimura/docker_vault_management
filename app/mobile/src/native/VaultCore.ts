// The single access point for VaultCore. Resolution order (spec §15, brief W3c):
//   1. the native Expo module `LocalVaultCore`, when present;
//   2. dev builds only: FakeVaultCore when EXPO_PUBLIC_LV_FAKE_CORE=1 (screens without a server);
//   3. dev builds only: the development core when EXPO_PUBLIC_LV_DEV_CORE=1 (dynamic import);
//   4. otherwise: a clear error.
import type { VaultCore, VaultCoreEventName, VaultCoreEvents } from '@localvault/core';
import { requireOptionalNativeModule } from 'expo';
import { devCoreEnabled, fakeCoreEnabled, fakeStartLocked } from '../env';

export type VaultCoreListener<E extends VaultCoreEventName> = (payload: VaultCoreEvents[E]) => void;

export type VaultCoreHandle = {
  core: VaultCore;
  /** Subscribe to a VaultCore event; returns the unsubscribe function. */
  on<E extends VaultCoreEventName>(event: E, listener: VaultCoreListener<E>): () => void;
  kind: 'native' | 'fake' | 'dev';
  /** Replacement for `fetch` (FakeVaultCore only: an in-memory server). */
  fetch?: typeof fetch;
};

type NativeCoreModule = VaultCore & {
  addListener<E extends VaultCoreEventName>(
    event: E,
    listener: VaultCoreListener<E>,
  ): { remove(): void };
};

let handlePromise: Promise<VaultCoreHandle> | null = null;
let current: VaultCoreHandle | null = null;

async function resolveHandle(): Promise<VaultCoreHandle> {
  const native = requireOptionalNativeModule<NativeCoreModule>('LocalVaultCore');
  if (native) {
    return {
      kind: 'native',
      core: native,
      on: (event, listener) => {
        const sub = native.addListener(event, listener);
        return () => sub.remove();
      },
    };
  }
  if (fakeCoreEnabled) {
    const [{ FakeVaultCore }, { createFakeFetch }] = await Promise.all([
      import('./fake/FakeVaultCore'),
      import('./fake/fakeFetch'),
    ]);
    const fake = new FakeVaultCore({
      lockState: fakeStartLocked ? 'locked' : 'uninitialized',
      masterPassword: 'correct horse battery',
      biometrics: 'faceId',
    });
    return {
      kind: 'fake',
      core: fake,
      on: (e, l) => fake.on(e, l),
      fetch: createFakeFetch(),
    };
  }
  if (devCoreEnabled) {
    const { createDevVaultCore } = await import('./dev/createDevVaultCore');
    const dev = await createDevVaultCore();
    return { kind: 'dev', core: dev.core, on: dev.on };
  }
  throw new Error(
    'LocalVault core is not available: the native module "LocalVaultCore" is missing. ' +
      'In a development build set EXPO_PUBLIC_LV_DEV_CORE=1 (or EXPO_PUBLIC_LV_FAKE_CORE=1 for screens only).',
  );
}

/** Resolves (once) and returns the VaultCore handle. */
export function loadVaultCore(): Promise<VaultCoreHandle> {
  handlePromise ??= resolveHandle().then((h) => {
    current = h;
    return h;
  });
  return handlePromise;
}

/** Synchronous access after `loadVaultCore()` resolved (throws before that). */
export function getVaultCore(): VaultCore {
  if (!current) throw new Error('VaultCore accessed before loadVaultCore() resolved');
  return current.core;
}

export function getVaultCoreHandle(): VaultCoreHandle {
  if (!current) throw new Error('VaultCore accessed before loadVaultCore() resolved');
  return current;
}
