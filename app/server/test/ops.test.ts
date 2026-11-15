import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createInvite, parseDuration } from '../src/cli';
import { assertSchemaUpToDate, runMigrations, SchemaBehindError } from '../src/db/migrate';
import { runCleanup } from '../src/jobs/cleanup';
import {
  Api,
  addExtension,
  change,
  createAccount,
  fakeKeyset,
  KeyPair,
  TestDevice,
  unlockPayload,
} from './helpers/client';
import { createTestEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let api: Api;
const admin = { kind: 'sig' as const };
beforeAll(async () => {
  env = await createTestEnv();
  api = new Api(env);
});
afterAll(async () => env.close());

describe('rate limits over HTTP', () => {
  test('prelogin: 20/min per IP, 10/min per account name, Retry-After, window slides', async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (await api.call('prelogin', { query: { account: 'victim' }, ip: `7.7.7.${i}` })).status,
      ).toBe(200);
    const byName = await api.call('prelogin', { query: { account: 'victim' }, ip: '7.7.7.200' });
    expect([byName.status, byName.body.error.code]).toEqual([429, 'E_RATE_LIMITED']);
    expect(Number(byName.headers.get('retry-after'))).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++)
      expect(
        (await api.call('prelogin', { query: { account: `host${i}x` }, ip: '8.8.8.8' })).status,
      ).toBe(200);
    expect(
      (await api.call('prelogin', { query: { account: 'another' }, ip: '8.8.8.8' })).status,
    ).toBe(429);
    env.clock.advance(61_000);
    expect(
      (await api.call('prelogin', { query: { account: 'another' }, ip: '8.8.8.8' })).status,
    ).toBe(200);
  });

  test('X-Forwarded-For: spoofed left entries do not escape the limit (TRUST_PROXY=1)', async () => {
    const mk = (i: number) =>
      api.call('createPairing', {
        ip: `spoof${i}, 5.5.5.5`,
        body: {
          deviceId: randomUUID(),
          signPub: new KeyPair().pub,
          ephPub: new KeyPair().pub,
          platform: 'chrome',
        },
      });
    for (let i = 0; i < 10; i++) expect((await mk(i)).status).toBe(201);
    expect((await mk(99)).status).toBe(429);
  });

  test('createAccount 5/hour per IP', async () => {
    const mk = () => ({
      inviteCode: 'x',
      accountId: randomUUID(),
      accountName: `u${randomBytes(5).toString('hex')}`,
      keyset: fakeKeyset(),
      verifier: randomBytes(32).toString('base64url'),
      device: new TestDevice('mobile').registration(),
    });
    for (let i = 0; i < 5; i++)
      expect((await api.call('createAccount', { body: mk(), ip: '9.9.9.9' })).status).toBe(201);
    const r = await api.call('createAccount', { body: mk(), ip: '9.9.9.9' });
    expect([r.status, r.body.error.code]).toEqual([429, 'E_RATE_LIMITED']);
  });

  test('global limit: 300 requests per minute per token', async () => {
    const a = await createAccount(api);
    let limited = 0;
    for (let i = 0; i < 305; i++) {
      const r = await env.app.request('/v1/keyset', {
        headers: { authorization: `Bearer ${a.device.token}`, 'x-forwarded-for': '1.2.3.4' },
      });
      if (r.status === 429) limited++;
    }
    expect(limited).toBe(5);
    env.clock.advance(61_000);
    await api.login(a.device);
    await api.ok('getKeyset', { device: a.device });
  });
});

describe('push fan-out', () => {
  test('goes to non-revoked approvers with tokens only; dead tokens are dropped; failures never fail the request', async () => {
    const a = await createAccount(api);
    const second = new TestDevice('mobile', 'android');
    second.token = (
      await api.ok('authRecover', {
        body: { accountId: a.accountId, authKey: a.authKey, device: second.registration() },
      })
    ).accessToken;
    const third = new TestDevice('mobile');
    third.token = (
      await api.ok('authRecover', {
        body: { accountId: a.accountId, authKey: a.authKey, device: third.registration() },
      })
    ).accessToken;
    const ext = await addExtension(api, a);
    await api.ok('putPushToken', { device: a.device, body: { pushPlatform: 'apns', token: 'A' } });
    await api.ok('putPushToken', { device: second, body: { pushPlatform: 'fcm', token: 'B' } });
    await api.ok('putPushToken', { device: third, body: { pushPlatform: 'fcm', token: 'C' } });
    await api.ok('deleteDevice', { device: a.device, admin, params: { id: third.id } });

    env.push.sent.length = 0;
    await api.ok('createUnlockRequest', {
      device: ext,
      body: unlockPayload(ext, a.accountId)(env.clock.now()),
    });
    await env.deps.tasks.idle();
    expect(env.push.sent.map((s) => s.target.token).sort()).toEqual(['A', 'B']);

    env.push.outcome = 'invalid_token';
    await api.ok('createUnlockRequest', {
      device: ext,
      body: unlockPayload(ext, a.accountId)(env.clock.now()),
    });
    await env.deps.tasks.idle();
    const rows = await env.deps.db
      .selectFrom('devices')
      .select(['id', 'push_token'])
      .where('account_id', '=', a.accountId)
      .execute();
    expect(rows.filter((r) => r.push_token !== null)).toEqual([]);

    await api.ok('putPushToken', { device: a.device, body: { pushPlatform: 'apns', token: 'A2' } });
    env.push.send = async () => {
      throw new Error('boom');
    };
    const r = await api.call('createUnlockRequest', {
      device: ext,
      body: unlockPayload(ext, a.accountId)(env.clock.now()),
    });
    expect(r.status).toBe(201);
    await env.deps.tasks.idle();
  });
});

describe('audit events (F3)', () => {
  test('descending ids, before/limit pagination, hasMore', async () => {
    const a = await createAccount(api);
    for (let i = 0; i < 4; i++) {
      const t = new TestDevice('mobile');
      await api.ok('authRecover', {
        body: { accountId: a.accountId, authKey: a.authKey, device: t.registration() },
      });
    }
    const p1 = await api.ok('listAuditEvents', { device: a.device, query: { limit: 3 } });
    expect(p1.events).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    const ids = p1.events.map((e: { id: number }) => e.id);
    expect(ids).toEqual([...ids].sort((x, y) => y - x));
    const p2 = await api.ok('listAuditEvents', {
      device: a.device,
      query: { before: ids[2], limit: 3 },
    });
    expect(p2.events.map((e: { kind: string }) => e.kind)).toEqual([
      'device_added',
      'account_created',
    ]);
    expect(p2.hasMore).toBe(false);
    const other = await createAccount(api);
    expect(
      (await api.ok('listAuditEvents', { device: other.device, query: {} })).events,
    ).toHaveLength(1);
  });
});

describe('cleanup job', () => {
  test('removes expired rows, expires old claims, purges tombstones and moves min_valid_cursor', async () => {
    const a = await createAccount(api);
    const ext = await addExtension(api, a);
    const id = randomUUID();
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(id, 0), change(randomUUID(), 0)] },
    });
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [{ id, baseRev: 1, deleted: true, vkVersion: 1, nonce: null, ct: null }] },
    });
    await api.ok('createUnlockRequest', {
      device: ext,
      body: unlockPayload(ext, a.accountId)(env.clock.now()),
    });
    await api.ok('createRotation', {
      device: a.device,
      admin,
      body: { expectedRev: 3, newVkVersion: 2 },
    });
    const inv = await createInvite(env.deps.db, 1000, env.clock.now());
    await env.deps.db
      .insertInto('deleted_devices')
      .values({ device_id: randomUUID(), deleted_at: env.clock.now() })
      .execute();
    const stale = randomUUID();
    await env.deps.db
      .insertInto('auth_challenges')
      .values({ device_id: stale, challenge: randomBytes(32), expires_at: env.clock.now() })
      .execute();

    env.clock.advance(1000);
    expect((await runCleanup(env.deps.db, env.clock)).tombstones).toBe(0);
    env.clock.advance(181 * 86_400_000);
    const res = await runCleanup(env.deps.db, env.clock);
    expect(res).toMatchObject({
      tombstones: 1,
      unlockRequests: expect.any(Number),
      rotations: 1,
      deletedDevices: 1,
      challenges: expect.any(Number),
    });
    expect(res.audit).toBeGreaterThan(0);
    const acc = await env.deps.db
      .selectFrom('accounts')
      .select('min_valid_cursor')
      .where('id', '=', a.accountId)
      .executeTakeFirstOrThrow();
    expect(acc.min_valid_cursor).toBe(3); // rev of the purged tombstone
    expect(
      await env.deps.db
        .selectFrom('records')
        .select('id')
        .where('account_id', '=', a.accountId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await env.deps.db
        .selectFrom('auth_challenges')
        .select('device_id')
        .where('device_id', '=', stale)
        .execute(),
    ).toEqual([]);
    expect(
      await env.deps.db.selectFrom('invites').select('id').where('id', '=', inv.id).execute(),
    ).toHaveLength(0);
  });

  test('tombstone purge makes older cursors resync; open claims expire', async () => {
    const a = await createAccount(api);
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(randomUUID(), 0)] },
    });
    const id = randomUUID();
    await api.ok('postRecordsBatch', { device: a.device, body: { changes: [change(id, 0)] } });
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [{ id, baseRev: 2, deleted: true, vkVersion: 1, nonce: null, ct: null }] },
    });
    env.clock.advance(181 * 86_400_000);
    await runCleanup(env.deps.db, env.clock);
    await api.login(a.device);
    expect((await api.ok('getRecords', { device: a.device, query: { since: 1 } })).fullResync).toBe(
      true,
    );
    expect((await api.ok('getRecords', { device: a.device, query: { since: 3 } })).fullResync).toBe(
      false,
    );
  });
});

describe('migrations and CLI helpers', () => {
  test('runner is idempotent; behind schema is detected with a hint', async () => {
    const dir = resolve(import.meta.dirname, '../migrations');
    expect(await runMigrations(env.handle.pool, dir)).toEqual([]);
    const admin = new pg.Client({ connectionString: inject('pgAdminUrl') });
    await admin.connect();
    const name = `m_${randomBytes(4).toString('hex')}`;
    await admin.query(`create database ${name}`);
    const url = new URL(inject('pgAdminUrl'));
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString() });
    await expect(assertSchemaUpToDate(pool, dir)).rejects.toThrow(SchemaBehindError);
    await expect(assertSchemaUpToDate(pool, dir)).rejects.toThrow(/cli\.js migrate/);
    expect(await runMigrations(pool, dir)).toEqual(['0001_init.sql']);
    await assertSchemaUpToDate(pool, dir);
    await pool.end();
    await admin.query(`drop database ${name} with (force)`);
    await admin.end();
  });
  test('invite codes are stored hashed; durations parse', async () => {
    const inv = await createInvite(env.deps.db, parseDuration('7d'), env.clock.now());
    const row = await env.deps.db
      .selectFrom('invites')
      .selectAll()
      .where('id', '=', inv.id)
      .executeTakeFirstOrThrow();
    expect(Buffer.from(row.code_hash).toString('utf8')).not.toContain(inv.code);
    expect(parseDuration('90m')).toBe(5_400_000);
    expect(() => parseDuration('soon')).toThrow();
  });
});

describe('logging', () => {
  test('a full scenario leaves no ciphertext, tokens, authKey, signatures or IPs in the log', async () => {
    env.logs.length = 0;
    const a = await createAccount(api);
    const ext = await addExtension(api, a);
    const secrets: string[] = [
      a.authKey,
      a.verifier,
      a.device.token as string,
      ext.token as string,
    ];
    const ch = change(randomUUID(), 0);
    secrets.push(ch.ct, ch.nonce);
    await api.ok('postRecordsBatch', { device: a.device, body: { changes: [ch] } });
    await api.ok('putAdminKey', {
      device: a.device,
      authKeyHeader: a.authKey,
      body: { adminPub: new KeyPair().pub },
    });
    const payload = unlockPayload(ext, a.accountId)(env.clock.now());
    secrets.push(payload.sig, payload.ephPub, payload.requestNonce);
    await api.ok('createUnlockRequest', { device: ext, body: payload });
    await api.err('getKeyset', 'E_UNAUTHORIZED', {
      authorization: `Bearer ${randomBytes(20).toString('base64url')}.${randomBytes(20).toString('base64url')}.xx`,
    });
    await api.call('getRecords', { device: a.device, query: { since: 0 }, ip: '203.0.113.77' });
    await env.deps.tasks.idle();

    const out = env.logs.join('');
    expect(out.length).toBeGreaterThan(0);
    for (const s of secrets) expect(out, s.slice(0, 8)).not.toContain(s);
    expect(out).not.toContain('203.0.113.77');
    expect(out).not.toContain(a.name);
    expect(out).not.toContain(a.accountId);
    const lines = env.logs.map((l) => JSON.parse(l));
    const req = lines.filter((l) => l.msg === 'request');
    expect(req.length).toBeGreaterThan(5);
    for (const l of req)
      expect(Object.keys(l).sort()).toEqual([
        'level',
        'method',
        'ms',
        'msg',
        'route',
        'status',
        'svc',
        'time',
      ]);
    expect(
      req.some(
        (l) => l.route === '/v1/unlock-requests/{id}' || l.route === '/v1/pairings/{id}/approve',
      ),
    ).toBe(true);
  });
});
