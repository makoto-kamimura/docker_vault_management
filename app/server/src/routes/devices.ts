import { writeAudit } from '../audit';
import { fail } from '../errors';
import { assertValidPublicKey, iso } from './common';
import type { Registrar } from './define';

export function registerDeviceRoutes(r: Registrar): void {
  r.handle('listDevices', async ({ deps, auth }) => {
    const rows = await deps.db
      .selectFrom('devices')
      .select(['id', 'kind', 'platform', 'created_at', 'last_seen_at', 'revoked_at'])
      .where('account_id', '=', auth.device.accountId)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return {
      devices: rows.map((d) => ({
        deviceId: d.id,
        type: d.kind,
        platform: d.platform as 'ios' | 'android' | 'chrome' | 'edge' | 'brave',
        createdAt: iso(d.created_at),
        lastSeenAt: d.last_seen_at ? iso(d.last_seen_at) : null,
        revokedAt: d.revoked_at ? iso(d.revoked_at) : null,
      })),
    };
  });

  // Revocation takes effect immediately: every authenticated request re-reads revoked_at.
  r.handle('deleteDevice', async ({ deps, now, auth, params }) => {
    await deps.db.transaction().execute(async (trx) => {
      const target = await trx
        .selectFrom('devices')
        .select(['id', 'revoked_at'])
        .where('id', '=', params.id)
        .where('account_id', '=', auth.device.accountId)
        .forUpdate()
        .executeTakeFirst();
      if (!target) fail('E_NOT_FOUND', 'device not found');
      if (target.revoked_at !== null) return; // already revoked: idempotent
      await trx
        .updateTable('devices')
        .set({ revoked_at: now, push_token: null, push_platform: null })
        .where('id', '=', target.id)
        .execute();
      // Open unlock requests of that device die with it.
      await trx
        .updateTable('unlock_requests')
        .set({ status: 'expired' })
        .where('device_id', '=', target.id)
        .where('status', '=', 'pending')
        .execute();
      await writeAudit(
        trx,
        auth.device.accountId,
        target.id,
        target.id === auth.device.id ? 'device_signed_out' : 'device_revoked',
        now,
      );
    });
    return undefined;
  });

  r.handle('putPushToken', async ({ deps, auth, body }) => {
    await deps.db
      .updateTable('devices')
      .set({ push_platform: body.pushPlatform, push_token: body.token })
      .where('id', '=', auth.device.id)
      .execute();
    return undefined;
  });

  // Authenticated by the authKey (the old admin key may be unusable, e.g. after a biometric change).
  r.handle('putAdminKey', async ({ deps, auth, body }) => {
    const adminPub = assertValidPublicKey(body.adminPub, 'adminPub');
    await deps.db
      .updateTable('devices')
      .set({ admin_pub: adminPub })
      .where('id', '=', auth.device.id)
      .execute();
    return undefined;
  });
}
