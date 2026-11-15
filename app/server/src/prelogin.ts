import { KDF_MIN_ITERATIONS, type Kdf } from '@localvault/protocol';
import { b64, hmacSha256 } from './crypto';

function uuidV4FromBytes(b: Buffer): string {
  const x = Buffer.from(b.subarray(0, 16));
  x[6] = ((x[6] as number) & 0x0f) | 0x40;
  x[8] = ((x[8] as number) & 0x3f) | 0x80;
  const h = x.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Deterministic stand-in for an unknown account name (spec §8.6): the same name always yields the
 * same accountId and salt, derived from the server secret, with the same shape as a real answer.
 * The iteration count is the protocol minimum, which is what clients use by default.
 */
export function fakePrelogin(
  secret: string,
  normalizedName: string,
): { accountId: string; kdf: Kdf } {
  return {
    accountId: uuidV4FromBytes(hmacSha256(secret, `prelogin-id|${normalizedName}`)),
    kdf: {
      alg: 'PBKDF2-HMAC-SHA256',
      iterations: KDF_MIN_ITERATIONS,
      salt: b64(hmacSha256(secret, `prelogin-salt|${normalizedName}`).subarray(0, 16)),
    },
  };
}
