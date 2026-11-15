// Settings logic as plain functions (testable without React).
import { type Settings, type VaultCore, VaultCoreError } from '@localvault/core';

export type BiometricsOutcome = { ok: true } | { ok: false; reason: 'invalidated' | 'failed' };

export async function setBiometrics(core: VaultCore, on: boolean): Promise<BiometricsOutcome> {
  try {
    if (on) await core.enableBiometrics();
    else await core.disableBiometrics();
    return { ok: true };
  } catch (e) {
    if (e instanceof VaultCoreError && e.code === 'E_BIOMETRY_INVALIDATED') {
      return { ok: false, reason: 'invalidated' };
    }
    if (e instanceof VaultCoreError && e.code === 'E_AUTH_CANCELED')
      return { ok: false, reason: 'failed' };
    throw e;
  }
}

/** FR-13: biometric set changed -> drop the old binding and enrol again. */
export async function reenrollBiometrics(core: VaultCore): Promise<BiometricsOutcome> {
  await core.disableBiometrics().catch(() => undefined);
  return setBiometrics(core, true);
}

export async function patchSettings(core: VaultCore, patch: Partial<Settings>): Promise<Settings> {
  await core.updateSettings(patch);
  return core.getSettings();
}
