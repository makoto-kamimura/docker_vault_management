import { base64urlDecode } from './base64url';
import { BYTES } from './limits';
import { uuidSchema } from './records';

export class HeaderParseError extends Error {
  override readonly name = 'HeaderParseError';
}

export const ADMIN_HEADER = 'X-LV-Admin';
export const AUTHKEY_HEADER = 'X-LV-AuthKey';

function isB64(s: string, n: number): boolean {
  try {
    return base64urlDecode(s).length === n;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- X-LV-Admin (§8.7)

export type AdminHeader = { deviceId: string; ts: number; nonce: string; sig: string };

/** `deviceId=<uuid>, ts=<unix seconds>, nonce=<b64url 16B>, sig=<b64url 64B>` */
export function formatAdminHeader(h: AdminHeader): string {
  validateAdmin(h);
  return `deviceId=${h.deviceId}, ts=${h.ts}, nonce=${h.nonce}, sig=${h.sig}`;
}

function validateAdmin(h: AdminHeader): void {
  if (!uuidSchema.safeParse(h.deviceId).success) throw new HeaderParseError('bad deviceId');
  if (!Number.isSafeInteger(h.ts) || h.ts < 0) throw new HeaderParseError('bad ts');
  if (!isB64(h.nonce, BYTES.adminNonce)) throw new HeaderParseError('bad nonce');
  if (!isB64(h.sig, BYTES.sig)) throw new HeaderParseError('bad sig');
}

export function parseAdminHeader(value: string): AdminHeader {
  const parts = value.split(', ');
  const keys = ['deviceId', 'ts', 'nonce', 'sig'];
  if (parts.length !== keys.length) throw new HeaderParseError('wrong field count');
  const map: Record<string, string> = {};
  parts.forEach((p, i) => {
    const key = keys[i] as string;
    if (!p.startsWith(`${key}=`)) throw new HeaderParseError(`expected ${key}`);
    map[key] = p.slice(key.length + 1);
  });
  if (!/^(0|[1-9][0-9]{0,15})$/.test(map.ts as string)) throw new HeaderParseError('bad ts');
  const h: AdminHeader = {
    deviceId: map.deviceId as string,
    ts: Number(map.ts),
    nonce: map.nonce as string,
    sig: map.sig as string,
  };
  validateAdmin(h);
  return h;
}

// ---------------------------------------------------------------- X-LV-AuthKey

export function formatAuthKeyHeader(authKey: string): string {
  if (!isB64(authKey, BYTES.authKey)) throw new HeaderParseError('bad authKey');
  return authKey;
}
export function parseAuthKeyHeader(value: string): string {
  return formatAuthKeyHeader(value);
}

// ---------------------------------------------------------------- Authorization

export type AuthorizationScheme = 'Bearer' | 'Pairing' | 'Claim';
export type Authorization = { scheme: AuthorizationScheme; token: string };

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function checkToken(scheme: AuthorizationScheme, token: string): void {
  if (scheme === 'Bearer') {
    if (!JWT_RE.test(token) || token.length > 2048) throw new HeaderParseError('bad bearer token');
  } else if (!isB64(token, scheme === 'Pairing' ? BYTES.pollToken : BYTES.claimToken)) {
    throw new HeaderParseError(`bad ${scheme} token`);
  }
}

export function formatAuthorization(a: Authorization): string {
  checkToken(a.scheme, a.token);
  return `${a.scheme} ${a.token}`;
}

export function parseAuthorization(value: string): Authorization {
  const sp = value.indexOf(' ');
  if (sp < 0) throw new HeaderParseError('missing token');
  const scheme = value.slice(0, sp);
  const token = value.slice(sp + 1);
  if (scheme !== 'Bearer' && scheme !== 'Pairing' && scheme !== 'Claim')
    throw new HeaderParseError('unknown scheme');
  checkToken(scheme, token);
  return { scheme, token };
}
