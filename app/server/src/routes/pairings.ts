import { TTL_SEC } from '@localvault/protocol';
import { writeAudit } from '../audit';
import { fromB64, newId, randomB64, sha256 } from '../crypto';
import { fail, isUniqueViolation } from '../errors';
import { assertDeviceIdFree, assertValidPublicKey, insertDevice, iso } from './common';
import type { Registrar } from './define';

export function registerPairingRoutes(r: Registrar): void {
  r.handle('createPairing', async ({ deps, now, body }) => {
    const signPub = assertValidPublicKey(body.signPub, 'signPub');
    await assertDeviceIdFree(deps.db, body.deviceId);
    const pollToken = randomB64(32);
    const pairingId = newId();
    const expiresAt = new Date(now.getTime() + TTL_SEC.pairing * 1000);
    await deps.db
      .insertInto('pairings')
      .values({
        id: pairingId,
        poll_token_hash: sha256(fromB64(pollToken)),
        device_id: body.deviceId,
        platform: body.platform,
        sign_pub: signPub,
        eph_pub: fromB64(body.ephPub),
        status: 'pending',
        account_id: null,
        response: null,
        expires_at: expiresAt,
      })
      .execute();
    return { pairingId, pollToken, expiresAt: iso(expiresAt) };
  });

  r.handle('getPairing', async ({ deps, now, params }) => {
    const row = await deps.db
      .selectFrom('pairings')
      .selectAll()
      .where('id', '=', params.id)
      .executeTakeFirst();
    if (!row) return fail('E_NOT_FOUND', 'pairing not found');
    if (row.status === 'approved') return fail('E_ALREADY_HANDLED', 'pairing already approved');
    if (row.expires_at.getTime() <= now.getTime()) return fail('E_EXPIRED', 'pairing expired');
    return {
      pairingId: row.id,
      deviceId: row.device_id,
      platform: row.platform as 'chrome' | 'edge' | 'brave',
      signPub: Buffer.from(row.sign_pub).toString('base64url'),
      ephPub: Buffer.from(row.eph_pub).toString('base64url'),
      expiresAt: iso(row.expires_at),
    };
  });

  r.handle('approvePairing', async ({ deps, now, auth, params, body }) => {
    try {
      await deps.db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('pairings')
          .set({
            status: 'approved',
            account_id: auth.device.accountId,
            response: JSON.stringify(body.response),
          })
          .where('id', '=', params.id)
          .where('status', '=', 'pending')
          .where('expires_at', '>', now)
          .returning(['device_id', 'platform', 'sign_pub'])
          .executeTakeFirst();
        if (!row) {
          const cur = await trx
            .selectFrom('pairings')
            .select(['status', 'expires_at'])
            .where('id', '=', params.id)
            .executeTakeFirst();
          if (!cur) fail('E_NOT_FOUND', 'pairing not found');
          if (cur.status === 'approved') fail('E_ALREADY_HANDLED', 'pairing already approved');
          fail('E_EXPIRED', 'pairing expired');
        }
        await insertDevice(trx, {
          id: row.device_id,
          accountId: auth.device.accountId,
          kind: 'extension',
          platform: row.platform,
          signPub: row.sign_pub,
          adminPub: null,
          now,
        });
        await writeAudit(trx, auth.device.accountId, row.device_id, 'device_added', now);
      });
    } catch (err) {
      if (isUniqueViolation(err)) fail('E_ALREADY_HANDLED', 'device already registered');
      throw err;
    }
    return undefined;
  });

  r.handle('pairingStatus', async ({ now, auth }) => {
    const p = auth.pairing;
    if (p.status === 'approved' && p.accountId !== null) {
      return {
        status: 'approved' as const,
        accountId: p.accountId,
        response: p.response as never,
      };
    }
    if (p.expiresAt.getTime() <= now.getTime()) return { status: 'expired' as const };
    return { status: 'pending' as const };
  });
}
