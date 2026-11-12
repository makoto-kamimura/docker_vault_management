// Settings logic as plain functions (testable without React).
import { type Settings, type VaultCore, VaultCoreError } from '@localvault/core';
import { FLAGS, type FlagStore } from '../../lib/flagStore';

export async function readBiometricsEnabled(core: VaultCore, store: FlagStore): Promise<boolean> {
  const flag = await store.get<boolean>(FLAGS.biometricsOn);
  if (flag !== null) return flag;
  // VaultCore has no "is enabled" getter (reported); until a flag exists, availability is the best guess.
  return (await core.getBiometricAvailability()).available;
}

export type BiometricsOutcome = { ok: true } | { ok: false; reason: 'invalidated' | 'failed' };

export async function setBiometrics(
  core: VaultCore,
  store: FlagStore,
  on: boolean,
): Promise<BiometricsOutcome> {
  try {
    if (on) await core.enableBiometrics();
    else await core.disableBiometrics();
    await store.set(FLAGS.biometricsOn, on);
    return { ok: true };
  } catch (e) {
    if (e instanceof VaultCoreError && e.code === 'E_BIOMETRY_INVALIDATED') {
      await store.set(FLAGS.biometricsOn, false);
      return { ok: false, reason: 'invalidated' };
    }
    if (e instanceof VaultCoreError && e.code === 'E_AUTH_CANCELED')
      return { ok: false, reason: 'failed' };
    throw e;
  }
}

/** FR-13: biometric set changed -> drop the old binding and enrol again. */
export async function reenrollBiometrics(
  core: VaultCore,
  store: FlagStore,
): Promise<BiometricsOutcome> {
  await core.disableBiometrics().catch(() => undefined);
  return setBiometrics(core, store, true);
}

export async function patchSettings(core: VaultCore, patch: Partial<Settings>): Promise<Settings> {
  await core.updateSettings(patch);
  return core.getSettings();
}
