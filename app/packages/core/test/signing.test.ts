import { base64urlEncode, unlockSignString } from '@localvault/protocol';
import { describe, expect, test } from 'vitest';
import {
  buildAdminHeader,
  evaluateCodeAttempt,
  pairingFingerprint,
  signAuthChallenge,
  signUnlockRequest,
  verifyAdminHeader,
  verifyAuthChallenge,
  verifyPairingFingerprint,
  verifyUnlockRequest,
} from '../src';
import { ACCOUNT, DEVICE, providers, REC } from './helpers';

describe.each(providers)('signing %s', (_n, p) => {
  async function setup() {
    const kp = await p.generateKeyPair();
    const pub = base64urlEncode(kp.publicKey);
    const eph = await p.generateKeyPair();
    const issuedAt = '2026-11-11T09:00:00Z';
    const fields = {
      accountId: ACCOUNT,
      deviceId: DEVICE,
      requestNonce: base64urlEncode(await p.randomBytes(16)),
      ephPub: base64urlEncode(eph.publicKey),
      code: '42',
      issuedAt,
    };
    const sig = await signUnlockRequest(p, kp.privateKey, fields);
    const trust = [
      {
        deviceId: DEVICE,
        name: 'My Chrome',
        type: 'extension' as const,
        platform: 'chrome' as const,
        signPub: pub,
        adminPub: null,
        addedAt: '2026-01-01T00:00:00.000Z',
        addedBy: REC,
        addedVia: 'pairing' as const,
        revokedAt: null as string | null,
      },
    ];
    const request = {
      deviceId: DEVICE,
      requestNonce: fields.requestNonce,
      ephPub: fields.ephPub,
      code: fields.code,
      issuedAt,
      sig,
    };
    const now = new Date('2026-11-11T09:01:00Z');
    return { kp, trust, request, now, fields };
  }

  test('verifyUnlockRequest: ok and every failure reason', async () => {
    const s = await setup();
    const input = {
      accountId: ACCOUNT,
      request: s.request,
      trust: s.trust,
      now: s.now,
      isNonceSeen: () => false,
    };
    expect(await verifyUnlockRequest(p, input)).toEqual({ ok: true, deviceName: 'My Chrome' });
    expect(await verifyUnlockRequest(p, { ...input, trust: [] })).toEqual({
      ok: false,
      reason: 'unknown_device',
    });
    expect(
      await verifyUnlockRequest(p, {
        ...input,
        trust: [{ ...(s.trust[0] as (typeof s.trust)[number]), type: 'mobile' }],
      }),
    ).toEqual({ ok: false, reason: 'unknown_device' });
    expect(
      await verifyUnlockRequest(p, {
        ...input,
        trust: [
          { ...(s.trust[0] as (typeof s.trust)[number]), revokedAt: '2026-02-01T00:00:00.000Z' },
        ],
      }),
    ).toEqual({ ok: false, reason: 'revoked' });
    // signature made by another key / changed code
    const other = await p.generateKeyPair();
    expect(
      await verifyUnlockRequest(p, {
        ...input,
        trust: [
          {
            ...(s.trust[0] as (typeof s.trust)[number]),
            signPub: base64urlEncode(other.publicKey),
          },
        ],
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(
      await verifyUnlockRequest(p, { ...input, request: { ...s.request, code: '43' } }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(
      await verifyUnlockRequest(p, { ...input, request: { ...s.request, code: '7' } }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyUnlockRequest(p, { ...input, accountId: REC })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // stale (both directions), boundary ok
    expect(
      await verifyUnlockRequest(p, { ...input, now: new Date('2026-11-11T09:05:01Z') }),
    ).toEqual({ ok: false, reason: 'stale' });
    expect(
      await verifyUnlockRequest(p, { ...input, now: new Date('2026-11-11T08:54:59Z') }),
    ).toEqual({ ok: false, reason: 'stale' });
    expect(
      (await verifyUnlockRequest(p, { ...input, now: new Date('2026-11-11T09:05:00Z') })).ok,
    ).toBe(true);
    expect(
      await verifyUnlockRequest(p, { ...input, isNonceSeen: (n) => n === s.request.requestNonce }),
    ).toEqual({ ok: false, reason: 'replayed' });
  });

  test('code attempts: 3 strikes', () => {
    expect(evaluateCodeAttempt({ typedCode: '42', signedCode: '42', failedAttempts: 2 })).toEqual({
      ok: true,
    });
    expect(evaluateCodeAttempt({ typedCode: '11', signedCode: '42', failedAttempts: 0 })).toEqual({
      ok: false,
      attemptsLeft: 2,
      reject: false,
    });
    expect(evaluateCodeAttempt({ typedCode: '11', signedCode: '42', failedAttempts: 2 })).toEqual({
      ok: false,
      attemptsLeft: 0,
      reject: true,
    });
  });

  test('auth challenge', async () => {
    const kp = await p.generateKeyPair();
    const challenge = base64urlEncode(await p.randomBytes(32));
    const sig = await signAuthChallenge(p, kp.privateKey, DEVICE, challenge);
    const pub = base64urlEncode(kp.publicKey);
    expect(await verifyAuthChallenge(p, pub, DEVICE, challenge, sig)).toBe(true);
    expect(await verifyAuthChallenge(p, pub, REC, challenge, sig)).toBe(false);
    expect(await verifyAuthChallenge(p, pub, DEVICE, challenge, 'not*base64')).toBe(false);
  });

  test('admin header', async () => {
    const kp = await p.generateKeyPair();
    const pub = base64urlEncode(kp.publicKey);
    const body = new TextEncoder().encode('{"a":1}');
    const req = { method: 'PUT' as const, path: '/v1/keyset?x=1', body };
    const h = await buildAdminHeader(p, kp.privateKey, {
      ...req,
      deviceId: DEVICE,
      nowSec: 1_800_000_000,
    });
    expect(h).toMatch(/^deviceId=[0-9a-f-]+, ts=1800000000, nonce=\S+, sig=\S+$/);
    expect((await verifyAdminHeader(p, pub, req, h, 1_800_000_100)).ok).toBe(true);
    expect(await verifyAdminHeader(p, pub, { ...req, path: '/v1/keyset' }, h)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await verifyAdminHeader(p, pub, { ...req, body: new Uint8Array(1) }, h)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await verifyAdminHeader(p, pub, { ...req, method: 'POST' }, h)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await verifyAdminHeader(p, pub, req, h, 1_800_000_301)).toEqual({
      ok: false,
      reason: 'clock_skew',
    });
    expect(await verifyAdminHeader(p, pub, req, 'garbage')).toEqual({
      ok: false,
      reason: 'malformed',
    });
    // no body: hash of empty input
    const h2 = await buildAdminHeader(p, kp.privateKey, {
      method: 'GET',
      path: '/v1/x',
      deviceId: DEVICE,
      nowSec: 5,
    });
    expect(
      (
        await verifyAdminHeader(
          p,
          pub,
          { method: 'GET', path: '/v1/x', body: new Uint8Array(0) },
          h2,
        )
      ).ok,
    ).toBe(true);
  });

  test('pairing fingerprint', async () => {
    const a = await p.generateKeyPair();
    const b = await p.generateKeyPair();
    const [sa, sb] = [base64urlEncode(a.publicKey), base64urlEncode(b.publicKey)];
    const f = await pairingFingerprint(p, sa, sb);
    expect(await verifyPairingFingerprint(p, sa, sb, f)).toBe(true);
    expect(await verifyPairingFingerprint(p, sb, sa, f)).toBe(false);
    expect(await verifyPairingFingerprint(p, sa, sb, '***')).toBe(false);
  });

  test('unlock string builder is the protocol one', async () => {
    const s = await setup();
    expect(unlockSignString(s.fields)).toContain('lv-unlock-v2');
  });
});
