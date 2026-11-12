import { describe, expect, test } from 'vitest';
import { detectCsvFormat, findDuplicateDrafts, parseCsv, parseCsvImport } from '../src';
import { psl } from './helpers';

describe('csv parser', () => {
  test('quotes, embedded newlines, CRLF, BOM, blank lines', () => {
    const t = '﻿a,b,c\r\n"x,1","line1\nline2","he said ""hi"""\r\n\r\nlast,,\r\n';
    expect(parseCsv(t)).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'line1\nline2', 'he said "hi"'],
      ['last', '', ''],
    ]);
    expect(parseCsv('a,b')).toEqual([['a', 'b']]);
    expect(() => parseCsv('"abc')).toThrow();
    expect(() => parseCsv('"a"x,b')).toThrow();
  });
});

describe('csv formats', () => {
  test('chrome/edge', () => {
    const r = parseCsvImport(
      'name,url,username,password,note\nEx,example.com,al,pw1,"n1\nn2"\nNoPw,https://x.com,u,,\n',
    );
    expect(r.format).toBe('chrome');
    expect(r.drafts).toEqual([
      {
        title: 'Ex',
        username: 'al',
        password: 'pw1',
        urls: [{ url: 'https://example.com', match: 'domain' }],
        notes: 'n1\nn2',
        favorite: false,
      },
    ]);
    expect(r.skipped).toEqual([{ row: 3, reason: 'no_password' }]);
  });
  test('safari', () => {
    const r = parseCsvImport(
      'Title,URL,Username,Password,Notes,OTPAuth\nSite,https://s.example,u,p,,\n',
    );
    expect(r.format).toBe('safari');
    expect(r.drafts[0]?.title).toBe('Site');
  });
  test('1password', () => {
    const r = parseCsvImport(
      'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nOP,https://o.example,u,p,,1,0,,note\n',
    );
    expect(r.format).toBe('1password');
    expect(r.drafts[0]).toMatchObject({ title: 'OP', favorite: true, notes: 'note' });
  });
  test('bitwarden: skips non-login, multiple uris, favorite', () => {
    const csv =
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
      ',1,login,BW,"a\nb",,0,"https://a.example\nhttps://b.example",u,p,\n' +
      ',0,note,SecureNote,txt,,0,,,,\n' +
      ',0,card,Card,,,0,,,,\n';
    const r = parseCsvImport(csv);
    expect(r.format).toBe('bitwarden');
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).toMatchObject({ favorite: true, notes: 'a\nb' });
    expect(r.drafts[0]?.urls.map((u) => u.url)).toEqual(['https://a.example', 'https://b.example']);
    expect(r.skipped).toEqual([
      { row: 3, reason: 'not_login' },
      { row: 4, reason: 'not_login' },
    ]);
  });
  test('unknown header / empty', () => {
    expect(detectCsvFormat(['a', 'b'])).toBeNull();
    expect(() => parseCsvImport('a,b\n1,2')).toThrow();
    expect(() => parseCsvImport('')).toThrow();
  });
  test('duplicates by registrable domain + username', () => {
    const { drafts } = parseCsvImport(
      'name,url,username,password\nA,https://login.example.com,Alice,p\nB,https://example.com,bob,p\nC,https://other.org,alice,p\n',
    );
    const dup = findDuplicateDrafts(psl, drafts, [
      { username: 'alice', urls: [{ url: 'https://www.example.com', match: 'domain' }] },
    ]);
    expect(dup).toEqual([0]);
  });
});
