import { describe, expect, test } from 'vitest';
import { matchItems, PublicSuffixList, parseUrl, toAsciiHost } from '../src';
import { PSL_COMPACT } from '../src/psl-data';
import { psl } from './helpers';

const entry = (id: string, url: string, match: 'domain' | 'host' = 'domain', extra = {}) => ({
  id,
  urls: [{ url, match }],
  ...extra,
});
const ids = (req: string, entries: ReturnType<typeof entry>[]) =>
  matchItems(psl, { url: req }, entries).map((c) => c.id);

describe('matching (spec 9.5)', () => {
  test('T-01..T-10', () => {
    expect(ids('https://www.example.com/login', [entry('a', 'https://example.com')])).toEqual([
      'a',
    ]); // T-01
    expect(ids('https://login.example.com', [entry('a', 'https://example.com')])).toEqual(['a']); // T-02
    expect(
      ids('https://accounts.example.co.jp', [entry('a', 'https://www.example.co.jp')]),
    ).toEqual(['a']); // T-03
    expect(ids('https://example.com.evil.net', [entry('a', 'https://example.com')])).toEqual([]); // T-04
    expect(ids('https://examp1e.com', [entry('a', 'https://example.com')])).toEqual([]); // T-05
    expect(ids('https://bob.github.io', [entry('a', 'https://alice.github.io')])).toEqual([]); // T-06
    expect(ids('https://www.example.com', [entry('a', 'https://example.com', 'host')])).toEqual([]); // T-07
    expect(ids('http://example.com', [entry('a', 'https://example.com')])).toEqual([]); // T-08
    expect(ids('https://192.168.0.1:8443', [entry('a', 'https://192.168.0.1')])).toEqual(['a']); // T-09
    expect(ids('https://xn--wgv71a119e.jp', [entry('a', 'https://日本語.jp')])).toEqual(['a']); // T-10
  });
  test('T-14..T-16 (frame origin is what is matched; trashed never)', () => {
    expect(ids('https://pay.example.com', [entry('a', 'https://pay.example.com', 'host')])).toEqual(
      ['a'],
    ); // T-14
    expect(ids('https://ads.evil.net', [entry('a', 'https://shop.test')])).toEqual([]); // T-15
    expect(
      ids('https://example.com', [
        entry('a', 'https://example.com', 'domain', { trashedAt: '2026-01-01T00:00:00Z' }),
      ]),
    ).toEqual([]); // T-16
  });
  test('ranking: host before domain, then most recently used', () => {
    const r = ids('https://www.example.com', [
      entry('dom-new', 'https://example.com', 'domain', { lastUsedAt: '2026-05-01T00:00:00Z' }),
      entry('host', 'https://www.example.com', 'host', { lastUsedAt: '2020-01-01T00:00:00Z' }),
      entry('dom-old', 'https://example.com', 'domain', { lastUsedAt: '2026-01-01T00:00:00Z' }),
    ]);
    expect(r).toEqual(['host', 'dom-new', 'dom-old']);
  });
  test('localhost, unknown TLD, IPs and public suffixes match exactly only', () => {
    expect(ids('https://a.localhost', [entry('x', 'https://b.localhost')])).toEqual([]);
    expect(ids('https://localhost', [entry('x', 'https://localhost')])).toEqual(['x']);
    expect(ids('https://a.corp.invalid', [entry('x', 'https://b.corp.invalid')])).toEqual([]);
    expect(ids('https://co.uk', [entry('x', 'https://other.co.uk')])).toEqual([]);
    expect(ids('https://[::1]:8080/x', [entry('x', 'https://[::1]')])).toEqual(['x']);
  });
  test('PSL wildcard and exception rules', () => {
    expect(psl.registrableDomain('www.ck')).toBe('www.ck'); // !www.ck
    expect(psl.registrableDomain('a.b.ck')).toBe('a.b.ck'); // *.ck -> b.ck is the suffix
    expect(psl.registrableDomain('b.ck')).toBeNull();
    expect(psl.registrableDomain('example.com')).toBe('example.com');
    expect(psl.registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(psl.registrableDomain('x.alice.github.io')).toBe('alice.github.io');
    expect(PublicSuffixList.fromCompact(PSL_COMPACT).size).toBeGreaterThan(9000);
  });
  test('host normalisation', () => {
    expect(toAsciiHost('Example.COM.')).toBe('example.com');
    expect(toAsciiHost('日本語.jp')).toBe('xn--wgv71a119e.jp');
    expect(toAsciiHost('bücher.de')).toBe('xn--bcher-kva.de');
    expect(toAsciiHost('a b.com')).toBeNull();
    expect(toAsciiHost('a..com')).toBeNull();
    expect(parseUrl('https://user:pw@Example.com:8443/p?q')).toEqual({
      scheme: 'https',
      host: 'example.com',
    });
  });
});
