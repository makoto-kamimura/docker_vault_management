import { describe, expect, it } from 'vitest';
import {
  base64urlEncode,
  formatAdminHeader,
  formatAuthorization,
  formatKitQr,
  formatPairQr,
  formatRcQr,
  HeaderParseError,
  parseAdminHeader,
  parseAuthorization,
  parseKitQr,
  parsePairQr,
  parseRcQr,
  parseServerUrl,
  QrParseError,
  utf8Encode,
} from '../src/index';

const bytes = (n: number, v = 7) => base64urlEncode(new Uint8Array(n).fill(v));
const ID = '33333333-3333-4333-8333-333333333333';
const KEY = 'LV2-0123-4567-89AB-CDEF-GHJK-MNPQ-RSTV';

describe('parseServerUrl', () => {
  it('normalises https origins', () => {
    expect(parseServerUrl('https://Vault.Example.net/')).toEqual({
      ok: true,
      origin: 'https://vault.example.net',
    });
    expect(parseServerUrl('https://vault.example.net:443')).toEqual({
      ok: true,
      origin: 'https://vault.example.net',
    });
    expect(parseServerUrl('https://localhost:8443')).toEqual({
      ok: true,
      origin: 'https://localhost:8443',
    });
  });
  it('rejects http, paths, credentials and junk', () => {
    expect(parseServerUrl('http://vault.example.net')).toEqual({ ok: false, reason: 'not_https' });
    expect(parseServerUrl('https://a.example/x')).toEqual({ ok: false, reason: 'has_path' });
    expect(parseServerUrl('https://a.example/?q=1')).toEqual({ ok: false, reason: 'has_path' });
    expect(parseServerUrl('https://u:p@a.example')).toEqual({
      ok: false,
      reason: 'has_credentials',
    });
    expect(parseServerUrl('ftp://a.example')).toEqual({ ok: false, reason: 'not_https' });
    expect(parseServerUrl('vault.example.net').ok).toBe(false);
    expect(parseServerUrl('https://').ok).toBe(false);
    expect(parseServerUrl('https://a.example:99999').ok).toBe(false);
  });
  it('allows http only for dev hosts with the flag (G11)', () => {
    const dev = { allowInsecureLocalhost: true };
    expect(parseServerUrl('http://localhost:8787', dev)).toEqual({
      ok: true,
      origin: 'http://localhost:8787',
    });
    expect(parseServerUrl('http://10.0.2.2:8787', dev).ok).toBe(true);
    expect(parseServerUrl('http://127.0.0.1', dev).ok).toBe(true);
    expect(parseServerUrl('http://localhost:8787').ok).toBe(false);
    expect(parseServerUrl('http://192.168.0.5', dev).ok).toBe(false);
    expect(parseServerUrl('http://evil.localhost.example', dev).ok).toBe(false);
  });
});

describe('QR codecs', () => {
  const server = 'https://vault.example.net';
  const enc = base64urlEncode(utf8Encode(server));

  it('lvkit', () => {
    const s = `lvkit:v1?s=${enc}&a=alice&k=${KEY}`;
    expect(formatKitQr({ serverUrl: server, accountName: 'alice', recoveryKey: KEY })).toBe(s);
    expect(parseKitQr(s)).toEqual({ serverUrl: server, accountName: 'alice', recoveryKey: KEY });
  });
  it('lvpair', () => {
    const f = bytes(32);
    const s = `lvpair:v1?s=${enc}&p=${ID}&f=${f}`;
    expect(formatPairQr({ serverOrigin: server, pairingId: ID, fingerprint: f })).toBe(s);
    expect(parsePairQr(s)).toEqual({ serverOrigin: server, pairingId: ID, fingerprint: f });
  });
  it('lvrc', () => {
    const c = bytes(32);
    const s = `lvrc:v1?s=${enc}&a=${ID}&c=${c}`;
    expect(formatRcQr({ serverUrl: server, accountId: ID, rc: c })).toBe(s);
    expect(parseRcQr(s)).toEqual({ serverUrl: server, accountId: ID, rc: c });
  });
  it('rejects malformed input', () => {
    const f = bytes(32);
    expect(() => parsePairQr(`lvpair:v2?s=${enc}&p=${ID}&f=${f}`)).toThrow(QrParseError);
    expect(() => parsePairQr(`lvpair:v1?s=${enc}&p=${ID}`)).toThrow(QrParseError);
    expect(() => parsePairQr(`lvpair:v1?s=${enc}&p=${ID}&f=${f}&x=1`)).toThrow(QrParseError);
    expect(() => parsePairQr(`lvpair:v1?s=${enc}&s=${enc}&p=${ID}&f=${f}`)).toThrow(QrParseError);
    expect(() => parsePairQr(`lvpair:v1?s=${enc}&p=nope&f=${f}`)).toThrow(QrParseError);
    expect(() => parsePairQr(`lvpair:v1?s=${enc}&p=${ID}&f=${bytes(31)}`)).toThrow(QrParseError);
    expect(() =>
      parsePairQr(`lvpair:v1?s=${base64urlEncode(utf8Encode('http://a.example'))}&p=${ID}&f=${f}`),
    ).toThrow(QrParseError);
    expect(() => parseRcQr(`lvrc:v1?s=${enc}&a=${ID}&c=${bytes(31)}`)).toThrow(QrParseError);
    expect(() => parseKitQr(`lvkit:v1?s=${enc}&a=Alice&k=${KEY}`)).toThrow(QrParseError);
    expect(() => parseKitQr(`lvkit:v1?s=${enc}&a=alice&k=LV2-ILOU`)).toThrow(QrParseError);
    expect(() => parsePairQr('https://example.com')).toThrow(QrParseError);
  });
  it('dev http server only with flag', () => {
    const dev = base64urlEncode(utf8Encode('http://localhost:8787'));
    const s = `lvrc:v1?s=${dev}&a=${ID}&c=${bytes(32)}`;
    expect(() => parseRcQr(s)).toThrow(QrParseError);
    expect(parseRcQr(s, { allowInsecureLocalhost: true }).serverUrl).toBe('http://localhost:8787');
  });
});

describe('headers', () => {
  const h = { deviceId: ID, ts: 1789117200, nonce: bytes(16), sig: bytes(64) };
  it('X-LV-Admin round trip', () => {
    const s = formatAdminHeader(h);
    expect(s).toBe(`deviceId=${ID}, ts=1789117200, nonce=${h.nonce}, sig=${h.sig}`);
    expect(parseAdminHeader(s)).toEqual(h);
  });
  it('X-LV-Admin rejects bad input', () => {
    const ok = formatAdminHeader(h);
    expect(() => parseAdminHeader(ok.replace(', sig=', ', sg='))).toThrow(HeaderParseError);
    expect(() => parseAdminHeader(ok.replace('ts=1789117200', 'ts=01'))).toThrow(HeaderParseError);
    expect(() => parseAdminHeader(`${ok}, extra=1`)).toThrow(HeaderParseError);
    expect(() => parseAdminHeader(ok.replace(/sig=.*/, `sig=${bytes(63)}`))).toThrow(
      HeaderParseError,
    );
    expect(() => parseAdminHeader(ok.replace(ID, 'x'))).toThrow(HeaderParseError);
  });
  it('Authorization schemes', () => {
    const jwt = 'aaa.bbb.ccc';
    expect(parseAuthorization(formatAuthorization({ scheme: 'Bearer', token: jwt }))).toEqual({
      scheme: 'Bearer',
      token: jwt,
    });
    const t = bytes(32);
    expect(parseAuthorization(`Pairing ${t}`)).toEqual({ scheme: 'Pairing', token: t });
    expect(parseAuthorization(`Claim ${t}`)).toEqual({ scheme: 'Claim', token: t });
    expect(() => parseAuthorization(`Basic ${t}`)).toThrow(HeaderParseError);
    expect(() => parseAuthorization(`Claim ${bytes(31)}`)).toThrow(HeaderParseError);
    expect(() => parseAuthorization('Bearer not-a-jwt')).toThrow(HeaderParseError);
    expect(() => parseAuthorization('Bearer')).toThrow(HeaderParseError);
  });
});
