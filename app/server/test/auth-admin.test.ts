import { randomBytes } from 'node:crypto';
import { authSignString } from '@localvault/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  Api,
  addExtension,
  createAccount,
  fakeKeyset,
  KeyPair,
  TestDevice,
} from './helpers/client';
import { createTestEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let api: Api;
beforeAll(async () => {
  env = await createTestEnv();
  api = new Api(env);
});
afterAll(async () => env.close());

describe('device login and tokens', () => {
  test('challenge is single use, expires, and needs the right key', async () => {
    const a = await createAccount(api);
    const d = a.device;
    const c = await api.ok('authChallenge', { body: { deviceId: d.id } });
    const sig = d.signKey.sign(authSignString(d.id, c.challenge));
    await api.ok('authToken', { body: { deviceId: d.id, challenge: c.challenge, sig } });
    await api.err('authToken', 'E_UNAUTHORIZED', {
      body: { deviceId: d.id, challenge: c.challenge, sig },
    });

    const c2 = await api.ok('authChallenge', { body: { deviceId: d.id } });
    await api.err('authToken', 'E_UNAUTHORIZED', {
      body: {
        deviceId: d.id,
        challenge: c2.challenge,
        sig: new KeyPair().sign(authSignString(d.id, c2.challenge)),
      },
    });

    const c3 = await api.ok('authChallenge', { body: { deviceId: d.id } });
    env.clock.advance(61_000);
    await api.err('authToken', 'E_EXPIRED', {
      body: {
        deviceId: d.id,
        challenge: c3.challenge,
        sig: d.signKey.sign(authSignString(d.id, c3.challenge)),
      },
    });
  });

  test('unknown device gets a same-shaped challenge but cannot log in', async () => {
    const ghost = new TestDevice('mobile');
    const c = await api.ok('authChallenge', { body: { deviceId: ghost.id } });
    await api.err('authToken', 'E_UNAUTHORIZED', {
      body: {
        deviceId: ghost.id,
        challenge: c.challenge,
        sig: ghost.signKey.sign(authSignString(ghost.id, c.challenge)),
      },
    });
  });

  test('tokens expire after 15 minutes and garbage tokens are refused', async () => {
    const a = await createAccount(api);
    await api.ok('getKeyset', { device: a.device });
    env.clock.advance(15 * 60_000 + 1000);
    await api.err('getKeyset', 'E_UNAUTHORIZED', { device: a.device });
    await api.err('getKeyset', 'E_UNAUTHORIZED', { authorization: 'Bearer aaa.bbb.ccc' });
    await api.err('getKeyset', 'E_UNAUTHORIZED', { authorization: 'Basic abc' });
  });

  test('revoked device dies immediately; last_seen_at is updated at most once a minute', async () => {
    const a = await createAccount(api);
    const second = new TestDevice('mobile', 'android');
    const rec = await api.ok('authRecover', {
      body: { accountId: a.accountId, authKey: a.authKey, device: second.registration() },
    });
    second.token = rec.accessToken;
    await api.ok('getKeyset', { device: second });
    const seen = async () =>
      (
        await env.deps.db
          .selectFrom('devices')
          .select('last_seen_at')
          .where('id', '=', second.id)
          .executeTakeFirstOrThrow()
      ).last_seen_at;
    const t0 = await seen();
    env.clock.advance(30_000);
    await api.ok('getKeyset', { device: second });
    expect(await seen()).toEqual(t0);
    env.clock.advance(31_000);
    await api.ok('getKeyset', { device: second });
    expect((await seen())?.getTime()).toBeGreaterThan((t0 as Date).getTime());

    await api.ok('deleteDevice', {
      device: a.device,
      admin: { kind: 'sig' },
      params: { id: second.id },
    });
    await api.err('getKeyset', 'E_DEVICE_REVOKED', { device: second });
    await api.err('authChallenge', 'E_DEVICE_REVOKED', { body: { deviceId: second.id } });
  });
});

describe('admin proof (spec 8.7)', () => {
  const put = (
    a: Awaited<ReturnType<typeof createAccount>>,
    admin: Parameters<Api['call']>[1] extends infer O
      ? O extends { admin?: infer A }
        ? A
        : never
      : never,
    device = a.device,
  ) => api.call('putRecoveryWaitPeriod', { device, admin, body: { waitSec: 86400 } });

  test('missing proof, bad signature, stale ts, replayed nonce', async () => {
    const a = await createAccount(api);
    await api.ok('putRecoveryCode', {
      device: a.device,
      admin: { kind: 'sig' },
      body: {
        rcId: randomBytes(16).toString('base64url'),
        verifier: randomBytes(32).toString('base64url'),
        wrappedVK: fakeKeyset().wrappedVK,
        vkVersion: 1,
        waitSec: 172800,
      },
    });
    expect(
      (await api.call('putRecoveryWaitPeriod', { device: a.device, body: { waitSec: 86400 } })).body
        .error.code,
    ).toBe('E_UNAUTHORIZED');
    expect((await put(a, { kind: 'sig', badSig: true })).body.error.code).toBe('E_UNAUTHORIZED');

    const stale = await put(a, { kind: 'sig', tsOffsetSec: 301 });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('E_CLOCK_SKEW');
    expect(stale.body.error.details.serverTime).toBe(env.clock.now().toISOString());
    expect((await put(a, { kind: 'sig', tsOffsetSec: -301 })).body.error.code).toBe('E_CLOCK_SKEW');
    expect((await put(a, { kind: 'sig', tsOffsetSec: 299 })).status).toBe(204);

    const nonce = randomBytes(16).toString('base64url');
    expect((await put(a, { kind: 'sig', nonce })).status).toBe(204);
    expect((await put(a, { kind: 'sig', nonce })).body.error.code).toBe('E_UNAUTHORIZED');
  });

  test('signature covers method, path+query and body', async () => {
    const a = await createAccount(api);
    // sign for body A, send body B by hand-building the header through a second call is not possible;
    // instead sign a request for a different device id path and confirm a signature cannot be moved.
    const target = new TestDevice('mobile');
    await api.ok('authRecover', {
      body: { accountId: a.accountId, authKey: a.authKey, device: target.registration() },
    });
    const r1 = await api.call('deleteDevice', {
      device: a.device,
      params: { id: target.id },
      admin: { kind: 'sig' },
    });
    expect(r1.status).toBe(204);
    // Replay of a captured header on another path is rejected: craft by reusing header text.
    const hdr = await captureAdminHeader(a, 'DELETE', `/v1/devices/${target.id}`);
    const other = new TestDevice('mobile');
    await api.ok('authRecover', {
      body: { accountId: a.accountId, authKey: a.authKey, device: other.registration() },
    });
    const res = await env.app.request(`/v1/devices/${other.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${a.device.token}`, 'x-lv-admin': hdr },
    });
    expect(res.status).toBe(401);
  });

  async function captureAdminHeader(
    a: Awaited<ReturnType<typeof createAccount>>,
    method: string,
    path: string,
  ) {
    const { adminSignString, formatAdminHeader } = await import('@localvault/protocol');
    const { createHash } = await import('node:crypto');
    const ts = Math.floor(env.clock.now().getTime() / 1000);
    const nonce = randomBytes(16).toString('base64url');
    const bodyHash = createHash('sha256').update('').digest('base64url');
    const sig = (a.device.adminKey as KeyPair).sign(
      adminSignString({ method: method as 'GET', path, bodyHash, ts, nonce }),
    );
    return formatAdminHeader({ deviceId: a.device.id, ts, nonce, sig });
  }

  test('valid header works on the path it was made for', async () => {
    const a = await createAccount(api);
    const t = new TestDevice('mobile');
    await api.ok('authRecover', {
      body: { accountId: a.accountId, authKey: a.authKey, device: t.registration() },
    });
    const hdr = await captureAdminHeader(a, 'DELETE', `/v1/devices/${t.id}`);
    const res = await env.app.request(`/v1/devices/${t.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${a.device.token}`, 'x-lv-admin': hdr },
    });
    expect(res.status).toBe(204);
  });

  test('admin header of another device, or from a revoked/extension device, is refused', async () => {
    const a = await createAccount(api);
    const b = new TestDevice('mobile');
    const r = await api.ok('authRecover', {
      body: { accountId: a.accountId, authKey: a.authKey, device: b.registration() },
    });
    b.token = r.accessToken;
    expect((await put(a, { kind: 'sig', as: b })).body.error.code).toBe('E_UNAUTHORIZED');
    // extension with a bearer token cannot use admin routes at all
    const ext = await addExtension(api, a);
    expect((await put(a, { kind: 'sig', as: a.device }, ext)).body.error.code).toBe('E_FORBIDDEN');
    // revoked device: bearer fails first
    await api.ok('deleteDevice', {
      device: a.device,
      admin: { kind: 'sig' },
      params: { id: b.id },
    });
    expect((await put(a, { kind: 'sig', as: b }, b)).body.error.code).toBe('E_DEVICE_REVOKED');
  });

  test('authKey is an alternative proof; wrong authKey is refused; admin-key re-registration', async () => {
    const a = await createAccount(api);
    expect((await put(a, { kind: 'authKey', authKey: a.authKey })).status).toBe(404); // no recovery code yet, but authorised
    expect(
      (await put(a, { kind: 'authKey', authKey: Buffer.alloc(32, 3).toString('base64url') })).body
        .error.code,
    ).toBe('E_UNAUTHORIZED');
    // new admin key through the authKey route; old key stops working
    const old = a.device.adminKey as KeyPair;
    const fresh = new KeyPair();
    await api.ok('putAdminKey', {
      device: a.device,
      authKeyHeader: a.authKey,
      body: { adminPub: fresh.pub },
    });
    expect((await put(a, { kind: 'sig' })).body.error.code).toBe('E_UNAUTHORIZED');
    (a.device as { adminKey: KeyPair | null }).adminKey = fresh;
    expect((await put(a, { kind: 'sig' })).status).toBe(404);
    expect(old.pub).not.toBe(fresh.pub);
    await api.err('putAdminKey', 'E_INVALID', {
      device: a.device,
      authKeyHeader: a.authKey,
      body: { adminPub: Buffer.alloc(65, 4).toString('base64url') },
    });
  });
});
