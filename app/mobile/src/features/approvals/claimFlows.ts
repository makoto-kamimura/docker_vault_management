// Recovery-claim confirmation on an existing approver phone (§8.11.5).
import type { VaultCore } from '@localvault/core';
import type { ApiClient } from '../../api';

export type ClaimView =
  | { status: 'open'; claimId: string; createdAt: string; availableAt: string }
  | { status: 'closed'; reason: 'canceled' | 'completed' | 'expired' | 'disputed' | 'missing' };

export async function loadClaim(api: ApiClient, claimId: string): Promise<ClaimView> {
  const { claims } = await api.call('pendingRecoveryClaims');
  const c = claims.find((x) => x.claimId === claimId);
  if (!c) return { status: 'closed', reason: 'missing' };
  if (c.status === 'waiting')
    return { status: 'open', claimId, createdAt: c.createdAt, availableAt: c.availableAt };
  return { status: 'closed', reason: c.status };
}

/** "心当たりがない": cancels the claim; the server also invalidates the recovery code. */
export async function cancelClaim(core: VaultCore, api: ApiClient, claimId: string): Promise<void> {
  await api.sendServerRequest(await core.buildCancelRecoveryClaim(claimId));
}

/** "自分で使った": lets the new phone finish without waiting. */
export async function approveClaimNow(
  core: VaultCore,
  api: ApiClient,
  claimId: string,
): Promise<void> {
  await api.sendServerRequest(await core.buildApproveRecoveryClaimNow(claimId));
}
