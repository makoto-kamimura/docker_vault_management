import { TTL_SEC } from '@localvault/protocol';
import { sql } from 'kysely';
import type { Clock } from '../clock';
import type { Database } from '../db/client';

const DAY = 86_400_000;

export type CleanupResult = Record<string, number>;

const n = (r: { numDeletedRows?: bigint; numUpdatedRows?: bigint }): number =>
  Number(r.numDeletedRows ?? r.numUpdatedRows ?? 0n);

/** Hourly housekeeping (spec §13.6 last bullet, plus rotations, invites and tombstones). */
export async function runCleanup(db: Database, clock: Clock): Promise<CleanupResult> {
  const now = clock.now();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const out: CleanupResult = {};

  out.challenges = n(
    await db.deleteFrom('auth_challenges').where('expires_at', '<', now).executeTakeFirst(),
  );
  out.adminNonces = n(
    await db.deleteFrom('admin_nonces').where('expires_at', '<', now).executeTakeFirst(),
  );
  out.pairings = n(
    await db.deleteFrom('pairings').where('expires_at', '<', now).executeTakeFirst(),
  );
  out.unlockRequests = n(
    await db
      .deleteFrom('unlock_requests')
      .where('created_at', '<', ago(TTL_SEC.unlockRequestRowRetention * 1000))
      .executeTakeFirst(),
  );
  // pending claims whose 7 days are over
  out.claimsExpired = n(
    await db
      .updateTable('recovery_claims')
      .set({ status: 'expired' })
      .where('status', '=', 'waiting')
      .where('available_at', '<', ago(TTL_SEC.recoveryClaimExpiry * 1000))
      .executeTakeFirst(),
  );
  // tombstones older than 180 days: delete, then move min_valid_cursor past them
  await db.transaction().execute(async (trx) => {
    const purged = await trx
      .deleteFrom('records')
      .where('deleted', '=', true)
      .where('updated_at', '<', ago(TTL_SEC.tombstone * 1000))
      .returning(['account_id', 'rev'])
      .execute();
    out.tombstones = purged.length;
    const maxByAccount = new Map<string, number>();
    for (const p of purged)
      maxByAccount.set(p.account_id, Math.max(maxByAccount.get(p.account_id) ?? 0, p.rev));
    for (const [accountId, rev] of maxByAccount) {
      await trx
        .updateTable('accounts')
        .set({ min_valid_cursor: sql<number>`greatest(min_valid_cursor, ${rev})` })
        .where('id', '=', accountId)
        .execute();
    }
  });
  out.audit = n(
    await db
      .deleteFrom('audit_events')
      .where('created_at', '<', ago(TTL_SEC.auditLog * 1000))
      .executeTakeFirst(),
  );
  out.rotations = n(
    await db.deleteFrom('rotations').where('expires_at', '<', now).executeTakeFirst(),
  );
  out.deletedDevices = n(
    await db
      .deleteFrom('deleted_devices')
      .where('deleted_at', '<', ago(TTL_SEC.deletedDeviceTombstone * 1000))
      .executeTakeFirst(),
  );
  out.invites = n(
    await db
      .deleteFrom('invites')
      .where('used_at', 'is', null)
      .where((eb) =>
        eb.or([eb('expires_at', '<', ago(30 * DAY)), eb('revoked_at', '<', ago(30 * DAY))]),
      )
      .executeTakeFirst(),
  );
  return out;
}

export function startCleanupJob(
  db: Database,
  clock: Clock,
  onError: (err: unknown) => void,
  intervalMs = 3_600_000,
): () => void {
  const tick = () => runCleanup(db, clock).catch(onError);
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
