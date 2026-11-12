import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  Api,
  addExtension,
  createAccount,
  KeyPair,
  TestDevice,
  unlockPayload,
} from './helpers/client';
import { createTestEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let api: Api;
const admin = { kind: 'sig' as const };
const seal = () => ({
  epk: new KeyPair().pub,
  nonce: randomBytes(12).toString('base64url'),
  ct: randomBytes(60).toString('base64url'),
});
beforeAll(async () => {
  env = await createTestEnv();
  api = new Api(env);
});
afterAll(async () => env.close());

describe('devices', () => {
  test('list, push token, revoke (self sign-out allowed), other accounts unreachable', async () => {
    const a = await createAccount(api);
    const ext = await addExtension(api, a);
    const list = await api.ok('listDevices', { device: a.device });
    expect(list.devices.map((d: { deviceId: string }) => d.deviceId).sort()).toEqual(
      [a.device.id, ext.id].sort(),
    );
    expect(list.devices.every((d: { revokedAt: null }) => d.revokedAt === null)).toBe(true);

    await api.ok('putPushToken', {
      device: a.device,
      body: { pushPlatform: 'fcm', token: 'tok-1' },
    });
    const b = await createAccount(api);
    await api.err('deleteDevice', 'E_NOT_FOUND', {
      device: b.device,
      admin,
      params: { id: ext.id },
    });
    await api.err('deleteDevice', 'E_UNAUTHORIZED', { device: a.device, params: { id: ext.id } });

    await api.ok('deleteDevice', { device: a.device, admin, params: { id: ext.id } });
    await api.ok('deleteDevice', { device: a.device, admin, params: { id: ext.id } }); // idempotent
    await api.err('getRecords', 'E_DEVICE_REVOKED', { device: ext, query: { since: 0 } });
    expect(
      (await api.ok('listDevices', { device: a.device })).devices.find(
        (d: { deviceId: string }) => d.deviceId === ext.id,
      ).revokedAt,
    ).not.toBeNull();

    // sign out of this very device
    await api.ok('deleteDevice', { device: a.device, admin, params: { id: a.device.id } });
    await api.err('listDevices', 'E_DEVICE_REVOKED', { device: a.device });
    const kinds = (
      await env.deps.db
        .selectFrom('audit_events')
        .select('kind')
        .where('account_id', '=', a.accountId)
        .orderBy('id')
        .execute()
    ).map((e) => e.kind);
    expect(kinds).toEqual([
      'account_created',
      'device_added',
      'device_revoked',
      'device_signed_out',
    ]);
  });
});

describe('pairing (8.3)', () => {
  test('full flow: public data, approve, status with sealed response', async () => {
    const a = await createAccount(api);
    const ext = new TestDevice('extension', 'edge');
    const eph = new KeyPair();
    const p = await api.ok('createPairing', {
      body: { deviceId: ext.id, signPub: ext.signKey.pub, ephPub: eph.pub, platform: 'edge' },
    });
    const pairingAuth = `Pairing ${p.pollToken}`;
    expect(
      (await api.ok('pairingStatus', { params: { id: p.pairingId }, authorization: pairingAuth }))
        .status,
    ).toBe('pending');
    await api.err('pairingStatus', 'E_UNAUTHORIZED', {
      params: { id: p.pairingId },
      authorization: `Pairing ${randomBytes(32).toString('base64url')}`,
    });

    const info = await api.ok('getPairing', { device: a.device, params: { id: p.pairingId } });
    expect(info).toMatchObject({
      deviceId: ext.id,
      signPub: ext.signKey.pub,
      ephPub: eph.pub,
      platform: 'edge',
    });

    const response = seal();
    await api.err('approvePairing', 'E_UNAUTHORIZED', {
      device: a.device,
      params: { id: p.pairingId },
      body: { response },
    });
    await api.ok('approvePairing', {
      device: a.device,
      admin,
      params: { id: p.pairingId },
      body: { response },
    });
    await api.err('approvePairing', 'E_ALREADY_HANDLED', {
      device: a.device,
      admin,
      params: { id: p.pairingId },
      body: { response },
    });
    const st = await api.ok('pairingStatus', {
      params: { id: p.pairingId },
      authorization: pairingAuth,
    });
    expect(st).toEqual({ status: 'approved', accountId: a.accountId, response });
    await api.login(ext);
    expect((await api.ok('listDevices', { device: a.device })).devices).toHaveLength(2);
  });

  test('expiry: status reports expired (200), get/approve give E_EXPIRED; device id reuse refused', async () => {
    const a = await createAccount(api);
    const ext = new TestDevice('extension');
    const p = await api.ok('createPairing', {
      body: {
        deviceId: ext.id,
        signPub: ext.signKey.pub,
        ephPub: new KeyPair().pub,
        platform: 'chrome',
      },
    });
    env.clock.advance(5 * 60_000 + 1000);
    await api.login(a.device);
    expect(
      await api.ok('pairingStatus', {
        params: { id: p.pairingId },
        authorization: `Pairing ${p.pollToken}`,
      }),
    ).toEqual({ status: 'expired' });
    await api.err('getPairing', 'E_EXPIRED', { device: a.device, params: { id: p.pairingId } });
    await api.err('approvePairing', 'E_EXPIRED', {
      device: a.device,
      admin,
      params: { id: p.pairingId },
      body: { response: seal() },
    });
    await api.err('getPairing', 'E_NOT_FOUND', { device: a.device, params: { id: randomUUID() } });
    await api.err('createPairing', 'E_INVALID', {
      body: {
        deviceId: a.device.id,
        signPub: ext.signKey.pub,
        ephPub: new KeyPair().pub,
        platform: 'chrome',
      },
    });
  });
});

describe('unlock requests (8.4)', () => {
  test('create -> push -> pending -> poll -> approve; single use', async () => {
    const a = await createAccount(api);
    const ext = await addExtension(api, a);
    await api.ok('putPushToken', {
      device: a.device,
      body: { pushPlatform: 'apns', token: 'apns-token' },
    });
    const payload = unlockPayload(ext, a.accountId)(env.clock.now());
    const c = await api.ok('createUnlockRequest', { device: ext, body: payload });
    await env.deps.tasks.idle();
    expect(env.push.sent).toHaveLength(1);
    expect(env.push.sent[0]).toMatchObject({
      target: { deviceId: a.device.id, platform: 'apns', token: 'apns-token' },
      payload: { t: 'unlock', r: c.requestId },
      opts: { ttlSec: 120, collapseId: c.requestId },
    });

    const pending = await api.ok('pendingUnlockRequests', { device: a.device });
    expect(pending.requests).toEqual([
      { requestId: c.requestId, deviceId: ext.id, expiresAt: c.expiresAt, payload },
    ]);
    expect(
      (await api.ok('getUnlockRequest', { device: ext, params: { id: c.requestId } })).status,
    ).toBe('pending');

    const response = seal();
    await api.ok('approveUnlockRequest', {
      device: a.device,
      params: { id: c.requestId },
      body: { response },
    });
    expect(await api.ok('getUnlockRequest', { device: ext, params: { id: c.requestId } })).toEqual({
      status: 'approved',
      response,
    });
    await api.err('approveUnlockRequest', 'E_ALREADY_HANDLED', {
      device: a.device,
      params: { id: c.requestId },
      body: { response },
    });
    await api.err('denyUnlockRequest', 'E_ALREADY_HANDLED', {
      device: a.device,
      params: { id: c.requestId },
      body: {},
    });
    expect((await api.ok('pendingUnlockRequests', { device: a.device })).requests).toEqual([]);
  });

  test('deny; expiry after 120s; only the creating extension may poll; foreign approver cannot decide', async () => {
    const a = await createAccount(api);
    const ext = await addExtension(api, a);
    const ext2 = await addExtension(api, a);
    const other = await createAccount(api);
    const c = await api.ok('createUnlockRequest', {
      device: ext,
      body: unlockPayload(ext, a.accountId)(env.clock.now()),
    });
    await api.err('getUnlockRequest', 'E_NOT_FOUND', { device: ext2, params: { id: c.requestId } });
    await api.err('approveUnlockRequest', 'E_NOT_FOUND', {
      device: other.device,
      params: { id: c.requestId },
      body: { response: seal() },
    });
    await api.ok('denyUnlockRequest', { device: a.device, params: { id: c.requestId }, body: {} });
    expect(await api.ok('getUnlockRequest', { device: ext, params: { id: c.requestId } })).toEqual({
      status: 'denied',
    });

    const c2 = await api.ok('createUnlockRequest', {
      device: ext,
      body: unlockPayload(ext, a.accountId)(env.clock.now()),
    });
    env.clock.advance(121_000);
    for (const d of [a.device, ext]) await api.login(d);
    expect(await api.ok('getUnlockRequest', { device: ext, params: { id: c2.requestId } })).toEqual(
      { status: 'expired' },
    );
    await api.err('approveUnlockRequest', 'E_EXPIRED', {
      device: a.device,
      params: { id: c2.requestId },
      body: { response: seal() },
    });
    expect((await api.ok('pendingUnlockRequests', { device: a.device })).requests).toEqual([]);
    const kinds = (
      await env.deps.db
        .selectFrom('audit_events')
        .select('kind')
        .where('account_id', '=', a.accountId)
        .execute()
    ).map((e) => e.kind);
    expect(kinds).toContain('unlock_denied');
  });

  test('signature is checked against the stored key; replayed nonce, skewed issuedAt refused', async () => {
    const a = await createAccount(api);
    const ext = await addExtension(api, a);
    const mk = unlockPayload(ext, a.accountId);
    const good = mk(env.clock.now());
    // tampered code
    await api.err('createUnlockRequest', 'E_UNAUTHORIZED', {
      device: ext,
      body: { ...good, code: '48' },
    });
    // signed by a different key
    const stranger = new TestDevice('extension');
    await api.err('createUnlockRequest', 'E_UNAUTHORIZED', {
      device: ext,
      body: unlockPayload(stranger, a.accountId)(env.clock.now()),
    });
    // another account's id in the signed string
    await api.err('createUnlockRequest', 'E_UNAUTHORIZED', {
      device: ext,
      body: unlockPayload(ext, randomUUID())(env.clock.now()),
    });

    await api.ok('createUnlockRequest', { device: ext, body: good });
    await api.err('createUnlockRequest', 'E_ALREADY_HANDLED', { device: ext, body: good });
    env.clock.advance(10 * 60_000 + 1000); // leave the per-device rate-limit window
    await api.login(ext);
    const old = new Date(env.clock.now().getTime() - 301_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const r = await api.err('createUnlockRequest', 'E_CLOCK_SKEW', {
      device: ext,
      body: unlockPayload(ext, a.accountId, { issuedAt: old })(env.clock.now()),
    });
    expect(r.body.error.details.serverTime).toBeDefined();
  });

  test('rate limit: 5 requests per device per 10 minutes', async () => {
    const a = await createAccount(api);
    const ext = await addExtension(api, a);
    for (let i = 0; i < 5; i++)
      await api.ok('createUnlockRequest', {
        device: ext,
        body: unlockPayload(ext, a.accountId)(env.clock.now()),
      });
    const r = await api.err('createUnlockRequest', 'E_RATE_LIMITED', {
      device: ext,
      body: unlockPayload(ext, a.accountId)(env.clock.now()),
    });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(r.body.error.details.retryAfterSec).toBe(Number(r.headers.get('retry-after')));
    env.clock.advance(10 * 60_000 + 1000);
    await api.login(ext);
    await api.ok('createUnlockRequest', {
      device: ext,
      body: unlockPayload(ext, a.accountId)(env.clock.now()),
    });
  });
});
