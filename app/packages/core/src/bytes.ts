// Small byte helpers that behave identically in Node, browsers and Hermes (no Buffer).
import { uuidSchema } from '@localvault/protocol';
import { VaultCoreError } from './errors';

const HEX = '0123456789abcdef';

export function hexEncode(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX.charAt(b >>> 4) + HEX.charAt(b & 15);
  return out;
}

export function hexDecode(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new VaultCoreError('E_INVALID_INPUT', 'invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** The 16 raw bytes of a lower-case UUID v4 string (used as HKDF salt, §5.4). */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!uuidSchema.safeParse(uuid).success) {
    throw new VaultCoreError('E_INVALID_INPUT', 'invalid uuid');
  }
  return hexDecode(uuid.replaceAll('-', ''));
}

export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new VaultCoreError('E_INVALID_INPUT', 'uuid needs 16 bytes');
  const h = hexEncode(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Fix the version/variant bits of 16 random bytes and format as a UUID v4. */
export function uuidV4FromRandom(random: Uint8Array): string {
  if (random.length !== 16) throw new VaultCoreError('E_INVALID_INPUT', 'uuid needs 16 bytes');
  const b = new Uint8Array(random);
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  return bytesToUuid(b);
}

/** Best-effort wipe of a secret buffer (JS gives no hard guarantee). */
export function wipe(...buffers: Uint8Array[]): void {
  for (const b of buffers) b.fill(0);
}
