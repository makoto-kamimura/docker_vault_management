// Build-time flags. `process.env.EXPO_PUBLIC_*` must be referenced literally so Metro can inline it.

export const isDev: boolean = typeof __DEV__ !== 'undefined' && __DEV__;

/** Development VaultCore backed by @localvault/vault-engine (dev builds only). */
export const devCoreEnabled: boolean = isDev && process.env.EXPO_PUBLIC_LV_DEV_CORE === '1';

/** In-memory FakeVaultCore + fake server (dev builds only; screenshots and visual checks). */
export const fakeCoreEnabled: boolean = isDev && process.env.EXPO_PUBLIC_LV_FAKE_CORE === '1';

/** FakeVaultCore starts locked (visual check of /unlock). */
export const fakeStartLocked: boolean =
  fakeCoreEnabled && process.env.EXPO_PUBLIC_LV_FAKE_LOCKED === '1';

/** Visual checks: route opened right after boot (FakeVaultCore only). */
export const fakeStartRoute: string | null = fakeCoreEnabled
  ? (process.env.EXPO_PUBLIC_LV_FAKE_ROUTE ?? null)
  : null;

/** G11 / §5.11: http://localhost etc. are accepted in development builds only. */
export const allowInsecureLocalhost: boolean = isDev;

export const syncConfig = {
  /** §7.8: pushes after a save are coalesced for one second. */
  saveDebounceMs: 1000,
  /** §7.8: periodic sync while in the foreground. */
  intervalMs: 5 * 60 * 1000,
  /** §7.8: retry back-off 5 s, doubling, capped at 5 min. */
  backoffBaseMs: 5000,
  backoffMaxMs: 5 * 60 * 1000,
} as const;
