import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createInvite } from '../src/cli';
import { Api, createAccount, fakeKeyset, TestDevice } from './helpers/client';
import { createTestEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let api: Api;
beforeAll(async () => {
  env = await createTestEnv();
  api = new Api(env);
});
afterAll(async () => env.close());

const accountBody = (inviteCode = 'x') => {
  const device = new TestDevice('mobile');
  const authKey = Buffer.alloc(32, 7);
  return {
    device,
    body: {
      inviteCode,
      accountId: randomUUID(),
      accountName: `n${randomUUID().slice(0, 8)}`,
      keyset: fakeKeyset(),
      verifier: createHash('sha256').update(authKey).digest('base64url'),
      device: device.registration(),
    },
  };
};

describe('registration modes', () => {
  test('closed refuses, invite needs a valid single-use unexpired invite', async () => {
    env.config.registrationMode = 'closed';
    await api.err('createAccount', 'E_REGISTRATION_CLOSED', { body: accountBody().body });
    env.config.registrationMode = 'invite';
    await api.err('createAccount', 'E_REGISTRATION_CLOSED', { body: accountBody('nope').body });
    await api.err('createAccount', 'E_REGISTRATION_CLOSED', { body: accountBody('').body });

    const inv = await createInvite(env.deps.db, 86_400_000, env.clock.now());
    await api.ok('createAccount', { body: accountBody(inv.code).body });
    await api.err('createAccount', 'E_REGISTRATION_CLOSED', { body: accountBody(inv.code).body });

    const expiring = await createInvite(env.deps.db, 1000, env.clock.now());
    env.clock.advance(2000);
    await api.err('createAccount', 'E_REGISTRATION_CLOSED', {
      body: accountBody(expiring.code).body,
    });

    const revoked = await createInvite(env.deps.db, 86_400_000, env.clock.now());
    await env.deps.db
      .updateTable('invites')
      .set({ revoked_at: env.clock.now() })
      .where('id', '=', revoked.id)
      .execute();
    await api.err('createAccount', 'E_REGISTRATION_CLOSED', {
      body: accountBody(revoked.code).body,
    });
    env.config.registrationMode = 'open';
  });

  test('open accepts an empty invite code (the app hides the field)', async () => {
    await api.ok('createAccount', { body: accountBody('').body });
  });
});

describe('create account', () => {
  test('201 with {} and idempotent retry (G13); other duplicates conflict', async () => {
    const { body } = accountBody();
    const first = await api.call('createAccount', { body });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({});
    expect((await api.call('createAccount', { body })).status).toBe(201);
    // same id, other verifier
    await api.err('createAccount', 'E_ACCOUNT_EXISTS', {
      body: { ...body, verifier: createHash('sha256').update('z').digest('base64url') },
    });
    // same id, other device key
    await api.err('createAccount', 'E_ACCOUNT_EXISTS', {
      body: { ...body, device: new TestDevice('mobile').registration() },
    });
    // same name, other id
    await api.err('createAccount', 'E_ACCOUNT_EXISTS', {
      body: accountBodyWithName(body.accountName),
    });
  });
  test('concurrent identical creates both succeed', async () => {
    const { body } = accountBody();
    const rs = await Promise.all([1, 2, 3].map(() => api.call('createAccount', { body })));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201]);
  });
  test('malformed public key is rejected; initial keyset versions are enforced by the schema', async () => {
    const { body } = accountBody();
    const bad = { ...body.device, signPub: Buffer.alloc(65, 4).toString('base64url') };
    await api.err('createAccount', 'E_INVALID', { body: { ...body, device: bad } });
    await api.err('createAccount', 'E_INVALID', { body: { ...body, keyset: fakeKeyset(2, 1) } });
  });
  test('stores only ciphertext-shaped data (no plaintext columns exist)', async () => {
    const cols = await env.handle.pool.query(
      "select column_name from information_schema.columns where table_name in ('records','devices') and column_name ~ '(title|user|pass|url|name)$' and column_name <> 'platform'",
    );
    expect(cols.rows).toEqual([]);
  });
});

function accountBodyWithName(name: string) {
  const b = accountBody().body;
  return { ...b, accountName: name };
}

describe('prelogin', () => {
  test('real account returns its stored kdf; unknown name returns a deterministic fake of the same shape', async () => {
    const a = await createAccount(api, { name: 'alice' });
    const real = await api.ok('prelogin', { query: { account: 'alice' } });
    expect(real.accountId).toBe(a.accountId);
    const f1 = await api.ok('prelogin', { query: { account: 'ghost' } });
    const f2 = await api.ok('prelogin', { query: { account: 'ghost' } });
    expect(f1).toEqual(f2);
    expect(Object.keys(f1).sort()).toEqual(Object.keys(real).sort());
    expect(Object.keys(f1.kdf).sort()).toEqual(Object.keys(real.kdf).sort());
    expect(f1.accountId).not.toBe(real.accountId);
    expect((await api.ok('prelogin', { query: { account: 'ghost2' } })).accountId).not.toBe(
      f1.accountId,
    );
    await api.err('prelogin', 'E_INVALID', { query: { account: 'X' } });
  });
});

describe('auth/recover (authKey)', () => {
  test('registers a new approver device, returns keyset; wrong key and unknown account are indistinguishable', async () => {
    const a = await createAccount(api);
    const nd = new TestDevice('mobile', 'android');
    const r = await api.ok('authRecover', {
      body: { accountId: a.accountId, authKey: a.authKey, device: nd.registration() },
    });
    expect(r.keyset.keysetVersion).toBe(1);
    nd.token = r.accessToken;
    await api.ok('listDevices', { device: nd });
    // retry with the same device is idempotent
    await api.ok('authRecover', {
      body: { accountId: a.accountId, authKey: a.authKey, device: nd.registration() },
    });
    const wrong = await api.call('authRecover', {
      body: {
        accountId: a.accountId,
        authKey: Buffer.alloc(32, 1).toString('base64url'),
        device: new TestDevice('mobile').registration(),
      },
    });
    const unknown = await api.call('authRecover', {
      body: {
        accountId: randomUUID(),
        authKey: a.authKey,
        device: new TestDevice('mobile').registration(),
      },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });
});

describe('account deletion and tombstones (G3)', () => {
  test('needs admin signature AND authKey; afterwards devices get E_ACCOUNT_DELETED', async () => {
    const a = await createAccount(api, { name: 'doomed' });
    await api.err('deleteAccount', 'E_UNAUTHORIZED', { device: a.device, admin: { kind: 'sig' } });
    await api.err('deleteAccount', 'E_UNAUTHORIZED', {
      device: a.device,
      admin: { kind: 'authKey', authKey: a.authKey },
    });
    await api.err('deleteAccount', 'E_UNAUTHORIZED', {
      device: a.device,
      admin: { kind: 'both', authKey: Buffer.alloc(32, 9).toString('base64url') },
    });
    await api.ok('deleteAccount', {
      device: a.device,
      admin: { kind: 'both', authKey: a.authKey },
    });

    await api.err('getKeyset', 'E_ACCOUNT_DELETED', { device: a.device });
    await api.err('authChallenge', 'E_ACCOUNT_DELETED', { body: { deviceId: a.device.id } });
    expect((await api.ok('prelogin', { query: { account: 'doomed' } })).accountId).not.toBe(
      a.accountId,
    );
    const left = await env.deps.db
      .selectFrom('records')
      .select('id')
      .where('account_id', '=', a.accountId)
      .execute();
    expect(left).toEqual([]);
    // the name can be registered again
    await createAccount(api, { name: 'doomed' });
  });
});
