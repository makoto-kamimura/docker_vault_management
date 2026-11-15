// Account operations (FR-101..104, §8.10, FR-111) as plain async functions.
import type { VaultCore } from '@localvault/core';
import { ApiError } from '@localvault/protocol';
import type { ApiClient } from '../../api';

type Deps = { core: VaultCore; api: ApiClient };

/** FR-101. VaultCore re-derives with the current password (E_WRONG_PASSWORD otherwise). */
export async function changeMasterPasswordFlow(
  { core, api }: Deps,
  current: string,
  next: string,
): Promise<void> {
  const request = await core.changeMasterPassword(current, next);
  await api.sendServerRequest(request);
  await core.confirmKeysetAccepted();
}

/** FR-102: returns the NEW recovery key; the old one stops working. */
export async function regenerateRecoveryKeyFlow(
  { core, api }: Deps,
  masterPassword: string,
): Promise<string> {
  const { request, recoveryKey } = await core.regenerateRecoveryKey(masterPassword);
  await api.sendServerRequest(request);
  await core.confirmKeysetAccepted();
  return recoveryKey;
}

/** §8.10 / FR-14: the user is unlocked (biometrics) and sets a new master password via the key. */
export async function resetMasterPasswordFlow(
  { core, api }: Deps,
  recoveryKey: string,
  next: string,
): Promise<void> {
  const request = await core.resetMasterPassword(recoveryKey, next);
  await api.sendServerRequest(request);
  await core.confirmKeysetAccepted();
}

/** Account name check for the delete confirmation (the same canonical form the server uses). */
export function accountNameMatches(typed: string, accountName: string): boolean {
  return (
    typed.trim().normalize('NFKC').toLowerCase() === accountName.normalize('NFKC').toLowerCase()
  );
}

/** FR-104: server data first, then the local wipe. Both proofs are built inside VaultCore. */
export async function deleteAccountFlow(
  { core, api }: Deps,
  masterPassword: string,
): Promise<void> {
  const request = await core.buildDeleteAccount(masterPassword);
  await api.sendServerRequest(request);
  await core.wipeLocal();
}

/** FR-111 / G2. An already-revoked device (E_DEVICE_REVOKED) can still wipe itself. */
export async function signOutFlow({ core, api }: Deps): Promise<void> {
  const requests = await core.buildSignOutDevice();
  try {
    for (const r of requests) await api.sendServerRequest(r);
  } catch (e) {
    const gone =
      e instanceof ApiError && (e.code === 'E_DEVICE_REVOKED' || e.code === 'E_ACCOUNT_DELETED');
    if (!gone) throw e;
  }
  await core.wipeLocal();
}

/** Kit data for FR-103: the same recovery key, the account's server and name. */
export async function loadEmergencyKit(core: VaultCore) {
  const info = await core.getAccountInfo();
  const recoveryKey = await core.getRecoveryKey();
  return { serverUrl: info.serverUrl, accountName: info.accountName, recoveryKey };
}
