import { TTL_SEC, unlockSignString } from '@localvault/protocol';
import { writeAudit } from '../audit';
import { fromB64, newId, verifyEcdsaP256 } from '../crypto';
import type { Deps } from '../deps';
import { fail, isUniqueViolation } from '../errors';
import { notifyApprovers } from '../push';
import { iso } from './common';
import type { Registrar } from './define';

export function registerUnlockRoutes(r: Registrar): void {
  // §8.4
  r.handle('createUnlockRequest', async ({ deps, now, auth, body }) => {
    const dev = auth.device;
    const issuedMs = Date.parse(body.issuedAt);
    if (Math.abs(now.getTime() - issuedMs) > TTL_SEC.unlockIssuedAtWindow * 1000) {
      fail('E_CLOCK_SKEW', 'issuedAt is outside the allowed window', {
        serverTime: now.toISOString(),
      });
    }
    // The signature is checked against the key stored for this device, never a key in the request.
    const signed = unlockSignString({
      accountId: dev.accountId,
      deviceId: dev.id,
      requestNonce: body.requestNonce,
      ephPub: body.ephPub,
      code: body.code,
      issuedAt: body.issuedAt,
    });
    if (!verifyEcdsaP256(dev.signPub, signed, fromB64(body.sig))) {
      fail('E_UNAUTHORIZED', 'bad request signature');
    }
    const requestId = newId();
    const expiresAt = new Date(now.getTime() + TTL_SEC.unlockRequest * 1000);
    try {
      await deps.db
        .insertInto('unlock_requests')
        .values({
          id: requestId,
          account_id: dev.accountId,
          device_id: dev.id,
          request_nonce: fromB64(body.requestNonce),
          payload: JSON.stringify(body),
          status: 'pending',
          response: null,
          created_at: now,
          expires_at: expiresAt,
        })
        .execute();
    } catch (err) {
      if (isUniqueViolation(err)) fail('E_ALREADY_HANDLED', 'requestNonce was already used');
      throw err;
    }
    deps.tasks.run(
      notifyApprovers(
        deps.db,
        deps.push,
        deps.log,
        dev.accountId,
        { t: 'unlock', r: requestId },
        { ttlSec: TTL_SEC.unlockRequest, collapseId: requestId },
      ),
    );
    return { requestId, expiresAt: iso(expiresAt) };
  });

  r.handle('pendingUnlockRequests', async ({ deps, now, auth }) => {
    const rows = await deps.db
      .selectFrom('unlock_requests as u')
      .innerJoin('devices as d', 'd.id', 'u.device_id')
      .select(['u.id', 'u.device_id', 'u.expires_at', 'u.payload'])
      .where('u.account_id', '=', auth.device.accountId)
      .where('u.status', '=', 'pending')
      .where('u.expires_at', '>', now)
      .where('d.revoked_at', 'is', null)
      .orderBy('u.created_at')
      .execute();
    return {
      requests: rows.map((x) => ({
        requestId: x.id,
        deviceId: x.device_id,
        expiresAt: iso(x.expires_at),
        payload: x.payload as never,
      })),
    };
  });

  // Only the extension that created the request may poll it.
  r.handle('getUnlockRequest', async ({ deps, now, auth, params }) => {
    const row = await deps.db
      .selectFrom('unlock_requests')
      .selectAll()
      .where('id', '=', params.id)
      .where('device_id', '=', auth.device.id)
      .executeTakeFirst();
    if (!row) return fail('E_NOT_FOUND', 'request not found');
    if (row.status === 'approved') {
      return { status: 'approved' as const, response: row.response as never };
    }
    if (row.status === 'denied') return { status: 'denied' as const };
    if (row.status === 'expired' || row.expires_at.getTime() <= now.getTime()) {
      return { status: 'expired' as const };
    }
    return { status: 'pending' as const, expiresAt: iso(row.expires_at) };
  });

  async function decide(
    deps: Deps,
    now: Date,
    accountId: string,
    id: string,
    decision: { status: 'approved'; response: string } | { status: 'denied' },
  ): Promise<void> {
    await deps.db.transaction().execute(async (trx) => {
      // One statement decides: only a pending, unexpired request of this account can change.
      const row = await trx
        .updateTable('unlock_requests')
        .set({
          status: decision.status,
          response: decision.status === 'approved' ? decision.response : null,
        })
        .where('id', '=', id)
        .where('account_id', '=', accountId)
        .where('status', '=', 'pending')
        .where('expires_at', '>', now)
        .returning('device_id')
        .executeTakeFirst();
      if (!row) {
        const cur = await trx
          .selectFrom('unlock_requests')
          .select(['status', 'expires_at'])
          .where('id', '=', id)
          .where('account_id', '=', accountId)
          .executeTakeFirst();
        if (!cur) fail('E_NOT_FOUND', 'request not found');
        if (cur.status === 'pending' || cur.status === 'expired')
          fail('E_EXPIRED', 'request expired');
        fail('E_ALREADY_HANDLED', 'request already handled');
      }
      await writeAudit(
        trx,
        accountId,
        row.device_id,
        decision.status === 'approved' ? 'unlock_approved' : 'unlock_denied',
        now,
      );
    });
  }

  r.handle('approveUnlockRequest', async ({ deps, now, auth, params, body }) => {
    await decide(deps, now, auth.device.accountId, params.id, {
      status: 'approved',
      response: JSON.stringify(body.response),
    });
    return undefined;
  });

  r.handle('denyUnlockRequest', async ({ deps, now, auth, params }) => {
    await decide(deps, now, auth.device.accountId, params.id, { status: 'denied' });
    return undefined;
  });
}
