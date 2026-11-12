import { randomBytes, randomUUID } from 'node:crypto';
import { MAX_CIPHERTEXT_BYTES } from '@localvault/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Api, change, createAccount, fakeKeyset, TestDevice } from './helpers/client';
import { createTestEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let api: Api;
beforeAll(async () => {
  env = await createTestEnv();
  api = new Api(env);
});
afterAll(async () => env.close());

describe('push / pull', () => {
  test('ok, conflict, update, delete, pull with cursor and hasMore', async () => {
    const a = await createAccount(api);
    const [r1, r2] = [randomUUID(), randomUUID()];
    const res = await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(r1, 0), change(r2, 0)] },
    });
    expect(res.results.map((r: { rev: number }) => r.rev)).toEqual([1, 2]);

    // wrong baseRev -> conflict with the server's current record
    const c = await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(r1, 0), change(r2, 2)] },
    });
    expect(c.results[0].status).toBe('conflict');
    expect(c.results[0].current.rev).toBe(1);
    expect(c.results[1]).toEqual({ id: r2, status: 'ok', rev: 3 });

    // delete -> tombstone with null nonce/ct
    const del = { id: r1, baseRev: 1, deleted: true as const, vkVersion: 1, nonce: null, ct: null };
    await api.ok('postRecordsBatch', { device: a.device, body: { changes: [del] } });

    const p = await api.ok('getRecords', { device: a.device, query: { since: 0 } });
    expect(p.records.map((r: { id: string }) => r.id)).toEqual([r2, r1]);
    expect(p.records[1]).toMatchObject({ deleted: true, nonce: null, ct: null, rev: 4 });
    expect(p).toMatchObject({ cursor: 4, hasMore: false, fullResync: false });

    const page = await api.ok('getRecords', { device: a.device, query: { since: 0, limit: 1 } });
    expect(page).toMatchObject({ hasMore: true, cursor: 3 });
    const none = await api.ok('getRecords', { device: a.device, query: { since: 4 } });
    expect(none.records).toEqual([]);
    expect(none.keyset).toBeUndefined();
    expect(p.keyset).toBeDefined(); // since=0 includes the keyset
  });

  test('accounts are isolated', async () => {
    const a = await createAccount(api);
    const b = await createAccount(api);
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(randomUUID(), 0)] },
    });
    expect((await api.ok('getRecords', { device: b.device, query: { since: 0 } })).records).toEqual(
      [],
    );
  });

  test('concurrent batches from two devices: strictly increasing, gap-free revs', async () => {
    const a = await createAccount(api);
    const d2 = new TestDevice('mobile', 'android');
    d2.token = (
      await api.ok('authRecover', {
        body: { accountId: a.accountId, authKey: a.authKey, device: d2.registration() },
      })
    ).accessToken;
    const mk = () => Array.from({ length: 20 }, () => change(randomUUID(), 0));
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(
        api.ok('postRecordsBatch', { device: i % 2 ? a.device : d2, body: { changes: mk() } }),
      );
    }
    const all = (await Promise.all(jobs)).flatMap((r) =>
      r.results.map((x: { rev: number }) => x.rev),
    );
    expect(all).toHaveLength(120);
    expect([...all].sort((x, y) => x - y)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    // each batch got a contiguous block
    const pulled = await api.ok('getRecords', { device: a.device, query: { since: 0 } });
    expect(pulled.cursor).toBe(120);
  });

  test('concurrent edits of one record: exactly one wins, the others conflict', async () => {
    const a = await createAccount(api);
    const id = randomUUID();
    await api.ok('postRecordsBatch', { device: a.device, body: { changes: [change(id, 0)] } });
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        api.ok('postRecordsBatch', { device: a.device, body: { changes: [change(id, 1)] } }),
      ),
    );
    const statuses = rs.map((r) => r.results[0].status).sort();
    expect(statuses).toEqual(['conflict', 'conflict', 'conflict', 'conflict', 'ok']);
  });
});

describe('limits and stale keys', () => {
  test('stale vkVersion rejects the whole batch (E_STALE_KEY) and writes nothing', async () => {
    const a = await createAccount(api);
    const id = randomUUID();
    await api.err('postRecordsBatch', 'E_STALE_KEY', {
      device: a.device,
      body: { changes: [change(id, 0), change(randomUUID(), 0, 2)] },
    });
    expect((await api.ok('getRecords', { device: a.device, query: { since: 0 } })).records).toEqual(
      [],
    );
  });

  test('oversized ciphertext -> E_TOO_LARGE, oversized body -> 413, batch > 100 -> E_INVALID', async () => {
    const a = await createAccount(api);
    const big = {
      ...change(randomUUID(), 0),
      ct: randomBytes(MAX_CIPHERTEXT_BYTES + 1).toString('base64url'),
    };
    const r = await api.call('postRecordsBatch', { device: a.device, body: { changes: [big] } });
    expect([r.status, r.body.error.code]).toEqual([413, 'E_TOO_LARGE']);
    const ok64 = {
      ...change(randomUUID(), 0),
      ct: randomBytes(MAX_CIPHERTEXT_BYTES).toString('base64url'),
    };
    await api.ok('postRecordsBatch', { device: a.device, body: { changes: [ok64] } });
    const huge = await api.call('putKeyset', {
      device: a.device,
      rawBody: ' '.repeat(1024 * 1024 + 10),
      admin: { kind: 'authKey', authKey: a.authKey },
    });
    expect(huge.status).toBe(413);
    await api.err('postRecordsBatch', 'E_INVALID', {
      device: a.device,
      body: { changes: Array.from({ length: 101 }, () => change(randomUUID(), 0)) },
    });
  });

  test('record count cap per account', async () => {
    const a = await createAccount(api);
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      account_id: a.accountId,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      rev: i + 1,
      deleted: false,
      vk_version: 1,
      nonce: Buffer.alloc(12),
      ct: Buffer.alloc(16),
      updated_at: env.clock.now(),
    }));
    for (let i = 0; i < rows.length; i += 2000)
      await env.deps.db
        .insertInto('records')
        .values(rows.slice(i, i + 2000))
        .execute();
    await env.deps.db
      .updateTable('accounts')
      .set({ record_rev: 10_000 })
      .where('id', '=', a.accountId)
      .execute();
    await api.err('postRecordsBatch', 'E_TOO_LARGE', {
      device: a.device,
      body: { changes: [change(randomUUID(), 0)] },
    });
    // updating an existing record is still fine
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(rows[0]?.id as string, 1)] },
    });
  });
});

describe('keyset', () => {
  test('G4 preconditions; pull returns the keyset only to clients that are behind', async () => {
    const a = await createAccount(api);
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(randomUUID(), 0)] },
    });
    const before = await api.ok('getRecords', { device: a.device, query: { since: 0 } });
    const admin = { kind: 'sig' as const };
    const verifier = randomBytes(32).toString('base64url');
    await api.err('putKeyset', 'E_VERSION_CONFLICT', {
      device: a.device,
      admin,
      body: { keyset: fakeKeyset(1, 1), verifier },
    });
    await api.err('putKeyset', 'E_VERSION_CONFLICT', {
      device: a.device,
      admin,
      body: { keyset: fakeKeyset(3, 1), verifier },
    });
    await api.err('putKeyset', 'E_VERSION_CONFLICT', {
      device: a.device,
      admin,
      body: { keyset: fakeKeyset(2, 2), verifier },
    });
    const ks = fakeKeyset(2, 1);
    await api.ok('putKeyset', { device: a.device, admin, body: { keyset: ks, verifier } });
    expect((await api.ok('getKeyset', { device: a.device })).keyset).toEqual(ks);

    const behind = await api.ok('getRecords', {
      device: a.device,
      query: { since: before.cursor },
    });
    expect(behind.keyset).toEqual(ks);
    const caughtUp = await api.ok('getRecords', {
      device: a.device,
      query: { since: behind.cursor },
    });
    expect(caughtUp.keyset).toBeUndefined();
    // the new verifier is what authRecover now checks
    const nd = new TestDevice('mobile');
    await api.err('authRecover', 'E_UNAUTHORIZED', {
      body: { accountId: a.accountId, authKey: a.authKey, device: nd.registration() },
    });
  });
});
