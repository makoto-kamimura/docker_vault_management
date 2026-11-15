import { deleteAccountCascade } from '../accounts';
import { writeAudit } from '../audit';
import { constantTimeEqual, fromB64, sha256 } from '../crypto';
import type { Tx } from '../db/client';
import type { Deps } from '../deps';
import { fail, isUniqueViolation } from '../errors';
import { assertDeviceIdFree, assertValidPublicKey, insertDevice } from './common';
import type { Handler, Registrar } from './define';

type CreateBody = Parameters<Handler<'createAccount'>>[0]['body'];

async function createAccountOnce(deps: Deps, now: Date, body: CreateBody): Promise<void> {
  const verifier = fromB64(body.verifier);
  const signPub = assertValidPublicKey(body.device.signPub, 'device.signPub');
  const adminPub = assertValidPublicKey(body.device.adminPub as string, 'device.adminPub');

  await deps.db.transaction().execute(async (trx: Tx) => {
    // Idempotent retry (G13): same accountId + verifier + first device signPub -> 201 again.
    const existing = await trx
      .selectFrom('accounts')
      .select(['id', 'verifier'])
      .where('id', '=', body.accountId)
      .executeTakeFirst();
    if (existing) {
      const device = await trx
        .selectFrom('devices')
        .select('sign_pub')
        .where('id', '=', body.device.deviceId)
        .where('account_id', '=', body.accountId)
        .executeTakeFirst();
      if (
        constantTimeEqual(existing.verifier, verifier) &&
        device !== undefined &&
        constantTimeEqual(device.sign_pub, signPub)
      ) {
        return;
      }
      fail('E_ACCOUNT_EXISTS', 'account already exists');
    }

    const mode = deps.config.registrationMode;
    if (mode === 'closed') fail('E_REGISTRATION_CLOSED', 'registration is closed');
    if (mode === 'invite') {
      const used = await trx
        .updateTable('invites')
        .set({ used_at: now, account_id: body.accountId })
        .where('code_hash', '=', sha256(Buffer.from(body.inviteCode, 'utf8')))
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]))
        .executeTakeFirst();
      if (used.numUpdatedRows === 0n) fail('E_REGISTRATION_CLOSED', 'invalid invite code');
    }

    const sameName = await trx
      .selectFrom('accounts')
      .select('id')
      .where('name', '=', body.accountName)
      .executeTakeFirst();
    if (sameName) fail('E_ACCOUNT_EXISTS', 'account name is taken');

    await assertDeviceIdFree(trx, body.device.deviceId);
    await trx
      .insertInto('accounts')
      .values({
        id: body.accountId,
        name: body.accountName,
        verifier,
        kdf: body.keyset.kdf,
        wrapped_vk: body.keyset.wrappedVK,
        keyset_version: body.keyset.keysetVersion,
        vk_version: body.keyset.vkVersion,
        record_rev: 0,
        min_valid_cursor: 0,
        keyset_rev: 0,
        created_at: now,
      })
      .execute();
    await insertDevice(trx, {
      id: body.device.deviceId,
      accountId: body.accountId,
      kind: 'mobile',
      platform: body.device.platform,
      signPub,
      adminPub,
      now,
    });
    await writeAudit(trx, body.accountId, body.device.deviceId, 'account_created', now);
  });
}

export function registerAccountRoutes(r: Registrar): void {
  r.handle('createAccount', async ({ deps, now, body }) => {
    try {
      await createAccountOnce(deps, now, body);
    } catch (err) {
      // A concurrent identical request won the race: run again so it is judged as a retry.
      if (!isUniqueViolation(err)) throw err;
      try {
        await createAccountOnce(deps, now, body);
      } catch (err2) {
        if (isUniqueViolation(err2)) fail('E_ACCOUNT_EXISTS', 'account already exists');
        throw err2;
      }
    }
    return {};
  });

  r.handle('deleteAccount', async ({ deps, now, auth }) => {
    await deleteAccountCascade(deps.db, auth.device.accountId, now);
    return undefined;
  });
}
