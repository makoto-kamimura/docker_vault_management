import { AUTHKEY_HEADER, HeaderParseError, parseAuthKeyHeader } from '@localvault/protocol';
import { constantTimeEqual, fromB64, sha256 } from '../crypto';
import type { Database } from '../db/client';
import { fail } from '../errors';

/** SHA-256(authKey) against the stored verifier, in constant time. `authKey` is base64url. */
export function authKeyMatches(authKey: string, verifier: Uint8Array): boolean {
  return constantTimeEqual(sha256(fromB64(authKey)), verifier);
}

/** Verify the `X-LV-AuthKey` header against the account's verifier. */
export async function verifyAuthKeyHeader(
  db: Database,
  accountId: string,
  header: string | undefined,
): Promise<void> {
  if (header === undefined) fail('E_UNAUTHORIZED', `${AUTHKEY_HEADER} required`);
  let authKey: string;
  try {
    authKey = parseAuthKeyHeader(header);
  } catch (err) {
    if (err instanceof HeaderParseError) fail('E_UNAUTHORIZED', 'malformed authKey');
    throw err;
  }
  const row = await db
    .selectFrom('accounts')
    .select('verifier')
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!row || !authKeyMatches(authKey, row.verifier)) fail('E_UNAUTHORIZED', 'authKey mismatch');
}
