// Administrative proof of spec §8.7: X-LV-Admin signature (this module) or X-LV-AuthKey.
import {
  ADMIN_HEADER,
  adminSignString,
  type HeaderParseError,
  parseAdminHeader,
  TTL_SEC,
} from '@localvault/protocol';
import type { Clock } from '../clock';
import { b64, fromB64, sha256, verifyEcdsaP256 } from '../crypto';
import type { Database } from '../db/client';
import { fail } from '../errors';
import type { AuthRequest, DeviceCtx } from './types';

/**
 * Verify `X-LV-Admin` for the already authenticated `device`. Order of checks:
 * header syntax, same device as the bearer token, ts window (E_CLOCK_SKEW), admin key present,
 * signature, and last the single-use nonce (so a bad signature never burns a nonce).
 */
export async function verifyAdminSignature(
  db: Database,
  clock: Clock,
  device: DeviceCtx,
  req: AuthRequest,
  headerValue: string,
): Promise<void> {
  let h: ReturnType<typeof parseAdminHeader>;
  try {
    h = parseAdminHeader(headerValue);
  } catch (err) {
    return fail(
      'E_UNAUTHORIZED',
      `malformed ${ADMIN_HEADER} header: ${(err as HeaderParseError).message}`,
    );
  }
  if (h.deviceId !== device.id) fail('E_UNAUTHORIZED', 'admin signature is from another device');
  if (device.kind !== 'mobile')
    fail('E_FORBIDDEN', 'only approver devices can sign admin requests');

  const now = clock.now();
  const nowSec = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSec - h.ts) > TTL_SEC.adminTsWindow) {
    fail('E_CLOCK_SKEW', 'request time is outside the allowed window', {
      serverTime: now.toISOString(),
    });
  }

  if (device.adminPub === null) fail('E_UNAUTHORIZED', 'no admin key registered');
  const signed = adminSignString({
    method: req.method,
    path: req.pathWithQuery,
    bodyHash: b64(sha256(req.rawBody)),
    ts: h.ts,
    nonce: h.nonce,
  });
  if (!verifyEcdsaP256(device.adminPub, signed, fromB64(h.sig))) {
    fail('E_UNAUTHORIZED', 'bad admin signature');
  }

  const inserted = await db
    .insertInto('admin_nonces')
    .values({
      device_id: device.id,
      nonce: fromB64(h.nonce),
      expires_at: new Date(now.getTime() + TTL_SEC.adminNonceRetention * 1000),
    })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst();
  if (Number(inserted.numInsertedOrUpdatedRows ?? 0) === 0)
    fail('E_UNAUTHORIZED', 'nonce already used');
}
