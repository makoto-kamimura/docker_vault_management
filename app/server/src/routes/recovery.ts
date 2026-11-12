import { type ErrorCode, TTL_SEC } from '@localvault/protocol';
import { writeAudit } from '../audit';
import { issueAccessToken } from '../auth/token';
import { constantTimeEqual, fromB64, newId, randomB64, sha256 } from '../crypto';
import type { Tx } from '../db/client';
import type { ClaimStatus } from '../db/schema';
import type { Deps } from '../deps';
import { fail } from '../errors';
import { notifyApprovers } from '../push';
import {
  assertDeviceIdFree,
  assertValidPublicKey,
  insertDevice,
  iso,
  keysetOf,
  lockAccount,
} from './common';
import type { Registrar } from './define';
import { invalidateRecoveryCode } from './rotations';

/** A waiting claim that was not completed within 7 days of availableAt is expired (lazily and by the job). */
export function effectiveStatus(status: ClaimStatus, availableAt: Date, now: Date): ClaimStatus {
  if (
    status === 'waiting' &&
    now.getTime() > availableAt.getTime() + TTL_SEC.recoveryClaimExpiry * 1000
  ) {
    return 'expired';
  }
  return status;
}

function pushTo(
  deps: Deps,
  accountId: string,
  payload: Parameters<typeof notifyApprovers>[4],
  ttlSec: number,
) {
  deps.tasks.run(notifyApprovers(deps.db, deps.push, deps.log, accountId, payload, { ttlSec }));
}

export function registerRecoveryRoutes(r: Registrar): void {
  r.handle('getRecoveryCode', async ({ deps, auth }) => {
    const row = await deps.db
      .selectFrom('recovery_codes')
      .selectAll()
      .where('account_id', '=', auth.device.accountId)
      .executeTakeFirst();
    if (!row) return { enabled: false as const };
    return {
      enabled: true as const,
      createdAt: iso(row.created_at),
      waitSec: row.wait_sec as 86400 | 172800 | 259200,
      frozen: row.frozen_at !== null,
    };
  });

  r.handle('putRecoveryCode', async ({ deps, now, auth, body }) => {
    await deps.db.transaction().execute(async (trx) => {
      const acc = await lockAccount(trx, auth.device.accountId);
      if (body.vkVersion !== acc.vk_version)
        fail('E_STALE_KEY', 'vkVersion is not the current one');
      await invalidateRecoveryCode(trx, acc.id); // old code and its open claims die
      await trx
        .insertInto('recovery_codes')
        .values({
          account_id: acc.id,
          rc_id: fromB64(body.rcId),
          verifier: fromB64(body.verifier),
          wrapped_vk: body.wrappedVK,
          vk_version: body.vkVersion,
          wait_sec: body.waitSec,
          frozen_at: null,
          created_at: now,
        })
        .execute();
      await writeAudit(trx, acc.id, auth.device.id, 'rc_issued', now);
    });
    return undefined;
  });

  r.handle('putRecoveryWaitPeriod', async ({ deps, auth, body }) => {
    const u = await deps.db
      .updateTable('recovery_codes')
      .set({ wait_sec: body.waitSec })
      .where('account_id', '=', auth.device.accountId)
      .executeTakeFirst();
    if (u.numUpdatedRows === 0n) fail('E_NOT_FOUND', 'no recovery code');
    return undefined;
  });

  r.handle('deleteRecoveryCode', async ({ deps, now, auth }) => {
    await deps.db.transaction().execute(async (trx) => {
      const acc = await lockAccount(trx, auth.device.accountId);
      if (await invalidateRecoveryCode(trx, acc.id)) {
        await writeAudit(trx, acc.id, auth.device.id, 'rc_revoked', now);
      }
    });
    return undefined;
  });

  // §8.11.4. authRC is verified here: it is in the body, together with the account lookup.
  r.handle('createRecoveryClaim', async ({ deps, now, body }) => {
    assertValidPublicKey(body.device.signPub, 'device.signPub');
    assertValidPublicKey(body.device.adminPub as string, 'device.adminPub');
    const claimToken = randomB64(32);
    const claimId = newId();
    const result = await deps.db.transaction().execute(async (trx: Tx) => {
      const acc = await trx
        .selectFrom('accounts')
        .select(['id', 'name'])
        .where('id', '=', body.accountId)
        .forUpdate()
        .executeTakeFirst();
      const code = acc
        ? await trx
            .selectFrom('recovery_codes')
            .selectAll()
            .where('account_id', '=', acc.id)
            .executeTakeFirst()
        : undefined;
      const stored = code?.verifier ?? Buffer.alloc(32);
      const okAuth = constantTimeEqual(sha256(fromB64(body.authRC)), stored);
      const okId = constantTimeEqual(fromB64(body.rcId), code?.rc_id ?? Buffer.alloc(16));
      if (!acc || !code || !okAuth || !okId) return { error: 'unauthorized' as const };
      if (code.frozen_at !== null) return { error: 'frozen' as const };
      await assertDeviceIdFree(trx, body.device.deviceId);

      const open = await trx
        .selectFrom('recovery_claims')
        .select(['id', 'available_at', 'status'])
        .where('account_id', '=', acc.id)
        .where('status', '=', 'waiting')
        .execute();
      const live = open.filter((c) => effectiveStatus(c.status, c.available_at, now) === 'waiting');
      const dispute = live.length > 0;
      const availableAt = new Date(now.getTime() + code.wait_sec * 1000);
      await trx
        .insertInto('recovery_claims')
        .values({
          id: claimId,
          account_id: acc.id,
          rc_id: code.rc_id,
          claim_token_hash: sha256(fromB64(claimToken)),
          device: JSON.stringify({
            deviceId: body.device.deviceId,
            platform: body.device.platform,
            signPub: body.device.signPub,
            adminPub: body.device.adminPub,
          }),
          status: dispute ? 'disputed' : 'waiting',
          available_at: availableAt,
          created_at: now,
        })
        .execute();
      await writeAudit(trx, acc.id, body.device.deviceId, 'rc_claimed', now);
      if (dispute) {
        // §8.11.6: both claims become disputed and the code is frozen.
        await trx
          .updateTable('recovery_claims')
          .set({ status: 'disputed' })
          .where('account_id', '=', acc.id)
          .where('status', '=', 'waiting')
          .execute();
        await trx
          .updateTable('recovery_codes')
          .set({ frozen_at: now })
          .where('account_id', '=', acc.id)
          .execute();
        await writeAudit(trx, acc.id, null, 'rc_frozen', now);
      }
      return {
        ok: { accountId: acc.id, name: acc.name, availableAt, dispute, waitSec: code.wait_sec },
      };
    });
    if ('error' in result) {
      if (result.error === 'frozen') return fail('E_RC_FROZEN', 'recovery code is frozen');
      return fail('E_UNAUTHORIZED', 'authentication failed');
    }
    const { ok } = result;
    if (ok.dispute) pushTo(deps, ok.accountId, { t: 'rc_frozen' }, 86_400);
    else pushTo(deps, ok.accountId, { t: 'rc_claim', r: claimId }, ok.waitSec);
    return {
      claimId,
      claimToken,
      availableAt: iso(ok.availableAt),
      accountName: ok.name,
    };
  });

  r.handle('pendingRecoveryClaims', async ({ deps, now, auth }) => {
    const rows = await deps.db
      .selectFrom('recovery_claims')
      .select(['id', 'created_at', 'available_at', 'status'])
      .where('account_id', '=', auth.device.accountId)
      .where('status', 'in', ['waiting', 'disputed'])
      .orderBy('created_at')
      .execute();
    return {
      claims: rows
        .map((c) => ({ ...c, eff: effectiveStatus(c.status, c.available_at, now) }))
        .filter((c) => c.eff === 'waiting' || c.eff === 'disputed')
        .map((c) => ({
          claimId: c.id,
          createdAt: iso(c.created_at),
          availableAt: iso(c.available_at),
          status: c.eff,
        })),
    };
  });

  r.handle('getRecoveryClaim', async ({ now, auth }) => ({
    status: effectiveStatus(auth.claim.status, auth.claim.availableAt, now),
    availableAt: iso(auth.claim.availableAt),
  }));

  r.handle('completeRecoveryClaim', async ({ deps, now, auth }) => {
    const claim = auth.claim;
    type Done = {
      acc: Awaited<ReturnType<typeof lockAccount>>;
      code: { wrapped_vk: { nonce: string; ct: string }; vk_version: number };
      deviceId: string;
    };
    type Outcome = { error?: readonly [ErrorCode, string]; waiting?: Date; done?: Done };
    const outcome: Outcome = await deps.db.transaction().execute(async (trx): Promise<Outcome> => {
      const acc = await lockAccount(trx, claim.accountId);
      const cur = await trx
        .selectFrom('recovery_claims')
        .selectAll()
        .where('id', '=', claim.id)
        .executeTakeFirstOrThrow();
      const status = effectiveStatus(cur.status, cur.available_at, now);
      if (status === 'expired' && cur.status === 'waiting') {
        await trx
          .updateTable('recovery_claims')
          .set({ status: 'expired' })
          .where('id', '=', cur.id)
          .execute();
        return { error: ['E_CLAIM_CLOSED', 'claim expired'] as const };
      }
      if (status === 'disputed')
        return { error: ['E_RC_FROZEN', 'recovery code is frozen'] as const };
      if (status !== 'waiting') return { error: ['E_CLAIM_CLOSED', 'claim is closed'] as const };
      const code = await trx
        .selectFrom('recovery_codes')
        .selectAll()
        .where('account_id', '=', acc.id)
        .executeTakeFirst();
      if (!code) return { error: ['E_CLAIM_CLOSED', 'recovery code no longer exists'] as const };
      if (code.frozen_at !== null)
        return { error: ['E_RC_FROZEN', 'recovery code is frozen'] as const };
      if (now.getTime() < cur.available_at.getTime()) {
        return { waiting: cur.available_at };
      }
      const d = cur.device;
      await assertDeviceIdFree(trx, d.deviceId);
      await insertDevice(trx, {
        id: d.deviceId,
        accountId: acc.id,
        kind: 'mobile',
        platform: d.platform,
        signPub: fromB64(d.signPub),
        adminPub: d.adminPub ? fromB64(d.adminPub) : null,
        now,
      });
      // One shot: the code is deleted, every other open claim is closed.
      await invalidateRecoveryCode(trx, acc.id);
      await trx
        .updateTable('recovery_claims')
        .set({ status: 'completed' })
        .where('id', '=', cur.id)
        .execute();
      await writeAudit(trx, acc.id, d.deviceId, 'rc_used', now);
      return { done: { acc, code, deviceId: d.deviceId } };
    });
    if (outcome.error) return fail(outcome.error[0], outcome.error[1]);
    if (outcome.waiting) {
      return fail('E_CLAIM_WAITING', 'claim is in its waiting period', {
        availableAt: iso(outcome.waiting),
      });
    }
    const { acc, code, deviceId } = outcome.done as Done;
    const token = await issueAccessToken(deps.config.tokenSecret, deps.clock, {
      deviceId,
      accountId: acc.id,
      kind: 'mobile',
    });
    return {
      accessToken: token.accessToken,
      accountName: acc.name,
      keyset: keysetOf(acc),
      wrappedVK: code.wrapped_vk,
      vkVersion: code.vk_version,
    };
  });

  r.handle('cancelRecoveryClaim', async ({ deps, now, auth, params }) => {
    await deps.db.transaction().execute(async (trx) => {
      const acc = await lockAccount(trx, auth.device.accountId);
      const c = await trx
        .selectFrom('recovery_claims')
        .selectAll()
        .where('id', '=', params.id)
        .where('account_id', '=', acc.id)
        .executeTakeFirst();
      if (!c) fail('E_NOT_FOUND', 'claim not found');
      const st = effectiveStatus(c.status, c.available_at, now);
      if (st !== 'waiting' && st !== 'disputed') fail('E_ALREADY_HANDLED', 'claim is closed');
      await invalidateRecoveryCode(trx, acc.id); // cancels this and every other open claim
      await writeAudit(trx, acc.id, auth.device.id, 'rc_canceled', now);
    });
    return undefined;
  });

  r.handle('approveRecoveryClaimNow', async ({ deps, now, auth, params }) => {
    await deps.db.transaction().execute(async (trx) => {
      const acc = await lockAccount(trx, auth.device.accountId);
      const c = await trx
        .selectFrom('recovery_claims')
        .selectAll()
        .where('id', '=', params.id)
        .where('account_id', '=', acc.id)
        .executeTakeFirst();
      if (!c) fail('E_NOT_FOUND', 'claim not found');
      const st = effectiveStatus(c.status, c.available_at, now);
      if (st === 'disputed') fail('E_RC_FROZEN', 'recovery code is frozen');
      if (st !== 'waiting') fail('E_CLAIM_CLOSED', 'claim is closed');
      if (c.available_at.getTime() > now.getTime()) {
        await trx
          .updateTable('recovery_claims')
          .set({ available_at: now })
          .where('id', '=', c.id)
          .execute();
      }
      await writeAudit(trx, acc.id, auth.device.id, 'rc_approved_now', now);
    });
    return undefined;
  });
}
