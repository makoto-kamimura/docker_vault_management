// Wires VaultCore, the API client, the sync engine and the zustand stores together.

import type { VaultCore } from '@localvault/core';
import { useRouter } from 'expo-router';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { type ApiClient, createApiClient, createAuthedApi, type TokenManager } from '../../api';
import { loadVaultCore, type VaultCoreHandle } from '../../native/VaultCore';
import { useLockStore } from '../../state/lockStore';
import { useSetupDraft } from '../../state/setupDraft';
import { useSyncStore } from '../../state/syncStore';
import { createSyncEngine, type SyncEngine } from '../../sync/engine';

export type Session = {
  core: VaultCore;
  /** Authenticated client for the signed-in account (server URL from `getAccountInfo`). */
  api: ApiClient;
  tokens: TokenManager;
  engine: SyncEngine;
  /** Unauthenticated client for an arbitrary origin (setup, before an account exists). */
  makeApi: (origin: string) => ApiClient;
  kind: VaultCoreHandle['kind'];
};

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

type Boot =
  | { phase: 'loading' }
  | { phase: 'ready'; session: Session }
  | { phase: 'failed'; message: string };

export function SessionProvider({
  children,
  fallback,
  failure,
}: {
  children: ReactNode;
  fallback: ReactNode;
  failure: (message: string) => ReactNode;
}) {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    let disposed = false;
    const unsubs: (() => void)[] = [];
    let engine: SyncEngine | null = null;

    (async () => {
      try {
        const handle = await loadVaultCore();
        const core = handle.core;
        const { setLockState, setStanding } = useLockStore.getState();
        const setStatus = useSyncStore.getState().setStatus;

        const makeApi = (origin: string) =>
          createApiClient({ baseUrl: () => origin, fetch: handle.fetch });
        const { api, tokens } = createAuthedApi(core, {
          baseUrl: async () => (await core.getAccountInfo()).serverUrl,
          fetch: handle.fetch,
        });

        engine = createSyncEngine({
          core,
          api,
          report: setStatus,
          onDeviceRevoked: async () => {
            // G1: lock immediately, stop syncing, show /revoked.
            await core.lock().catch(() => undefined);
            setStanding('revoked');
          },
          onAccountDeleted: async () => {
            await core.lock().catch(() => undefined);
            setStanding('accountDeleted');
          },
        });
        const eng = engine;

        unsubs.push(
          handle.on('onLockStateChange', ({ state }) => {
            const prev = useLockStore.getState().lockState;
            setLockState(state);
            if (state === 'uninitialized') {
              eng.stop();
              tokens.clear();
              setStanding('ok');
            } else if (prev === 'uninitialized' || prev === 'unknown') {
              eng.start();
            } else if (state === 'unlocked') {
              void eng.requestSync('unlock');
            }
          }),
          handle.on('onSyncNeeded', () => eng.notifySyncNeeded()),
        );

        if (handle.kind === 'fake') {
          // Visual checks only: a demo emergency kit so /setup/recovery-kit can be opened directly.
          useSetupDraft.getState().setServer('https://vault.example.com', 'open');
          useSetupDraft.getState().setAccountName('alice');
          useSetupDraft.getState().setRecoveryKey('LV2-7J4K-9PQ2-X8MD-T3VW-R5NB-H6CY-0ZEA');
        }
        const initial = await core.getLockState();
        if (disposed) return;
        setLockState(initial);
        if (initial !== 'uninitialized') eng.start();

        let backgroundedAt: number | null = null;
        const sub = AppState.addEventListener('change', (next) => {
          if (next === 'active') {
            eng.setForeground(true);
            const at = backgroundedAt;
            backgroundedAt = null;
            if (at !== null && useLockStore.getState().lockState === 'unlocked') {
              // FR-11: lock on return when the auto-lock time has passed.
              core
                .getSettings()
                .then((s) => {
                  if (Date.now() - at >= s.autoLockSec * 1000) return core.lock();
                })
                .catch(() => undefined);
            }
          } else {
            backgroundedAt ??= Date.now();
            eng.setForeground(false);
          }
        });
        unsubs.push(() => sub.remove());

        setBoot({
          phase: 'ready',
          session: { core, api, tokens, engine: eng, makeApi, kind: handle.kind },
        });
      } catch (e) {
        if (!disposed) {
          setBoot({ phase: 'failed', message: e instanceof Error ? e.message : 'unknown error' });
        }
      }
    })();

    return () => {
      disposed = true;
      for (const u of unsubs) u();
      engine?.stop();
    };
  }, []);

  const value = useMemo(() => (boot.phase === 'ready' ? boot.session : null), [boot]);
  if (boot.phase === 'loading') return <>{fallback}</>;
  if (boot.phase === 'failed') return <>{failure(boot.message)}</>;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
