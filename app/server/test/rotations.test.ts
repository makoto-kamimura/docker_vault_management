import { randomBytes, randomUUID } from 'node:crypto';
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
beforeAll(async () => {
  env = await createTestEnv();
  api = new Api(env);
});
afterAll(async () => env.close());

const staged = (id: string, deleted = false) =>
  deleted
    ? { id, deleted: true as const, nonce: null, ct: null }
    : {
        id,
        deleted: false as const,
        nonce: randomBytes(12).toString('base64url'),
        ct: randomBytes(30).toString('base64url'),
      };

async function seed(a: TestAccount, n: number) {
  const ids = Array.from({ length: n }, () => randomUUID());
  await api.ok('postRecordsBatch', {
    device: a.device,
    body: { changes: ids.map((id) => change(id, 0)) },
  });
  const del = ids[0] as string;
  await api.ok('postRecordsBatch', {
    device: a.device,
    body: {
      changes: [{ id: del, baseRev: 1, deleted: true, vkVersion: 1, nonce: null, ct: null }],
    },
  });
  return ids;
}
const verifier = () => randomBytes(32).toString('base64url');

describe('rotation', () => {
  test('happy path incl. tombstones, rc deletion, fullResync for old cursors', async () => {
    const a = await createAccount(api);
    const ids = await seed(a, 5);
    const before = await api.ok('getRecords', { device: a.device, query: { since: 0 } });
    await api.ok('putRecoveryCode', {
      device: a.device,
      admin,
      body: {
        rcId: randomBytes(16).toString('base64url'),
        verifier: verifier(),
        wrappedVK: fakeKeyset().wrappedVK,
        vkVersion: 1,
        waitSec: 172800,
      },
    });
    const rot = await api.ok('createRotation', {
      device: a.device,
      admin,
      body: { expectedRev: before.cursor, newVkVersion: 2 },
    });
    await api.ok('stageRotationRecords', {
      device: a.device,
      params: { id: rot.rotationId },
      body: { records: ids.slice(0, 3).map((id, i) => staged(id, i === 0)) },
    });
    await api.ok('stageRotationRecords', {
      device: a.device,
      params: { id: rot.rotationId },
      body: { records: ids.slice(3).map((id) => staged(id)) },
    });
    const ks = fakeKeyset(2, 2);
    const c = await api.ok('commitRotation', {
      device: a.device,
      admin,
      params: { id: rot.rotationId },
      body: { keyset: ks, verifier: verifier(), recordCount: 5 },
    });
    expect(c.cursor).toBe(before.cursor + 5);

    const after = await api.ok('getRecords', { device: a.device, query: { since: before.cursor } });
    expect(after.records).toHaveLength(5);
    expect(after.records.every((r: { vkVersion: number }) => r.vkVersion === 2)).toBe(true);
    expect(after.keyset).toEqual(ks);
    expect(after.records.find((r: { id: string }) => r.id === ids[0])).toMatchObject({
      deleted: true,
      ct: null,
    });
    // clients that were synced before the rotation must start over
    expect(
      (await api.ok('getRecords', { device: a.device, query: { since: before.cursor } }))
        .fullResync,
    ).toBe(true);
    expect(
      (await api.ok('getRecords', { device: a.device, query: { since: c.cursor } })).fullResync,
    ).toBe(false);
    expect((await api.ok('getRecords', { device: a.device, query: { since: 0 } })).fullResync).toBe(
      false,
    );
    // recovery code is gone; old vkVersion pushes are stale
    expect((await api.ok('getRecoveryCode', { device: a.device })).enabled).toBe(false);
    await api.err('postRecordsBatch', 'E_STALE_KEY', {
      device: a.device,
      body: { changes: [change(randomUUID(), 0, 1)] },
    });
    // the rotation is consumed
    await api.err('commitRotation', 'E_NOT_FOUND', {
      device: a.device,
      admin,
      params: { id: rot.rotationId },
      body: { keyset: fakeKeyset(3, 2), verifier: verifier(), recordCount: 5 },
    });
    const kinds = (await api.ok('listAuditEvents', { device: a.device, query: {} })).events.map(
      (e: { kind: string }) => e.kind,
    );
    expect(kinds).toEqual(expect.arrayContaining(['rotated', 'rc_revoked', 'rc_issued']));
  });

  test('E_VERSION_CONFLICT when records changed; staging is discarded', async () => {
    const a = await createAccount(api);
    const ids = await seed(a, 2);
    const cur = (await api.ok('getRecords', { device: a.device, query: { since: 0 } })).cursor;
    const rot = await api.ok('createRotation', {
      device: a.device,
      admin,
      body: { expectedRev: cur, newVkVersion: 2 },
    });
    await api.ok('stageRotationRecords', {
      device: a.device,
      params: { id: rot.rotationId },
      body: { records: ids.map((id) => staged(id)) },
    });
    await api.ok('postRecordsBatch', {
      device: a.device,
      body: { changes: [change(randomUUID(), 0)] },
    });
    await api.err('commitRotation', 'E_VERSION_CONFLICT', {
      device: a.device,
      admin,
      params: { id: rot.rotationId },
      body: { keyset: fakeKeyset(2, 2), verifier: verifier(), recordCount: 2 },
    });
    expect(
      await env.deps.db
        .selectFrom('rotation_records')
        .select('id')
        .where('rotation_id', '=', rot.rotationId)
        .execute(),
    ).toEqual([]);
    expect((await api.ok('getKeyset', { device: a.device })).keyset.vkVersion).toBe(1);
  });

  test('id-set mismatch, wrong recordCount, wrong versions are refused and change nothing', async () => {
    const a = await createAccount(api);
    const ids = await seed(a, 3);
    const cur = (await api.ok('getRecords', { device: a.device, query: { since: 0 } })).cursor;
    const rot = await api.ok('createRotation', {
      device: a.device,
      admin,
      body: { expectedRev: cur, newVkVersion: 2 },
    });
    const p = { id: rot.rotationId };
    await api.ok('stageRotationRecords', {
      device: a.device,
      params: p,
      body: { records: [staged(ids[0] as string), staged(ids[1] as string), staged(randomUUID())] },
    });
    const commit = (keyset = fakeKeyset(2, 2), recordCount = 3) =>
      api.call('commitRotation', {
        device: a.device,
        admin,
        params: p,
        body: { keyset, verifier: verifier(), recordCount },
      });
    expect((await commit()).body.error.code).toBe('E_INVALID'); // wrong ids
    expect((await commit(fakeKeyset(2, 2), 2)).body.error.code).toBe('E_INVALID'); // recordCount != staged
    // staging more ids than the account has records is refused outright
    await api.err('stageRotationRecords', 'E_TOO_LARGE', {
      device: a.device,
      params: p,
      body: { records: [staged(ids[2] as string)] },
    });
    expect((await commit(fakeKeyset(2, 3), 3)).body.error.code).toBe('E_INVALID'); // vkVersion != newVkVersion
    expect((await commit(fakeKeyset(5, 2), 3)).body.error.code).toBe('E_VERSION_CONFLICT');
    expect((await api.ok('getKeyset', { device: a.device })).keyset.vkVersion).toBe(1);
    expect(
      (await api.ok('getRecords', { device: a.device, query: { since: 0 } })).records.every(
        (r: { vkVersion: number }) => r.vkVersion === 1,
      ),
    ).toBe(true);
    await api.err('createRotation', 'E_VERSION_CONFLICT', {
      device: a.device,
      admin,
      body: { expectedRev: cur, newVkVersion: 3 },
    });
  });

  test('one rotation per account, expiry, ownership, abort needs only approver auth', async () => {
    const a = await createAccount(api);
    const ids = await seed(a, 1);
    const r1 = await api.ok('createRotation', {
      device: a.device,
      admin,
      body: { expectedRev: 2, newVkVersion: 2 },
    });
    const r2 = await api.ok('createRotation', {
      device: a.device,
      admin,
      body: { expectedRev: 2, newVkVersion: 2 },
    });
    await api.err('stageRotationRecords', 'E_NOT_FOUND', {
      device: a.device,
      params: { id: r1.rotationId },
      body: { records: [staged(ids[0] as string)] },
    });

    const other = new TestDevice('mobile');
    other.token = (
      await api.ok('authRecover', {
        body: { accountId: a.accountId, authKey: a.authKey, device: other.registration() },
      })
    ).accessToken;
    await api.err('stageRotationRecords', 'E_FORBIDDEN', {
      device: other,
      params: { id: r2.rotationId },
      body: { records: [staged(ids[0] as string)] },
    });
    const b = await createAccount(api);
    await api.err('abortRotation', 'E_NOT_FOUND', {
      device: b.device,
      params: { id: r2.rotationId },
    });

    env.clock.advance(15 * 60_000 + 1000);
    await api.login(a.device);
    await api.login(other);
    await api.err('stageRotationRecords', 'E_EXPIRED', {
      device: a.device,
      params: { id: r2.rotationId },
      body: { records: [staged(ids[0] as string)] },
    });
    const r3 = await api.ok('createRotation', {
      device: a.device,
      admin,
      body: { expectedRev: 2, newVkVersion: 2 },
    });
    await api.ok('abortRotation', { device: other, params: { id: r3.rotationId } });
    await api.err('abortRotation', 'E_NOT_FOUND', {
      device: a.device,
      params: { id: r3.rotationId },
    });
  });
});
