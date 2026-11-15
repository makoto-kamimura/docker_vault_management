// Hand-written base64url (RFC 4648 §5), no padding, strict. No Buffer / atob / btoa so that it
// behaves identically in Node, MV3 service workers and React Native (Hermes).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP: Int8Array = (() => {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) t[ALPHABET.charCodeAt(i)] = i;
  return t;
})();

export class Base64UrlError extends Error {
  override readonly name = 'Base64UrlError';
}

/** Encode bytes as unpadded base64url. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      (bytes[i] as number) * 65536 + (bytes[i + 1] as number) * 256 + (bytes[i + 2] as number);
    out +=
      ALPHABET.charAt((n >>> 18) & 63) +
      ALPHABET.charAt((n >>> 12) & 63) +
      ALPHABET.charAt((n >>> 6) & 63) +
      ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    out += ALPHABET.charAt((n >>> 18) & 63) + ALPHABET.charAt((n >>> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out +=
      ALPHABET.charAt((n >>> 18) & 63) +
      ALPHABET.charAt((n >>> 12) & 63) +
      ALPHABET.charAt((n >>> 6) & 63);
  }
  return out;
}

/**
 * Decode strict unpadded base64url. Rejects: padding, `+` `/`, whitespace, any other character,
 * impossible lengths (len % 4 == 1) and non-canonical encodings (non-zero trailing bits).
 * The empty string decodes to an empty array.
 */
export function base64urlDecode(input: string): Uint8Array {
  const len = input.length;
  if (len % 4 === 1) throw new Base64UrlError('invalid base64url length');
  const out = new Uint8Array(Math.floor((len * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const c = input.charCodeAt(i);
    const v = c < 128 ? (LOOKUP[c] as number) : -1;
    if (v < 0) throw new Base64UrlError('invalid base64url character');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new Base64UrlError('non-canonical base64url (trailing bits)');
  return out;
}

/** Non-throwing check: is `s` strict base64url, optionally decoding to exactly `byteLength` bytes. */
export function isBase64url(s: string, byteLength?: number): boolean {
  try {
    const d = base64urlDecode(s);
    return byteLength === undefined || d.length === byteLength;
  } catch {
    return false;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8Encode(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Throws on invalid UTF-8. */
export function utf8Decode(b: Uint8Array): string {
  return decoder.decode(b);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Constant-time (in content) equality. Lengths are not secret and are compared first. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
