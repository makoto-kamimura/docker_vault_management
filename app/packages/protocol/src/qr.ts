import { normalizeAccountName } from './account-name';
import { base64urlDecode, base64urlEncode, utf8Decode, utf8Encode } from './base64url';
import { BYTES } from './limits';
import { RECOVERY_KEY_REGEX, uuidSchema } from './records';

// ---------------------------------------------------------------- server URL

export type ServerUrlOptions = {
  /**
   * G11: accept `http://localhost`, `http://127.0.0.1`, `http://10.0.2.2` (development builds only,
   * compile-time flag LV_DEV_ALLOW_HTTP). Production builds must leave this false.
   */
  allowInsecureLocalhost?: boolean;
};

export const INSECURE_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '10.0.2.2'] as const;

export type ServerUrlResult =
  | { ok: true; origin: string }
  | { ok: false; reason: 'invalid' | 'not_https' | 'has_path' | 'has_credentials' };

const HOST_RE =
  /^(?:\[[0-9a-fA-F:.]+\]|(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)$/;

/**
 * Validate a server URL and return its normalised origin (lower-case host, default port removed,
 * no trailing slash). Only an origin is accepted: no userinfo, path (other than "/"), query or
 * fragment. Hand-parsed because the React Native `URL` polyfill is unreliable. Internationalised
 * hosts must be given as Punycode.
 */
export function parseServerUrl(input: string, opts: ServerUrlOptions = {}): ServerUrlResult {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/.exec(input);
  if (!m) return { ok: false, reason: 'invalid' };
  const scheme = (m[1] as string).toLowerCase();
  const authority = m[2] as string;
  const rest = m[3] as string;
  if (scheme !== 'https' && scheme !== 'http') return { ok: false, reason: 'not_https' };
  if (authority.includes('@')) return { ok: false, reason: 'has_credentials' };
  if (rest !== '' && rest !== '/') return { ok: false, reason: 'has_path' };
  const am = /^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$/.exec(authority);
  if (!am) return { ok: false, reason: 'invalid' };
  const host = (am[1] as string).toLowerCase();
  const portStr = am[2];
  if (host === '' || !HOST_RE.test(host)) return { ok: false, reason: 'invalid' };
  let port: number | null = null;
  if (portStr !== undefined) {
    port = Number(portStr);
    if (port < 1 || port > 65535) return { ok: false, reason: 'invalid' };
  }
  if (scheme === 'http') {
    const allowed =
      opts.allowInsecureLocalhost === true &&
      (INSECURE_ALLOWED_HOSTS as readonly string[]).includes(host);
    if (!allowed) return { ok: false, reason: 'not_https' };
  }
  const defaultPort = scheme === 'https' ? 443 : 80;
  const hostPort = port === null || port === defaultPort ? host : `${host}:${port}`;
  return { ok: true, origin: `${scheme}://${hostPort}` };
}

export function isValidServerUrl(input: string, opts: ServerUrlOptions = {}): boolean {
  return parseServerUrl(input, opts).ok;
}

// ---------------------------------------------------------------- QR codecs

export class QrParseError extends Error {
  override readonly name = 'QrParseError';
}

function parseQuery(
  prefix: string,
  input: string,
  keys: readonly string[],
): Record<string, string> {
  if (!input.startsWith(prefix)) throw new QrParseError('wrong scheme or version');
  const query = input.slice(prefix.length);
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new QrParseError('malformed query');
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (!keys.includes(k)) throw new QrParseError(`unexpected key ${k}`);
    if (k in out) throw new QrParseError(`duplicate key ${k}`);
    if (v === '') throw new QrParseError(`empty value for ${k}`);
    out[k] = v;
  }
  for (const k of keys) if (!(k in out)) throw new QrParseError(`missing key ${k}`);
  return out;
}

function encodeServer(origin: string, opts: ServerUrlOptions): string {
  const r = parseServerUrl(origin, opts);
  if (!r.ok) throw new QrParseError(`invalid server url: ${r.reason}`);
  return base64urlEncode(utf8Encode(r.origin));
}

function decodeServer(s: string, opts: ServerUrlOptions): string {
  let url: string;
  try {
    url = utf8Decode(base64urlDecode(s));
  } catch {
    throw new QrParseError('invalid server field');
  }
  const r = parseServerUrl(url, opts);
  if (!r.ok) throw new QrParseError(`invalid server url: ${r.reason}`);
  if (r.origin !== url) throw new QrParseError('server url is not normalised');
  return r.origin;
}

// ---- lvkit (emergency kit, §5.5) ----
export type KitQr = { serverUrl: string; accountName: string; recoveryKey: string };

export function formatKitQr(v: KitQr, opts: ServerUrlOptions = {}): string {
  const name = normalizeAccountName(v.accountName);
  if (!name.ok || name.name !== v.accountName) throw new QrParseError('invalid account name');
  if (!RECOVERY_KEY_REGEX.test(v.recoveryKey)) throw new QrParseError('invalid recovery key');
  return `lvkit:v1?s=${encodeServer(v.serverUrl, opts)}&a=${v.accountName}&k=${v.recoveryKey}`;
}

export function parseKitQr(input: string, opts: ServerUrlOptions = {}): KitQr {
  const q = parseQuery('lvkit:v1?', input, ['s', 'a', 'k']);
  const name = normalizeAccountName(q.a as string);
  if (!name.ok || name.name !== q.a) throw new QrParseError('invalid account name');
  if (!RECOVERY_KEY_REGEX.test(q.k as string)) throw new QrParseError('invalid recovery key');
  return {
    serverUrl: decodeServer(q.s as string, opts),
    accountName: name.name,
    recoveryKey: q.k as string,
  };
}

// ---- lvpair (PC pairing, §8.3) ----
export type PairQr = { serverOrigin: string; pairingId: string; fingerprint: string };

export function formatPairQr(v: PairQr, opts: ServerUrlOptions = {}): string {
  if (!uuidSchema.safeParse(v.pairingId).success) throw new QrParseError('invalid pairing id');
  checkFingerprint(v.fingerprint);
  return `lvpair:v1?s=${encodeServer(v.serverOrigin, opts)}&p=${v.pairingId}&f=${v.fingerprint}`;
}

export function parsePairQr(input: string, opts: ServerUrlOptions = {}): PairQr {
  const q = parseQuery('lvpair:v1?', input, ['s', 'p', 'f']);
  if (!uuidSchema.safeParse(q.p).success) throw new QrParseError('invalid pairing id');
  checkFingerprint(q.f as string);
  return {
    serverOrigin: decodeServer(q.s as string, opts),
    pairingId: q.p as string,
    fingerprint: q.f as string,
  };
}

function checkFingerprint(f: string): void {
  let ok = false;
  try {
    ok = base64urlDecode(f).length === BYTES.fingerprint;
  } catch {
    ok = false;
  }
  if (!ok) throw new QrParseError('invalid fingerprint');
}

// ---- lvrc (recovery sheet, §8.11.2) ----
export type RcQr = { serverUrl: string; accountId: string; rc: string };

export function formatRcQr(v: RcQr, opts: ServerUrlOptions = {}): string {
  if (!uuidSchema.safeParse(v.accountId).success) throw new QrParseError('invalid account id');
  checkRc(v.rc);
  return `lvrc:v1?s=${encodeServer(v.serverUrl, opts)}&a=${v.accountId}&c=${v.rc}`;
}

export function parseRcQr(input: string, opts: ServerUrlOptions = {}): RcQr {
  const q = parseQuery('lvrc:v1?', input, ['s', 'a', 'c']);
  if (!uuidSchema.safeParse(q.a).success) throw new QrParseError('invalid account id');
  checkRc(q.c as string);
  return {
    serverUrl: decodeServer(q.s as string, opts),
    accountId: q.a as string,
    rc: q.c as string,
  };
}

function checkRc(c: string): void {
  let ok = false;
  try {
    ok = base64urlDecode(c).length === BYTES.rc;
  } catch {
    ok = false;
  }
  if (!ok) throw new QrParseError('invalid recovery code');
}
