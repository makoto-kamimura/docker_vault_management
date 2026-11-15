// The single access point for VaultCore. Resolution order (spec §15, brief W3c):
//   1. the native Expo module `LocalVaultCore`, when present;
//   2. dev builds only: FakeVaultCore when EXPO_PUBLIC_LV_FAKE_CORE=1 (screens without a server);
//   3. dev builds only: the development core when EXPO_PUBLIC_LV_DEV_CORE=1 (dynamic import);
//   4. otherwise: a clear error.
import {
  type VaultCore,
  VaultCoreError,
  type VaultCoreErrorCode,
  type VaultCoreErrorDetails,
  type VaultCoreEventName,
  type VaultCoreEvents,
} from '@localvault/core';
import { requireOptionalNativeModule } from 'expo';
import { fakeStartLocked } from '../env';

export type VaultCoreListener<E extends VaultCoreEventName> = (payload: VaultCoreEvents[E]) => void;

export type VaultCoreHandle = {
  core: VaultCore;
  /** Subscribe to a VaultCore event; returns the unsubscribe function. */
  on<E extends VaultCoreEventName>(event: E, listener: VaultCoreListener<E>): () => void;
  kind: 'native' | 'fake' | 'dev';
  /** Replacement for `fetch` (FakeVaultCore only: an in-memory server). */
  fetch?: typeof fetch;
};

/**
 * The Expo module (modules/vault-core). Every VaultCore method goes through `call` as JSON text:
 * `{"method","args"}` in, `{"ok":true,"value"}` or `{"ok":false,"code","message","details"}` out.
 * Text keeps object key order, which matters because JS sends `JSON.stringify(request.body)` and
 * the native side signed exactly that serialization (X-LV-Admin covers the body hash).
 */
type NativeCoreModule = {
  call(json: string): Promise<string>;
  addListener<E extends VaultCoreEventName>(
    event: E,
    listener: VaultCoreListener<E>,
  ): { remove(): void };
};

type Envelope =
  | { ok: true; value: unknown }
  | { ok: false; code: VaultCoreErrorCode; message: string; details: VaultCoreErrorDetails | null };

/** A VaultCore whose every method is forwarded to the native `call` (errors become VaultCoreError). */
function nativeCore(native: NativeCoreModule): VaultCore {
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const json = JSON.stringify({ method, args: args.map((a) => (a === undefined ? null : a)) });
    const res = JSON.parse(await native.call(json)) as Envelope;
    if (!res.ok) throw new VaultCoreError(res.code, res.message, res.details ?? undefined);
    return res.value === null ? undefined : res.value;
  };
  return new Proxy({} as VaultCore, {
    get(_target, prop) {
      // Not thenable, not a React element: only plain method names are forwarded.
      if (
        typeof prop !== 'string' ||
        prop === 'then' ||
        prop === 'toJSON' ||
        prop.startsWith('$$')
      ) {
        return undefined;
      }
      return (...args: unknown[]) => call(prop, args);
    },
  });
}

let handlePromise: Promise<VaultCoreHandle> | null = null;
let current: VaultCoreHandle | null = null;

async function resolveHandle(): Promise<VaultCoreHandle> {
  const native = requireOptionalNativeModule<NativeCoreModule>('LocalVaultCore');
  if (native) {
    const core = nativeCore(native);
    // Development builds only: the shell-driven automation also works with the native core.
    if (__DEV__ && process.env.EXPO_PUBLIC_LV_DEV_AUTOMATION === '1') {
      const { startDevAutomation } = await import('./dev/automation');
      startDevAutomation(core, null);
    }
    return {
      kind: 'native',
      core,
      on: (event, listener) => {
        const sub = native.addListener(event, listener);
        return () => sub.remove();
      },
    };
  }
  // Literal `__DEV__ && process.env...` test so Metro removes the fake (and its demo password)
  // from production bundles; the `fakeCoreEnabled` constant is not folded across modules.
  if (__DEV__ && process.env.EXPO_PUBLIC_LV_FAKE_CORE === '1') {
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
  // The literal `__DEV__ && process.env...` test (not the `devCoreEnabled` constant) lets Metro fold
  // this branch away in production, so no vault-engine / dev code reaches a release bundle.
  if (__DEV__ && process.env.EXPO_PUBLIC_LV_DEV_CORE === '1') {
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
