// The only place that touches node:crypto primitives. Small and explicit on purpose.
import {
  createHash,
  createHmac,
  createPublicKey,
  type KeyObject,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { base64urlDecode, base64urlEncode } from '@localvault/protocol';

export function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(key: string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function b64(bytes: Uint8Array): string {
  return base64urlEncode(bytes);
}

/** Decode a base64url string that the protocol schemas have already validated. */
export function fromB64(s: string): Buffer {
  return Buffer.from(base64urlDecode(s));
}

export function randomB64(n: number): string {
  return b64(randomBytes(n));
}

export function newId(): string {
  return randomUUID();
}

/** Constant-time equality. Different lengths are simply unequal (lengths are public here). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Import a 65-byte SEC1 uncompressed P-256 point (0x04 || X || Y). Node validates that the point
 * lies on the curve and rejects anything else; malformed input returns null.
 */
export function importP256PublicKey(sec1: Uint8Array): KeyObject | null {
  if (sec1.length !== 65 || sec1[0] !== 0x04) return null;
  try {
    return createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: b64(sec1.subarray(1, 33)),
        y: b64(sec1.subarray(33, 65)),
      },
      format: 'jwk',
    });
  } catch {
    return null;
  }
}

/** ECDSA P-256 / SHA-256 verification of a 64-byte r||s (IEEE P1363) signature. */
export function verifyEcdsaP256(publicKey: Uint8Array, message: string, sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  const key = importP256PublicKey(publicKey);
  if (key === null) return false;
  try {
    return verify('sha256', Buffer.from(message, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}
