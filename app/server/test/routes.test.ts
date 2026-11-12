import { type AuthKind, ROUTE_NAMES, routeList, routes } from '@localvault/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Api, addExtension, createAccount, TestDevice } from './helpers/client';
import { createTestEnv, type TestEnv } from './helpers/env';

let env: TestEnv;
let api: Api;
beforeAll(async () => {
  env = await createTestEnv();
  api = new Api(env);
});
afterAll(async () => env.close());

test('every route in the protocol table is registered with the same method, path and auth kind', () => {
  expect(env.registrar.registered.size).toBe(ROUTE_NAMES.length);
  for (const def of routeList) {
    const reg = env.registrar.registered.get(def.name as never);
    expect(reg, def.name).toBeDefined();
    expect(reg?.method).toBe(def.method);
    expect(reg?.path).toBe(def.path);
    expect(reg?.auth as AuthKind).toBe(def.auth);
  }
  // and Hono really serves each of them
  const served = new Set(env.app.routes.map((r) => `${r.method} ${r.path}`));
  for (const def of routeList) {
    expect(served.has(`${def.method} ${def.path.replace(/\{(\w+)\}/g, ':$1')}`), def.name).toBe(
      true,
    );
  }
});

const ID = '00000000-0000-4000-8000-0000000000aa';
const bearerKinds: AuthKind[] = [
  'device',
  'approver',
  'approver+admin',
  'approver+authKey',
  'approver+admin+authKey',
  'extension',
];

describe('credentials are required by every authenticated route', () => {
  for (const def of routeList) {
    if (bearerKinds.includes(def.auth)) {
      test(`${def.name} without token -> E_UNAUTHORIZED`, async () => {
        const r = await api.call(def.name as never, {
          params: def.path.includes('{id}') ? { id: ID } : undefined,
        });
        expect(r.status).toBe(401);
        expect(r.body.error.code).toBe('E_UNAUTHORIZED');
      });
    }
    if (def.auth === 'pairing' || def.auth === 'claim') {
      test(`${def.name} without token -> E_UNAUTHORIZED`, async () => {
        const r = await api.call(def.name as never, { params: { id: ID } });
        expect(r.body.error.code).toBe('E_UNAUTHORIZED');
      });
    }
  }
});

describe('permission kinds', () => {
  test('extension cannot use approver routes; approver cannot use extension routes', async () => {
    const acct = await createAccount(api);
    const ext = await addExtension(api, acct);
    const r = await api.call('listDevices', { device: ext });
    expect(r.body.error.code).toBe('E_FORBIDDEN');
    const w = await api.call('postRecordsBatch', {
      device: ext,
      body: {
        changes: [{ id: ID, baseRev: 0, deleted: true, vkVersion: 1, nonce: null, ct: null }],
      },
    });
    expect(w.body.error.code).toBe('E_FORBIDDEN');
    const u = await api.call('createUnlockRequest', { device: acct.device, body: {} });
    expect(u.body.error.code).toBe('E_FORBIDDEN');
    // extensions may read
    await api.ok('getRecords', { device: ext, query: { since: 0 } });
    await api.ok('getKeyset', { device: ext });
  });
  test('unknown path -> 404 JSON, bad JSON / extra keys -> E_INVALID', async () => {
    const r = await env.app.request('/v1/nope');
    expect(r.status).toBe(404);
    const bad = await api.call('authChallenge', { rawBody: '{nope' });
    expect(bad.body.error.code).toBe('E_INVALID');
    const extra = await api.call('authChallenge', { body: { deviceId: ID, extra: 1 } });
    expect(extra.body.error.code).toBe('E_INVALID');
  });
  test('routes table sanity', () => {
    expect(Object.keys(routes).length).toBe(ROUTE_NAMES.length);
    void TestDevice;
  });
});
