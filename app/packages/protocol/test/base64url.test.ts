import { describe, expect, it } from 'vitest';
import {
  Base64UrlError,
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  equalBytes,
  isBase64url,
  utf8Decode,
  utf8Encode,
} from '../src/index';

describe('base64url', () => {
  it('matches RFC 4648 vectors (unpadded)', () => {
    const v: [string, string][] = [
      ['', ''],
      ['f', 'Zg'],
      ['fo', 'Zm8'],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg'],
      ['fooba', 'Zm9vYmE'],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [plain, enc] of v) {
      expect(base64urlEncode(utf8Encode(plain))).toBe(enc);
      expect(utf8Decode(base64urlDecode(enc))).toBe(plain);
    }
  });

  it('uses - and _ instead of + and /', () => {
    expect(base64urlEncode(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe('-__-');
    expect([...base64urlDecode('-__-')]).toEqual([0xfb, 0xff, 0xfe]);
  });

  it('round trips every length 0..70 with all byte values', () => {
    for (let n = 0; n <= 70; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      expect([...base64urlDecode(base64urlEncode(b))]).toEqual([...b]);
    }
    const all = new Uint8Array(256).map((_, i) => i);
    expect([...base64urlDecode(base64urlEncode(all))]).toEqual([...all]);
  });

  it('rejects padding, std alphabet, whitespace, bad length and non-canonical tails', () => {
    for (const bad of [
      'Zg==',
      'Zm8=',
      'a+b/',
      'Zm9v ',
      ' Zm9v',
      'Zm9v\n',
      'A',
      'AAAAA',
      'Zh',
      'Zm9',
      'é',
      'Zm9v!',
    ]) {
      expect(() => base64urlDecode(bad), bad).toThrow(Base64UrlError);
      expect(isBase64url(bad)).toBe(false);
    }
  });

  it('isBase64url checks byte length', () => {
    expect(isBase64url('Zm9v', 3)).toBe(true);
    expect(isBase64url('Zm9v', 4)).toBe(false);
  });
});

describe('bytes helpers', () => {
  it('concatBytes', () => {
    expect([...concatBytes(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3]))]).toEqual(
      [1, 2, 3],
    );
  });
  it('equalBytes', () => {
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(equalBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
  it('utf8 round trip and strict decode', () => {
    expect(utf8Decode(utf8Encode('日本語🔐'))).toBe('日本語🔐');
    expect(() => utf8Decode(new Uint8Array([0xff, 0xfe]))).toThrow();
  });
});
