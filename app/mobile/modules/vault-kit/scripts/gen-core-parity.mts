// Generates Tests/VaultKitTests/Fixtures/core-parity.json: outputs of the TS reference
// (@localvault/core / @localvault/protocol) for many inputs, so the Swift port can be checked for
// identical behaviour where no crypto vector exists (matching, CSV, search, names, generator, ...).
// Run from the repo root:  pnpm --filter @localvault/mobile parity:core
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeterministicProvider } from '../../../../packages/core/src/crypto/deterministic';
import {
  conflictCopyTitle,
  createNobleProvider,
  findDuplicateDrafts,
  generatePassword,
  matchesQuery,
  matchItems,
  parseCsv,
  parseCsvImport,
  parseUrl,
  throttleWaitSec,
  toAsciiHost,
  VaultCoreError,
} from '../../../../packages/core/src/index';
import { hostOfStoredUrl } from '../../../../packages/core/src/matcher/match';
import { defaultPsl } from '../../../../packages/core/src/psl-data';
import { normalizeAccountName } from '../../../../packages/protocol/src/index';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../ios/Tests/VaultKitTests/Fixtures/core-parity.json');
const psl = defaultPsl();

/** Deterministic byte stream (SHA-256 counter mode) so the fixture is stable across runs. */
function stream(seed: string, n: number): Uint8Array {
  const o = new Uint8Array(n);
  let off = 0;
  for (let i = 0; off < n; i++) {
    const h = createHash('sha256').update(`${seed}|${i}`).digest();
    o.set(h.subarray(0, Math.min(32, n - off)), off);
    off += 32;
  }
  return o;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const err = (e: unknown) => (e instanceof VaultCoreError ? e.code : 'ERROR');

const hosts = [
  'Example.COM.',
  '日本語.jp',
  'bücher.de',
  'a b.com',
  'a..com',
  '',
  '.',
  'xn--wgv71a119e.jp',
  'ＥＸＡＭＰＬＥ．ｃｏｍ',
  'example。com',
  'mañana.com',
  'a_b.example',
  '-x.com',
  `${'x'.repeat(64)}.com`,
  `${'a.'.repeat(130)}com`,
  'münchen.de',
  'пример.рф',
  'ex%ample.com',
  'ex@mple.com',
  'tab\there.com',
  '例え.テスト',
  'ß.de',
  'İstanbul.tr',
  'faß.de',
  '😀.ws',
  'a　b.com',
  'zero​width.com',
];
const urls = [
  'https://user:pw@Example.com:8443/p?q',
  'https://www.example.com/login',
  'http://example.com',
  'example.com',
  '  https://example.com  ',
  'https://[::1]:8080/x',
  'https://[::1',
  'https://[::1]x',
  'ftp://files.example.com',
  'https://example.com:abc',
  'https://',
  'android://com.example',
  'otpauth://totp/x',
  'HTTPS://EXAMPLE.COM',
  'https://日本語.jp/パス',
  'https://a@b@c.example.com',
  '//example.com',
  'https:/example.com',
  '﻿https://bom.example',
  'https://example.com#frag',
  'https://example.com?x=1',
  'https://ex ample.com',
  'mailto:a@b.com',
];
const domains = [
  'www.ck',
  'a.b.ck',
  'b.ck',
  'example.com',
  'a.b.example.co.uk',
  'x.alice.github.io',
  'localhost',
  'co.uk',
  'printer.lan',
  '192.168.0.1',
  '[::1]',
  'xn--wgv71a119e.jp',
  'a.kawasaki.jp',
  'city.kawasaki.jp',
  'b.city.kawasaki.jp',
  'www.example.co.jp',
  'foo.s3.amazonaws.com',
  'com',
  '256.1.1.1',
  '01.2.3.4',
];

type E = {
  id: string;
  urls: { url: string; match: 'domain' | 'host' }[];
  lastUsedAt?: string;
  trashedAt?: string;
};
const e = (
  id: string,
  url: string,
  match: 'domain' | 'host' = 'domain',
  extra: Partial<E> = {},
): E => ({ id, urls: [{ url, match }], ...extra });
const matchCases: { request: string; entries: E[] }[] = [
  { request: 'https://www.example.com/login', entries: [e('a', 'https://example.com')] },
  { request: 'https://login.example.com', entries: [e('a', 'https://example.com')] },
  { request: 'https://accounts.example.co.jp', entries: [e('a', 'https://www.example.co.jp')] },
  { request: 'https://example.com.evil.net', entries: [e('a', 'https://example.com')] },
  { request: 'https://examp1e.com', entries: [e('a', 'https://example.com')] },
  { request: 'https://bob.github.io', entries: [e('a', 'https://alice.github.io')] },
  { request: 'https://www.example.com', entries: [e('a', 'https://example.com', 'host')] },
  { request: 'http://example.com', entries: [e('a', 'https://example.com')] },
  { request: 'https://192.168.0.1:8443', entries: [e('a', 'https://192.168.0.1')] },
  { request: 'https://xn--wgv71a119e.jp', entries: [e('a', 'https://日本語.jp')] },
  { request: 'https://pay.example.com', entries: [e('a', 'https://pay.example.com', 'host')] },
  {
    request: 'https://example.com',
    entries: [e('a', 'https://example.com', 'domain', { trashedAt: '2026-01-01T00:00:00Z' })],
  },
  {
    request: 'https://www.example.com',
    entries: [
      e('dom-new', 'https://example.com', 'domain', { lastUsedAt: '2026-05-01T00:00:00Z' }),
      e('host', 'https://www.example.com', 'host', { lastUsedAt: '2020-01-01T00:00:00Z' }),
      e('dom-old', 'https://example.com', 'domain', { lastUsedAt: '2026-01-01T00:00:00Z' }),
      e('none', 'example.com'),
      {
        id: 'multi',
        urls: [
          { url: 'https://example.com', match: 'domain' },
          { url: 'www.example.com', match: 'host' },
        ],
      },
    ],
  },
  { request: 'https://a.localhost', entries: [e('x', 'https://b.localhost')] },
  { request: 'https://localhost', entries: [e('x', 'https://localhost')] },
  { request: 'https://co.uk', entries: [e('x', 'https://other.co.uk')] },
  { request: 'https://[::1]:8080/x', entries: [e('x', 'https://[::1]')] },
  { request: 'not a url', entries: [e('x', 'https://example.com')] },
];

const csvTexts = [
  '﻿a,b,c\r\n"x,1","line1\nline2","he said ""hi"""\r\n\r\nlast,,\r\n',
  'a,b',
  '"abc',
  '"a"x,b',
  'name,url,username,password,note\nEx,example.com,al,pw1,"n1\nn2"\nNoPw,https://x.com,u,,\n',
  'Title,URL,Username,Password,Notes,OTPAuth\nSite,https://s.example,u,p,,\n',
  'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nOP,https://o.example,u,p,,1,0,,note\n',
  'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
    ',1,login,BW,"a\nb",,0,"https://a.example\nhttps://b.example",u,p,\n,0,note,SecureNote,txt,,0,,,,\n,0,card,Card,,,0,,,,\n',
  'a,b\n1,2',
  '',
  'name,url,username,password\n,https://only-host.example/x,,p\n,,user1,p\n,,,p\n' +
    `${'t'.repeat(150)},,u,p\n`,
  'name,url,username,password\nX,android://com.x example.com example.com otpauth://y,u,p\n',
  `name,url,username,password\nLong,,u,${'p'.repeat(1025)}\n`,
  'Title,Url,Username,Password,Type\nT,,u,p,Login\nT2,,u,p,password\n',
  'name,url,username,password\r\nCR,https://cr.example,u,p\rLF,https://lf.example,u,p\n',
];

const searches: [string, string[]][] = [
  ['', ['x']],
  ['git', ['GitHub', 'alice']],
  ['ＧＩＴ', ['github']],
  ['git ali', ['GitHub', 'alice@example.com']],
  ['git bob', ['GitHub', 'alice']],
  ['  ', ['a']],
  ['example.com', ['https://www.example.com']],
  ['ｶﾞ', ['ガイド']],
  ['é', ['café']],
  ['ß', ['STRASSE']],
];

const names = [
  'Alice',
  'alice',
  'al',
  'a'.repeat(33),
  'bad name',
  '-alice',
  'alice-',
  'a.b_c-d',
  'ＡＬＩＣＥ',
  ' alice',
  'İx',
  'abc',
];

const nfkcInputs = [
  'ｶﾞｷﾞｸﾞ',
  'ﾊﾟﾋﾟﾌﾟ',
  'ｳﾞ',
  'ＡＢＣ１２３',
  '①②',
  'ﬁ',
  'Å',
  'Å',
  'é',
  'é',
  '㍻',
  '㌔',
  'ﾞ',
  'ｶ ﾞ',
  '한국어',
  '한국어',
  '\u00a0x',
  'x\u3000y',
  'ẛ̣',
  '𝐀',
  'ﾟ',
  'ｶﾟ',
  'ﾍﾞﾝﾘ',
  'パ',
  'ﾟﾟ',
  'Ω',
  'Ω',
  '℃',
  '½',
];

const titles = ['GitHub', 'x'.repeat(100), '日本語'.repeat(40), '😀'.repeat(60), ''];

async function generatorCases() {
  const opts = [
    { length: 20, upper: true, lower: true, digits: true, symbols: true, excludeAmbiguous: false },
    { length: 8, upper: false, lower: false, digits: true, symbols: false, excludeAmbiguous: true },
    { length: 64, upper: true, lower: false, digits: false, symbols: true, excludeAmbiguous: true },
  ];
  const cases = [];
  for (const [k, o] of opts.entries()) {
    const det = createDeterministicProvider(createNobleProvider());
    const blocks: string[] = [];
    for (let i = 0; i < 8; i++) {
      const b = stream(`gen${k}`, 256 * (i + 1)).subarray(256 * i);
      det.enqueueRandom(b);
      blocks.push(hex(b));
    }
    const password = await generatePassword(det, o);
    // Count consumed blocks: drain the rest to find out how many were left.
    let left = 0;
    for (;;) {
      try {
        await det.randomBytes(256);
        left++;
      } catch {
        break;
      }
    }
    cases.push({ options: o, blocks: blocks.slice(0, 8 - left), password });
  }
  return cases;
}

const draftsForDup = parseCsvImport(
  'name,url,username,password\nA,https://login.example.com,Alice,p\nB,https://example.com,bob,p\nC,https://other.org,alice,p\nD,http://192.168.0.1,alice,p\n',
).drafts;

const fixture = {
  description: 'Generated by app/mobile/modules/vault-kit/scripts/gen-core-parity.ts. Do not edit.',
  toAsciiHost: hosts.map((h) => ({ input: h, output: toAsciiHost(h) })),
  parseUrl: urls.map((u) => ({ input: u, output: parseUrl(u), storedHost: hostOfStoredUrl(u) })),
  registrableDomain: domains.map((d) => ({ input: d, output: psl.registrableDomain(d) })),
  match: matchCases.map((m) => ({ ...m, output: matchItems(psl, { url: m.request }, m.entries) })),
  csv: csvTexts.map((t) => {
    let rows: string[][] | string;
    try {
      rows = parseCsv(t);
    } catch (x) {
      rows = err(x);
    }
    let result: unknown;
    try {
      result = parseCsvImport(t);
    } catch (x) {
      result = err(x);
    }
    return { input: t, rows, result };
  }),
  duplicates: {
    drafts: draftsForDup,
    existing: [
      { username: 'alice', urls: [{ url: 'https://www.example.com', match: 'domain' }] },
      { username: 'ALICE', urls: [{ url: 'https://192.168.0.1:8443', match: 'host' }] },
    ],
    output: findDuplicateDrafts(psl, draftsForDup, [
      { username: 'alice', urls: [{ url: 'https://www.example.com', match: 'domain' }] },
      { username: 'ALICE', urls: [{ url: 'https://192.168.0.1:8443', match: 'host' }] },
    ]),
  },
  search: searches.map(([q, h]) => ({ query: q, haystacks: h, output: matchesQuery(q, h) })),
  nfkc: nfkcInputs.map((t) => ({ input: t, output: t.normalize('NFKC') })),
  accountName: names.map((n) => ({ input: n, output: normalizeAccountName(n) })),
  conflictTitle: titles.map((t) => ({
    input: t,
    output: conflictCopyTitle(t, new Date('2026-11-14T23:59:59.999Z')),
  })),
  throttle: Array.from({ length: 22 }, (_, i) => ({ failed: i, wait: throttleWaitSec(i) })),
  generator: await generatorCases(),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${out}`);
