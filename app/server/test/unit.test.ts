import { randomBytes } from 'node:crypto';
import { uuidSchema } from '@localvault/protocol';
import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';
import { importP256PublicKey } from '../src/crypto';
import { clientIp } from '../src/ip';
import { fakePrelogin } from '../src/prelogin';
import { RateLimiter } from '../src/ratelimit';
import { KeyPair } from './helpers/client';

const goodEnv = {
  DATABASE_URL: 'postgres://u:pw@db:5432/x',
  PUBLIC_ORIGIN: 'https://vault.example.net',
  TOKEN_SECRET: 'a'.repeat(40),
  PRELOGIN_SECRET: 'b'.repeat(40),
};

describe('config', () => {
  test('defaults', () => {
    const c = loadConfig(goodEnv);
    expect(c.registrationMode).toBe('invite');
    expect(c.trustProxy).toBe(0);
    expect(c.port).toBe(8787);
    expect(c.apns).toBeNull();
  });
  test('errors name variables but never print values', () => {
    let msg = '';
    try {
      loadConfig({
        ...goodEnv,
        TOKEN_SECRET: 'short-secret-value',
        REGISTRATION_MODE: 'weird',
        PRELOGIN_SECRET: undefined,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      msg = (e as Error).message;
    }
    expect(msg).toContain('TOKEN_SECRET');
    expect(msg).toContain('REGISTRATION_MODE');
    expect(msg).toContain('PRELOGIN_SECRET');
    expect(msg).not.toContain('short-secret-value');
    expect(msg).not.toContain('weird');
    expect(msg).not.toContain('pw@db');
  });
  test('_FILE variants', () => {
    const files: Record<string, string> = { '/s/tok': `${'c'.repeat(40)}\n` };
    const c = loadConfig(
      { ...goodEnv, TOKEN_SECRET: undefined, TOKEN_SECRET_FILE: '/s/tok' },
      (p) =>
        files[p] ??
        (() => {
          throw new Error('nope');
        })(),
    );
    expect(c.tokenSecret).toBe('c'.repeat(40));
    expect(() =>
      loadConfig({ ...goodEnv, TOKEN_SECRET_FILE: '/s/tok' }, (p) => files[p] as string),
    ).toThrow(/not both/);
    expect(() =>
      loadConfig({ ...goodEnv, TOKEN_SECRET: undefined, TOKEN_SECRET_FILE: '/missing' }, () => {
        throw new Error('x');
      }),
    ).toThrow(/TOKEN_SECRET_FILE/);
  });
  test('partial APNs config and bad TRUST_PROXY are rejected', () => {
    expect(() => loadConfig({ ...goodEnv, APNS_KEY_ID: 'K' })).toThrow(/APNS/);
    expect(() => loadConfig({ ...goodEnv, TRUST_PROXY: '-1' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ ...goodEnv, PUBLIC_ORIGIN: 'https://x.test/path' })).toThrow(
      /PUBLIC_ORIGIN/,
    );
  });
});

describe('rate limiter', () => {
  test('sliding window and retry-after', () => {
    const l = new RateLimiter();
    for (let i = 0; i < 3; i++) expect(l.hit('k', 3, 60, 1000 + i * 1000).ok).toBe(true);
    const r = l.hit('k', 3, 60, 4000);
    expect(r).toEqual({ ok: false, retryAfterSec: 57 });
    expect(l.hit('other', 3, 60, 4000).ok).toBe(true);
    expect(l.hit('k', 3, 60, 61_001).ok).toBe(true);
  });
  test('idle buckets are swept', () => {
    const l = new RateLimiter();
    l.hit('a', 1, 1, 0);
    l.hit('b', 1, 1, 200_000);
    expect(l.size).toBe(1);
  });
});

describe('client ip', () => {
  test('counts from the right', () => {
    expect(clientIp('1.1.1.1, 2.2.2.2', '9.9.9.9', 0)).toBe('9.9.9.9');
    expect(clientIp('spoof, 2.2.2.2', '9.9.9.9', 1)).toBe('2.2.2.2');
    expect(clientIp('spoof, 3.3.3.3, 2.2.2.2', '9.9.9.9', 2)).toBe('3.3.3.3');
    expect(clientIp('2.2.2.2', '9.9.9.9', 2)).toBe('9.9.9.9');
    expect(clientIp(undefined, undefined, 1)).toBe('unknown');
  });
});

describe('fake prelogin', () => {
  test('deterministic, uuid v4 shaped, differs per name and secret', () => {
    const a = fakePrelogin('s'.repeat(32), 'alice');
    expect(fakePrelogin('s'.repeat(32), 'alice')).toEqual(a);
    expect(uuidSchema.safeParse(a.accountId).success).toBe(true);
    expect(fakePrelogin('s'.repeat(32), 'bob')).not.toEqual(a);
    expect(fakePrelogin('t'.repeat(32), 'alice')).not.toEqual(a);
  });
});

describe('p256 import', () => {
  test('valid point accepted, off-curve / wrong prefix / length rejected', () => {
    const k = new KeyPair();
    const raw = Buffer.from(k.pub, 'base64url');
    expect(importP256PublicKey(raw)).not.toBeNull();
    const off = Buffer.from(raw);
    off[64] = (off[64] as number) ^ 1;
    expect(importP256PublicKey(off)).toBeNull();
    const bad = Buffer.from(raw);
    bad[0] = 2;
    expect(importP256PublicKey(bad)).toBeNull();
    expect(importP256PublicKey(randomBytes(64))).toBeNull();
  });
});
