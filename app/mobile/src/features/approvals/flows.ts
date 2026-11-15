// PC unlock approval (§8.4, phone side) as plain async functions over VaultCore + API.
import {
  type PendingUnlockRequest,
  type VaultCore,
  VaultCoreError,
  type VerifyUnlockResult,
} from '@localvault/core';
import type { ApiClient } from '../../api';

export type ApprovalDeps = {
  core: VaultCore;
  api: ApiClient;
  /** §8.4 check 1: sync before verifying so the trust list is current. Failures are tolerated. */
  syncFirst?: () => Promise<void>;
};

export type LoadedRequest =
  | { status: 'ready'; request: PendingUnlockRequest; deviceName: string }
  | { status: 'expired' }
  /** Handled elsewhere (approved/denied on another phone) or never existed. */
  | { status: 'gone' }
  | { status: 'invalid'; reason: Extract<VerifyUnlockResult, { ok: false }>['reason'] };

export async function loadUnlockRequest(
  deps: ApprovalDeps,
  requestId: string,
  nowMs: number = Date.now(),
): Promise<LoadedRequest> {
  await deps.syncFirst?.().catch(() => undefined);
  const { requests } = await deps.api.call('pendingUnlockRequests');
  const request = requests.find((r) => r.requestId === requestId);
  if (!request) return { status: 'gone' };
  if (Date.parse(request.expiresAt) <= nowMs) return { status: 'expired' };
  const verdict = await deps.core.verifyUnlockRequest(request);
  if (!verdict.ok) return { status: 'invalid', reason: verdict.reason };
  return { status: 'ready', request, deviceName: verdict.deviceName };
}

export type ApproveOutcome =
  | { status: 'approved' }
  | { status: 'mismatch'; attemptsLeft: number }
  /** Three wrong numbers: the request was rejected. */
  | { status: 'denied-after-mismatch' };

export async function denyUnlockRequest(deps: ApprovalDeps, requestId: string): Promise<void> {
  await deps.api.call('denyUnlockRequest', { params: { id: requestId }, body: {} });
}

/** Biometric prompt happens inside `approveUnlock`; auth errors propagate to the caller. */
export async function approveUnlockRequest(
  deps: ApprovalDeps,
  request: PendingUnlockRequest,
  typedCode: string,
): Promise<ApproveOutcome> {
  let built: Awaited<ReturnType<VaultCore['approveUnlock']>>;
  try {
    built = await deps.core.approveUnlock({ request, typedCode });
  } catch (e) {
    if (e instanceof VaultCoreError && e.code === 'E_CODE_MISMATCH') {
      const attemptsLeft = e.details?.attemptsLeft ?? 0;
      if (attemptsLeft <= 0) {
        await denyUnlockRequest(deps, request.requestId);
        return { status: 'denied-after-mismatch' };
      }
      return { status: 'mismatch', attemptsLeft };
    }
    throw e;
  }
  await deps.api.sendServerRequest(built);
  return { status: 'approved' };
}

/** Things waiting for the user: unlock requests plus open recovery claims (list banner). */
export async function countPending(
  api: ApiClient,
): Promise<{ unlock: number; claims: number; firstRoute: string | null }> {
  const [u, c] = await Promise.all([
    api.call('pendingUnlockRequests').then((r) => r.requests),
    api.call('pendingRecoveryClaims').then((r) => r.claims.filter((x) => x.status === 'waiting')),
  ]);
  const firstRoute = u[0]
    ? `/approve/${u[0].requestId}`
    : c[0]
      ? `/recovery-claim/${c[0].claimId}`
      : null;
  return { unlock: u.length, claims: c.length, firstRoute };
}
