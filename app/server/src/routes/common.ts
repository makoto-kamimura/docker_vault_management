import type { EncryptedRecord, Keyset } from '@localvault/protocol';
import { b64, fromB64, importP256PublicKey } from '../crypto';
import type { Queryable } from '../db/client';
import type { AccountsTable, RecordsTable } from '../db/schema';
import { fail } from '../errors';

export function keysetOf(
  a: Pick<AccountsTable, 'keyset_version' | 'vk_version' | 'kdf' | 'wrapped_vk'>,
): Keyset {
  return {
    keysetVersion: a.keyset_version,
    vkVersion: a.vk_version,
    kdf: a.kdf,
    wrappedVK: a.wrapped_vk,
  };
}

export function recordToWire(r: RecordsTable): EncryptedRecord {
  if (r.deleted) {
    return { id: r.id, rev: r.rev, deleted: true, vkVersion: r.vk_version, nonce: null, ct: null };
  }
  return {
    id: r.id,
    rev: r.rev,
    deleted: false,
    vkVersion: r.vk_version,
    nonce: b64(r.nonce as Buffer),
    ct: b64(r.ct as Buffer),
  };
}

export const iso = (d: Date): string => d.toISOString();

/** Reject public keys that are not valid points on P-256 (the schema only checks the length). */
export function assertValidPublicKey(value: string, field: string): Buffer {
  const bytes = fromB64(value);
  if (importP256PublicKey(bytes) === null) fail('E_INVALID', `${field} is not a valid P-256 point`);
  return bytes;
}

/** A device id may be used once, ever: not by a live device and not by a deleted-account tombstone. */
export async function assertDeviceIdFree(q: Queryable, deviceId: string): Promise<void> {
  const live = await q
    .selectFrom('devices')
    .select('id')
    .where('id', '=', deviceId)
    .executeTakeFirst();
  const gone = await q
    .selectFrom('deleted_devices')
    .select('device_id')
    .where('device_id', '=', deviceId)
    .executeTakeFirst();
  if (live || gone) fail('E_INVALID', 'deviceId is already in use');
}

export async function insertDevice(
  q: Queryable,
  d: {
    id: string;
    accountId: string;
    kind: 'mobile' | 'extension';
    platform: string;
    signPub: Buffer;
    adminPub: Buffer | null;
    now: Date;
  },
): Promise<void> {
  await q
    .insertInto('devices')
    .values({
      id: d.id,
      account_id: d.accountId,
      kind: d.kind,
      platform: d.platform,
      sign_pub: d.signPub,
      admin_pub: d.adminPub,
      push_platform: null,
      push_token: null,
      created_at: d.now,
      last_seen_at: null,
      revoked_at: null,
    })
    .execute();
}

/** Lock the account row for the rest of the transaction (serialises all writers of an account). */
export async function lockAccount(q: Queryable, accountId: string) {
  return await q
    .selectFrom('accounts')
    .selectAll()
    .where('id', '=', accountId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}
