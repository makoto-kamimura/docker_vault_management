import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  Api,
  change,
  createAccount,
  fakeKeyset,
  type TestAccount,
  TestDevice,
} from './helpers/client';
import { createTestEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let api: Api;
const admin = { kind: 'sig' as const };
const H = 3600_000;
beforeAll(async () => {
  env = await createTestEnv();
  api = new Api(env);
});
afterAll(async () => env.close());

type Rc = { rcId: string; authRC: string };
async function enable(a: TestAccount, waitSec: 86400 | 172800 | 259200 = 172800): Promise<Rc> {
  const rcId = randomBytes(16).toString('base64url');
  const authRC = randomBytes(32).toString('base64url');
  await api.ok('putRecoveryCode', {
    device: a.device,
    admin,
    body: {
      rcId,
      verifier: createHash('sha256').update(Buffer.from(authRC, 'base64url')).digest('base64url'),
      wrappedVK: fakeKeyset().wrappedVK,
      vkVersion: 1,
      waitSec,
    },
  });
  return { rcId, authRC };
}
const claim = (a: TestAccount, rc: Rc, d = new TestDevice('mobile', 'android'), ip?: string) =>
  api
    .call('createRecoveryClaim', {
      ip,
      body: { accountId: a.accountId, rcId: rc.rcId, authRC: rc.authRC, device: d.registration() },
    })
    .then((r) => ({ r, d }));

describe('recovery code settings', () => {
  test('get/put/wait-period/delete, stale vkVersion, extension forbidden', async () => {
    const a = await createAccount(api);
    expect(await api.ok('getRecoveryCode', { device: a.device })).toEqual({ enabled: false });
    await api.err('putRecoveryCode', 'E_STALE_KEY', {
      device: a.device,
      admin,
      body: {
        rcId: randomBytes(16).toString('base64url'),
        verifier: randomBytes(32).toString('base64url'),
        wrappedVK: fakeKeyset().wrappedVK,
        vkVersion: 2,
        waitSec: 86400,
      },
    });
    await api.err('putRecoveryWaitPeriod', 'E_NOT_FOUND', {
      device: a.device,
      admin,
      body: { waitSec: 86400 },
    });
    await enable(a);
    expect(await api.ok('getRecoveryCode', { device: a.device })).toMatchObject({
      enabled: true,
      waitSec: 172800,
      frozen: false,
    });
    await api.ok('putRecoveryWaitPeriod', { device: a.device, admin, body: { waitSec: 259200 } });
    expect((await api.ok('getRecoveryCode', { device: a.device })).waitSec).toBe(259200);
    await api.ok('deleteRecoveryCode', { device: a.device, admin });
    expect((await api.ok('getRecoveryCode', { device: a.device })).enabled).toBe(false);
    await api.ok('deleteRecoveryCode', { device: a.device, admin }); // idempotent
  });
});

describe('claims', () => {
  test('wrong authRC / rcId / unknown account are the same 401; a claim needs an enabled code', async () => {
    const a = await createAccount(api);
    const rc = await enable(a);
    const bad1 = await claim(a, { ...rc, authRC: randomBytes(32).toString('base64url') });
    const bad2 = await claim(a, { ...rc, rcId: randomBytes(16).toString('base64url') });
    const none = await api.call('createRecoveryClaim', {
      body: {
        accountId: randomUUID(),
        rcId: rc.rcId,
        authRC: rc.authRC,
        device: new TestDevice('mobile').registration(),
      },
    });
    for (const r of [bad1.r, bad2.r, none])
      expect([r.status, r.body.error.code]).toEqual([401, 'E_UNAUTHORIZED']);
    expect(bad1.r.body).toEqual(none.body);
  });

  test('wait period: E_CLAIM_WAITING until availableAt, then completes once (one-shot)', async () => {
    const a = await createAccount(api);
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(randomUUID(), 0)] },
    });
    const rc = await enable(a, 86400);
    const { r, d } = await claim(a, rc);
    expect(r.status).toBe(201);
    expect(r.body.accountName).toBe(a.name);
    expect(Date.parse(r.body.availableAt) - env.clock.now().getTime()).toBe(24 * H);
    await env.deps.tasks.idle();

    const auth = `Claim ${r.body.claimToken}`;
    const params = { id: r.body.claimId };
    expect((await api.ok('getRecoveryClaim', { params, authorization: auth })).status).toBe(
      'waiting',
    );
    await api.err('getRecoveryClaim', 'E_UNAUTHORIZED', {
      params,
      authorization: `Claim ${randomBytes(32).toString('base64url')}`,
    });
    const w = await api.err('completeRecoveryClaim', 'E_CLAIM_WAITING', {
      params,
      authorization: auth,
      body: {},
    });
    expect(w.body.error.details.availableAt).toBe(r.body.availableAt);

    const pending = await api.ok('pendingRecoveryClaims', { device: a.device });
    expect(pending.claims).toEqual([
      {
        claimId: r.body.claimId,
        createdAt: expect.any(String),
        availableAt: r.body.availableAt,
        status: 'waiting',
      },
    ]);

    env.clock.advance(24 * H + 1000);
    await api.login(a.device);
    const done = await api.ok('completeRecoveryClaim', { params, authorization: auth, body: {} });
    expect(done).toMatchObject({ accountName: a.name, vkVersion: 1, keyset: { keysetVersion: 1 } });
    d.token = done.accessToken;
    await api.ok('getKeyset', { device: d });
    await api.err('completeRecoveryClaim', 'E_CLAIM_CLOSED', {
      params,
      authorization: auth,
      body: {},
    });
    expect((await api.ok('getRecoveryCode', { device: a.device })).enabled).toBe(false);
    expect((await claim(a, rc)).r.status).toBe(401); // the code is gone
    const kinds = (await api.ok('listAuditEvents', { device: a.device, query: {} })).events.map(
      (e: { kind: string }) => e.kind,
    );
    expect(kinds).toEqual(expect.arrayContaining(['rc_issued', 'rc_claimed', 'rc_used']));
    // push to approvers at claim time
    expect(env.push.sent.filter((s) => s.payload.t === 'rc_claim')).toHaveLength(0); // no push token registered yet
  });

  test('cancel invalidates the code; approve-now allows immediate completion', async () => {
    const a = await createAccount(api);
    await api.ok('putPushToken', {
      device: a.device,
      body: { pushPlatform: 'fcm', token: 'fcm-1' },
    });
    const rc = await enable(a);
    const c1 = await claim(a, rc);
    await env.deps.tasks.idle();
    expect(env.push.sent.at(-1)?.payload).toEqual({ t: 'rc_claim', r: c1.r.body.claimId });
    expect(env.push.sent.at(-1)?.opts.ttlSec).toBe(172800);
    await api.err('cancelRecoveryClaim', 'E_UNAUTHORIZED', {
      device: a.device,
      params: { id: c1.r.body.claimId },
      body: {},
    });
    await api.ok('cancelRecoveryClaim', {
      device: a.device,
      admin,
      params: { id: c1.r.body.claimId },
      body: {},
    });
    expect(
      (
        await api.ok('getRecoveryClaim', {
          params: { id: c1.r.body.claimId },
          authorization: `Claim ${c1.r.body.claimToken}`,
        })
      ).status,
    ).toBe('canceled');
    await api.err('completeRecoveryClaim', 'E_CLAIM_CLOSED', {
      params: { id: c1.r.body.claimId },
      authorization: `Claim ${c1.r.body.claimToken}`,
      body: {},
    });
    expect((await api.ok('getRecoveryCode', { device: a.device })).enabled).toBe(false);
    await api.err('cancelRecoveryClaim', 'E_ALREADY_HANDLED', {
      device: a.device,
      admin,
      params: { id: c1.r.body.claimId },
      body: {},
    });

    const rc2 = await enable(a);
    const c2 = await claim(a, rc2);
    const p = { id: c2.r.body.claimId };
    const auth = `Claim ${c2.r.body.claimToken}`;
    await api.ok('approveRecoveryClaimNow', { device: a.device, admin, params: p, body: {} });
    const done = await api.ok('completeRecoveryClaim', {
      params: p,
      authorization: auth,
      body: {},
    });
    expect(done.accessToken).toBeDefined();
    await api.err('approveRecoveryClaimNow', 'E_CLAIM_CLOSED', {
      device: a.device,
      admin,
      params: p,
      body: {},
    });
  });

  test('second concurrent claim: both disputed, code frozen, rc_frozen push, nothing completes', async () => {
    const a = await createAccount(api);
    await api.ok('putPushToken', {
      device: a.device,
      body: { pushPlatform: 'apns', token: 'apns-1' },
    });
    const rc = await enable(a, 86400);
    const c1 = await claim(a, rc);
    const c2 = await claim(a, rc);
    expect(c2.r.status).toBe(201);
    await env.deps.tasks.idle();
    expect(env.push.sent.at(-1)?.payload).toEqual({ t: 'rc_frozen' });
    for (const c of [c1, c2]) {
      expect(
        (
          await api.ok('getRecoveryClaim', {
            params: { id: c.r.body.claimId },
            authorization: `Claim ${c.r.body.claimToken}`,
          })
        ).status,
      ).toBe('disputed');
    }
    expect(await api.ok('getRecoveryCode', { device: a.device })).toMatchObject({
      enabled: true,
      frozen: true,
    });
    const pend = await api.ok('pendingRecoveryClaims', { device: a.device });
    expect(pend.claims.map((c: { status: string }) => c.status)).toEqual(['disputed', 'disputed']);

    env.clock.advance(25 * H);
    await api.err('completeRecoveryClaim', 'E_RC_FROZEN', {
      params: { id: c1.r.body.claimId },
      authorization: `Claim ${c1.r.body.claimToken}`,
      body: {},
    });
    await api.err('approveRecoveryClaimNow', 'E_RC_FROZEN', {
      device: await relog(a),
      admin,
      params: { id: c1.r.body.claimId },
      body: {},
    });
    await api.err('createRecoveryClaim', 'E_RC_FROZEN', {
      body: {
        accountId: a.accountId,
        rcId: rc.rcId,
        authRC: rc.authRC,
        device: new TestDevice('mobile').registration(),
      },
    });
    const kinds = (
      await env.deps.db
        .selectFrom('audit_events')
        .select('kind')
        .where('account_id', '=', a.accountId)
        .execute()
    ).map((e) => e.kind);
    expect(kinds).toContain('rc_frozen');
    // the owner can still clean up
    await api.ok('cancelRecoveryClaim', {
      device: a.device,
      admin,
      params: { id: c1.r.body.claimId },
      body: {},
    });
    expect((await api.ok('getRecoveryCode', { device: a.device })).enabled).toBe(false);
  });

  async function relog(a: TestAccount) {
    await api.login(a.device);
    return a.device;
  }

  test('a claim expires 7 days after availableAt but the code stays valid', async () => {
    const a = await createAccount(api);
    const rc = await enable(a, 86400);
    const c = await claim(a, rc);
    const p = { id: c.r.body.claimId };
    const auth = `Claim ${c.r.body.claimToken}`;
    env.clock.advance(24 * H + 7 * 24 * H + 1000);
    expect((await api.ok('getRecoveryClaim', { params: p, authorization: auth })).status).toBe(
      'expired',
    );
    await api.err('completeRecoveryClaim', 'E_CLAIM_CLOSED', {
      params: p,
      authorization: auth,
      body: {},
    });
    await api.login(a.device);
    expect((await api.ok('pendingRecoveryClaims', { device: a.device })).claims).toEqual([]);
    expect((await api.ok('getRecoveryCode', { device: a.device })).enabled).toBe(true);
    // a new claim works again and is not treated as a conflict with the expired one
    const again = await claim(a, rc);
    expect(again.r.status).toBe(201);
    expect(
      (
        await api.ok('getRecoveryClaim', {
          params: { id: again.r.body.claimId },
          authorization: `Claim ${again.r.body.claimToken}`,
        })
      ).status,
    ).toBe('waiting');
  });

  test('re-issuing the code voids open claims; completion rate limit is 10/hour per claim', async () => {
    const a = await createAccount(api);
    const rc = await enable(a);
    const c = await claim(a, rc);
    await enable(a);
    expect(
      (
        await api.ok('getRecoveryClaim', {
          params: { id: c.r.body.claimId },
          authorization: `Claim ${c.r.body.claimToken}`,
        })
      ).status,
    ).toBe('canceled');

    const rc2 = await enable(a);
    const c2 = await claim(a, rc2);
    const p = { id: c2.r.body.claimId };
    const auth = `Claim ${c2.r.body.claimToken}`;
    for (let i = 0; i < 10; i++)
      await api.err('completeRecoveryClaim', 'E_CLAIM_WAITING', {
        params: p,
        authorization: auth,
        body: {},
      });
    const lim = await api.call('completeRecoveryClaim', {
      params: p,
      authorization: auth,
      body: {},
    });
    expect(lim.status).toBe(429);
  });

  test('claim creation limits: 5 per account per day', async () => {
    const a = await createAccount(api);
    const rc = await enable(a);
    const bad = { ...rc, authRC: randomBytes(32).toString('base64url') };
    for (let i = 0; i < 5; i++) expect((await claim(a, bad)).r.status).toBe(401);
    expect((await claim(a, rc)).r.status).toBe(429);
  });
});
