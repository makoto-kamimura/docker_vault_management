import type { AuditEventKind } from '@localvault/protocol';
import type { Queryable } from './db/client';

/**
 * Append a security-log row (F3). `deviceId` is the device the event is about: the new or revoked
 * device, the requesting PC for unlock events, the claiming device for recovery-code claims, and
 * the acting approver otherwise.
 */
export async function writeAudit(
  q: Queryable,
  accountId: string,
  deviceId: string | null,
  kind: AuditEventKind,
  now: Date,
): Promise<void> {
  await q
    .insertInto('audit_events')
    .values({ account_id: accountId, device_id: deviceId, kind, created_at: now })
    .execute();
}
