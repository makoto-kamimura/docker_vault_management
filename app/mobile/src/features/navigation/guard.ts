// Route guard (spec §14 notes): locked users go to /unlock (except /approve/[requestId]),
// uninitialised users go to /setup. Pure so it can be unit-tested.
import type { LockState } from '@localvault/core';

export type DeviceStanding = 'ok' | 'revoked' | 'accountDeleted';

export type GuardInput = {
  lockState: LockState | 'unknown';
  standing: DeviceStanding;
  /** Expo Router segments, e.g. ['(setup)', 'setup', 'server']. */
  segments: readonly string[];
  /** True while the user is inside the account creation / restore flow (state may be unlocked). */
  setupInProgress: boolean;
};

const isGroup = (s: string | undefined, name: string) => s === `(${name})`;

export function resolveGuard(i: GuardInput): string | null {
  if (i.lockState === 'unknown') return null;
  const leaf = i.segments[i.segments.length - 1];
  const atRevoked = leaf === 'revoked';

  if (i.standing !== 'ok') return atRevoked ? null : '/revoked';

  const home = (): string =>
    i.lockState === 'unlocked' ? '/' : i.lockState === 'locked' ? '/unlock' : '/setup';

  if (atRevoked) return home();

  const first = i.segments[0];
  if (isGroup(first, 'setup')) {
    if (i.lockState === 'uninitialized') return null;
    if (i.lockState === 'locked') return '/unlock';
    return i.setupInProgress ? null : '/';
  }

  if (i.lockState === 'uninitialized') return '/setup';

  if (i.lockState === 'locked') {
    if (isGroup(first, 'locked')) return null;
    // Notification deep link: the approval screen asks for biometrics itself.
    if (i.segments.includes('approve')) return null;
    return '/unlock';
  }

  // unlocked
  if (isGroup(first, 'locked')) return '/';
  return null;
}
