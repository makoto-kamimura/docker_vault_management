// Crockford Base32 helpers shared by the recovery key (§5.5) and the recovery code (§8.11.2).
import type { CryptoProvider } from './crypto/provider';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Encode bytes MSB-first; the final partial group is zero-padded. 16 bytes -> 26 chars. */
export function crockfordEncode(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD.charAt((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD.charAt((acc << (5 - bits)) & 31);
  return out;
}

/**
 * Decode canonical characters into exactly `byteLength` bytes. Returns null when a character is
 * not in the alphabet, the length is wrong, or the padding bits are not zero.
 */
export function crockfordDecode(text: string, byteLength: number): Uint8Array | null {
  const chars = Math.ceil((byteLength * 8) / 5);
  if (text.length !== chars) return null;
  const out = new Uint8Array(byteLength);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < text.length; i++) {
    const v = CROCKFORD.indexOf(text.charAt(i));
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return acc === 0 ? out : null;
}

/** Two check characters from the first 10 bits of SHA-256(secret). */
export async function checkChars(p: CryptoProvider, secret: Uint8Array): Promise<string> {
  const h = await p.sha256(secret);
  const b0 = h[0] as number;
  const b1 = h[1] as number;
  return CROCKFORD.charAt(b0 >>> 3) + CROCKFORD.charAt(((b0 & 7) << 2) | (b1 >>> 6));
}

/**
 * Lenient reading (§5.5): case-insensitive, hyphens and whitespace ignored, I/L -> 1, O -> 0.
 * `prefix` (e.g. "LV2") is removed BEFORE the letter mapping because it contains an L.
 * Returns the canonical characters, or null if an illegal character remains.
 */
export function normalizeCrockford(
  input: string,
  prefix: string,
  bodyLength: number,
): string | null {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length === prefix.length + bodyLength && s.startsWith(prefix)) s = s.slice(prefix.length);
  s = s.replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]*$/.test(s) ? s : null;
}

export function groupBy(text: string, size: number): string {
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.join('-');
}
