import { type ErrorCode, TTL_SEC } from '@localvault/protocol';
import { sql } from 'kysely';
import { writeAudit } from '../audit';
import { fromB64, newId } from '../crypto';
import type { Tx } from '../db/client';
import { fail } from '../errors';
import { iso, lockAccount } from './common';
import type { Registrar } from './define';

/** Remove recovery claims that are still open together with the recovery code (G12, §8.11.6). */
export async function invalidateRecoveryCode(trx: Tx, accountId: string): Promise<boolean> {
  const del = await trx
    .deleteFrom('recovery_codes')
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  await trx
    .updateTable('recovery_claims')
    .set({ status: 'canceled' })
    .where('account_id', '=', accountId)
    .where('status', 'in', ['waiting', 'disputed'])
    .execute();
  return del.numDeletedRows > 0n;
}

export function registerRotationRoutes(r: Registrar): void {
  r.handle('createRotation', async ({ deps, now, auth, body }) => {
    const accountId = auth.device.accountId;
    const rotationId = newId();
    const expiresAt = new Date(now.getTime() + TTL_SEC.rotation * 1000);
    await deps.db.transaction().execute(async (trx) => {
      const acc = await lockAccount(trx, accountId);
      if (body.newVkVersion !== acc.vk_version + 1) {
        fail('E_VERSION_CONFLICT', 'newVkVersion must be the current vkVersion + 1');
      }
      // One rotation per account: a new one replaces (and discards) the old one.
      await trx.deleteFrom('rotations').where('account_id', '=', accountId).execute();
      await trx
        .insertInto('rotations')
        .values({
          id: rotationId,
          account_id: accountId,
          device_id: auth.device.id,
          expected_rev: body.expectedRev,
          new_vk_version: body.newVkVersion,
          created_at: now,
          expires_at: expiresAt,
        })
        .execute();
    });
    return { rotationId, expiresAt: iso(expiresAt) };
  });

  r.handle('stageRotationRecords', async ({ deps, now, auth, params, body }) => {
    const accountId = auth.device.accountId;
    await deps.db.transaction().execute(async (trx) => {
      await lockAccount(trx, accountId);
      const rot = await trx
        .selectFrom('rotations')
        .selectAll()
        .where('id', '=', params.id)
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      if (!rot) fail('E_NOT_FOUND', 'rotation not found');
      if (rot.device_id !== auth.device.id)
        fail('E_FORBIDDEN', 'rotation belongs to another device');
      if (rot.expires_at.getTime() <= now.getTime()) fail('E_EXPIRED', 'rotation expired');

      await trx
        .insertInto('rotation_records')
        .values(
          [...new Map(body.records.map((x) => [x.id, x])).values()].map((x) => ({
            rotation_id: rot.id,
            id: x.id,
            deleted: x.deleted,
            nonce: x.deleted ? null : fromB64(x.nonce),
            ct: x.deleted ? null : fromB64(x.ct),
          })),
        )
        .onConflict((oc) =>
          oc.columns(['rotation_id', 'id']).doUpdateSet((eb) => ({
            deleted: eb.ref('excluded.deleted'),
            nonce: eb.ref('excluded.nonce'),
            ct: eb.ref('excluded.ct'),
          })),
        )
        .execute();
      // Staging can never legitimately hold more ids than the account has records.
      const [staged, total] = await Promise.all([
        trx
          .selectFrom('rotation_records')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('rotation_id', '=', rot.id)
          .executeTakeFirstOrThrow(),
        trx
          .selectFrom('records')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('account_id', '=', accountId)
          .executeTakeFirstOrThrow(),
      ]);
      if (Number(staged.n) > Number(total.n))
        fail('E_TOO_LARGE', 'more staged records than stored records');
    });
    return undefined;
  });

  r.handle('commitRotation', async ({ deps, now, auth, params, body }) => {
    const accountId = auth.device.accountId;
    type Outcome = { error?: readonly [string, string]; cursor?: number };
    const outcome: Outcome = await deps.db.transaction().execute(async (trx): Promise<Outcome> => {
      const acc = await lockAccount(trx, accountId);
      const rot = await trx
        .selectFrom('rotations')
        .selectAll()
        .where('id', '=', params.id)
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      if (!rot) return { error: ['E_NOT_FOUND', 'rotation not found'] as const };
      if (rot.expires_at.getTime() <= now.getTime()) {
        await trx.deleteFrom('rotations').where('id', '=', rot.id).execute();
        return { error: ['E_EXPIRED', 'rotation expired'] as const };
      }
      if (acc.record_rev !== rot.expected_rev) {
        // The vault changed while the client re-encrypted: discard the staging (commit, then fail).
        await trx.deleteFrom('rotations').where('id', '=', rot.id).execute();
        return { error: ['E_VERSION_CONFLICT', 'records changed during rotation'] as const };
      }
      if (body.keyset.vkVersion !== rot.new_vk_version) {
        return { error: ['E_INVALID', 'keyset.vkVersion must equal newVkVersion'] as const };
      }
      if (body.keyset.keysetVersion !== acc.keyset_version + 1) {
        return { error: ['E_VERSION_CONFLICT', 'keysetVersion must be current + 1'] as const };
      }

      const staged = await trx
        .selectFrom('rotation_records')
        .select('id')
        .where('rotation_id', '=', rot.id)
        .orderBy('id')
        .execute();
      const current = await trx
        .selectFrom('records')
        .select('id')
        .where('account_id', '=', accountId)
        .orderBy('id')
        .execute();
      if (body.recordCount !== staged.length) {
        return { error: ['E_INVALID', 'recordCount does not match the staged records'] as const };
      }
      const same =
        staged.length === current.length && staged.every((s, i) => s.id === current[i]?.id);
      if (!same) {
        return { error: ['E_INVALID', 'staged ids do not match the stored records'] as const };
      }

      // Replace every record in one statement, numbering the new revs after the current counter.
      const base = acc.record_rev;
      await sql`
        update records r set
          rev = ${base}::bigint + s.rn,
          deleted = s.deleted,
          vk_version = ${rot.new_vk_version},
          nonce = s.nonce,
          ct = s.ct,
          updated_at = ${now}
        from (
          select id, deleted, nonce, ct, row_number() over (order by id) as rn
          from rotation_records where rotation_id = ${rot.id}
        ) s
        where r.account_id = ${accountId} and r.id = s.id`.execute(trx);
      const newRev = base + staged.length;
      await trx
        .updateTable('accounts')
        .set({
          kdf: body.keyset.kdf,
          wrapped_vk: body.keyset.wrappedVK,
          keyset_version: body.keyset.keysetVersion,
          vk_version: rot.new_vk_version,
          verifier: fromB64(body.verifier),
          record_rev: newRev,
          keyset_rev: newRev,
          min_valid_cursor: base + 1,
        })
        .where('id', '=', accountId)
        .execute();
      const hadCode = await invalidateRecoveryCode(trx, accountId);
      await trx.deleteFrom('rotations').where('id', '=', rot.id).execute();
      await writeAudit(trx, accountId, auth.device.id, 'rotated', now);
      if (hadCode) await writeAudit(trx, accountId, auth.device.id, 'rc_revoked', now);
      return { cursor: newRev };
    });
    if (outcome.cursor === undefined) {
      const [code, message] = outcome.error as readonly [ErrorCode, string];
      return fail(code, message);
    }
    return { cursor: outcome.cursor };
  });

  r.handle('abortRotation', async ({ deps, auth, params }) => {
    const del = await deps.db
      .deleteFrom('rotations')
      .where('id', '=', params.id)
      .where('account_id', '=', auth.device.accountId)
      .executeTakeFirst();
    if (del.numDeletedRows === 0n) fail('E_NOT_FOUND', 'rotation not found');
    return undefined;
  });
}
