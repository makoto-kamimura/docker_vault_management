import { randomBytes } from 'node:crypto';
import { authSignString, TTL_SEC } from '@localvault/protocol';
import { writeAudit } from '../audit';
import { authKeyMatches } from '../auth/authkey';
import { issueAccessToken } from '../auth/token';
import { b64, fromB64, verifyEcdsaP256 } from '../crypto';
import type { Database } from '../db/client';
import { fail } from '../errors';
import { assertDeviceIdFree, assertValidPublicKey, insertDevice, iso, keysetOf } from './common';
import type { Registrar } from './define';

/** Tombstone / revoked checks shared by challenge and token issuance. */
async function loadLoginDevice(db: Database, deviceId: string) {
  const dev = await db
    .selectFrom('devices')
    .select(['id', 'account_id', 'kind', 'sign_pub', 'revoked_at'])
    .where('id', '=', deviceId)
    .executeTakeFirst();
  if (!dev) {
    const gone = await db
      .selectFrom('deleted_devices')
      .select('device_id')
      .where('device_id', '=', deviceId)
      .executeTakeFirst();
    if (gone) fail('E_ACCOUNT_DELETED', 'account deleted');
    return undefined;
  }
  if (dev.revoked_at !== null) fail('E_DEVICE_REVOKED', 'device revoked');
  return dev;
}

export function registerAuthRoutes(r: Registrar): void {
  r.handle('authChallenge', async ({ deps, now, body }) => {
    const dev = await loadLoginDevice(deps.db, body.deviceId);
    const challenge = randomBytes(32);
    const expiresAt = new Date(now.getTime() + TTL_SEC.authChallenge * 1000);
    // Unknown devices get an answer of the same shape (it is simply never stored).
    if (dev) {
      await deps.db
        .insertInto('auth_challenges')
        .values({ device_id: dev.id, challenge, expires_at: expiresAt })
        .execute();
    }
    return { challenge: b64(challenge), expiresAt: iso(expiresAt) };
  });

  r.handle('authToken', async ({ deps, now, body }) => {
    const dev = await loadLoginDevice(deps.db, body.deviceId);
    // Single use: the challenge is consumed before the signature is checked.
    const consumed = await deps.db
      .deleteFrom('auth_challenges')
      .where('device_id', '=', body.deviceId)
      .where('challenge', '=', fromB64(body.challenge))
      .returning('expires_at')
      .executeTakeFirst();
    if (!dev || !consumed) return fail('E_UNAUTHORIZED', 'unknown challenge');
    if (consumed.expires_at.getTime() <= now.getTime())
      return fail('E_EXPIRED', 'challenge expired');
    const ok = verifyEcdsaP256(
      dev.sign_pub,
      authSignString(body.deviceId, body.challenge),
      fromB64(body.sig),
    );
    if (!ok) return fail('E_UNAUTHORIZED', 'bad signature');
    const token = await issueAccessToken(deps.config.tokenSecret, deps.clock, {
      deviceId: dev.id,
      accountId: dev.account_id,
      kind: dev.kind,
    });
    return { accessToken: token.accessToken, expiresAt: iso(token.expiresAt) };
  });

  r.handle('authRecover', async ({ deps, now, body }) => {
    // The authKey lives in the body, so it is verified here (rate limited by account and IP).
    const acc = await deps.db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', body.accountId)
      .executeTakeFirst();
    const dummy = Buffer.alloc(32);
    const matches = authKeyMatches(body.authKey, acc ? acc.verifier : dummy);
    if (!acc || !matches) return fail('E_UNAUTHORIZED', 'authentication failed');

    const signPub = assertValidPublicKey(body.device.signPub, 'device.signPub');
    const adminPub = assertValidPublicKey(body.device.adminPub as string, 'device.adminPub');
    await deps.db.transaction().execute(async (trx) => {
      const same = await trx
        .selectFrom('devices')
        .select(['sign_pub', 'revoked_at'])
        .where('id', '=', body.device.deviceId)
        .where('account_id', '=', acc.id)
        .executeTakeFirst();
      if (same && same.revoked_at === null && Buffer.compare(same.sign_pub, signPub) === 0) {
        return; // retry of an earlier successful call
      }
      await assertDeviceIdFree(trx, body.device.deviceId);
      await insertDevice(trx, {
        id: body.device.deviceId,
        accountId: acc.id,
        kind: 'mobile',
        platform: body.device.platform,
        signPub,
        adminPub,
        now,
      });
      await writeAudit(trx, acc.id, body.device.deviceId, 'device_added', now);
    });
    const token = await issueAccessToken(deps.config.tokenSecret, deps.clock, {
      deviceId: body.device.deviceId,
      accountId: acc.id,
      kind: 'mobile',
    });
    return {
      accessToken: token.accessToken,
      expiresAt: iso(token.expiresAt),
      keyset: keysetOf(acc),
    };
  });
}
