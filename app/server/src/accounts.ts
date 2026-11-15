import type { Database } from './db/client';

/**
 * Delete an account and everything it owns. The ids of its devices (revoked ones included) are
 * kept in `deleted_devices` so those devices get E_ACCOUNT_DELETED for 90 days (G3).
 * Returns false when the account does not exist.
 */
export async function deleteAccountCascade(
  db: Database,
  accountId: string,
  now: Date,
): Promise<boolean> {
  return await db.transaction().execute(async (trx) => {
    const acc = await trx
      .selectFrom('accounts')
      .select('id')
      .where('id', '=', accountId)
      .forUpdate()
      .executeTakeFirst();
    if (!acc) return false;
    const devices = await trx
      .selectFrom('devices')
      .select('id')
      .where('account_id', '=', accountId)
      .execute();
    const ids = devices.map((d) => d.id);
    if (ids.length > 0) {
      await trx
        .insertInto('deleted_devices')
        .values(ids.map((device_id) => ({ device_id, deleted_at: now })))
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx.deleteFrom('auth_challenges').where('device_id', 'in', ids).execute();
      await trx.deleteFrom('admin_nonces').where('device_id', 'in', ids).execute();
    }
    await trx.deleteFrom('audit_events').where('account_id', '=', accountId).execute();
    await trx.deleteFrom('accounts').where('id', '=', accountId).execute(); // cascades the rest
    return true;
  });
}
