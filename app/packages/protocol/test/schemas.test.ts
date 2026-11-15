import { describe, expect, it } from 'vitest';
import {
  ApiError,
  base64urlEncode,
  buildPath,
  ERROR_STATUS,
  encryptedRecordSchema,
  keysetSchema,
  loginDataSchema,
  META_RECORD_ID,
  normalizeAccountName,
  passwordHistoryOf,
  pushPayloadSchema,
  RATE_LIMITS,
  ROUTE_NAMES,
  recordChangeSchema,
  recordPlainSchema,
  routeList,
  routes,
  sealPlaintextSchema,
  validateAccountName,
} from '../src/index';

const b = (n: number) => base64urlEncode(new Uint8Array(n).fill(1));
const ID = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-11-11T09:00:00.000Z';

const login = {
  title: 'Example',
  username: 'u',
  password: 'p',
  urls: [{ url: 'https://example.com', match: 'domain' as const }],
  androidApps: [],
  notes: '',
  favorite: false,
  createdAt: NOW,
  trashedAt: null,
  conflictOf: null,
};
const keyset = {
  keysetVersion: 1,
  vkVersion: 1,
  kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations: 600000, salt: b(16) },
  wrappedVK: { nonce: b(12), ct: b(48) },
};

describe('records', () => {
  it('accepts a login and treats absent passwordHistory as []', () => {
    const r = loginDataSchema.parse(login);
    expect(passwordHistoryOf(r)).toEqual([]);
    expect(
      recordPlainSchema.safeParse({ kind: 'login', data: login, updatedAt: NOW, updatedBy: ID })
        .success,
    ).toBe(true);
  });
  it('rejects bad logins', () => {
    expect(loginDataSchema.safeParse({ ...login, title: '' }).success).toBe(false);
    expect(loginDataSchema.safeParse({ ...login, title: 'x'.repeat(101) }).success).toBe(false);
    expect(loginDataSchema.safeParse({ ...login, extra: 1 }).success).toBe(false);
    expect(loginDataSchema.safeParse({ ...login, createdAt: '2026-11-11' }).success).toBe(false);
    const hist = (n: number) =>
      Array.from({ length: n }, () => ({ password: 'old', changedAt: NOW }));
    expect(loginDataSchema.safeParse({ ...login, passwordHistory: hist(5) }).success).toBe(true);
    expect(loginDataSchema.safeParse({ ...login, passwordHistory: hist(6) }).success).toBe(false);
  });
  it('encrypted records: deleted implies null nonce/ct', () => {
    expect(
      encryptedRecordSchema.safeParse({
        id: ID,
        rev: 1,
        deleted: true,
        vkVersion: 1,
        nonce: null,
        ct: null,
      }).success,
    ).toBe(true);
    expect(
      encryptedRecordSchema.safeParse({
        id: ID,
        rev: 1,
        deleted: true,
        vkVersion: 1,
        nonce: b(12),
        ct: b(20),
      }).success,
    ).toBe(false);
    expect(
      encryptedRecordSchema.safeParse({
        id: ID,
        rev: 1,
        deleted: false,
        vkVersion: 1,
        nonce: null,
        ct: null,
      }).success,
    ).toBe(false);
    expect(
      encryptedRecordSchema.safeParse({
        id: ID,
        rev: 1,
        deleted: false,
        vkVersion: 1,
        nonce: b(11),
        ct: b(20),
      }).success,
    ).toBe(false);
    expect(
      recordChangeSchema.safeParse({
        id: ID,
        baseRev: 0,
        deleted: false,
        vkVersion: 1,
        nonce: b(12),
        ct: b(20),
      }).success,
    ).toBe(true);
  });
  it('keyset / seal / meta id', () => {
    expect(keysetSchema.safeParse(keyset).success).toBe(true);
    expect(
      keysetSchema.safeParse({ ...keyset, kdf: { ...keyset.kdf, iterations: 1000 } }).success,
    ).toBe(false);
    expect(
      keysetSchema.safeParse({ ...keyset, wrappedVK: { nonce: b(12), ct: b(47) } }).success,
    ).toBe(false);
    expect(
      sealPlaintextSchema.safeParse({ vk: b(32), vkVersion: 1, sessionMaxSec: 3600, issuedAt: NOW })
        .success,
    ).toBe(true);
    expect(
      sealPlaintextSchema.safeParse({ vk: b(32), vkVersion: 1, sessionMaxSec: 42, issuedAt: NOW })
        .success,
    ).toBe(false);
    expect(META_RECORD_ID).toBe('00000000-0000-4000-8000-000000000001');
  });
});

describe('account names', () => {
  it('validates', () => {
    expect(validateAccountName('alice').ok).toBe(true);
    expect(validateAccountName('a.b_c-d').ok).toBe(true);
    expect(validateAccountName('ab')).toEqual({ ok: false, reason: 'too_short' });
    expect(validateAccountName('a'.repeat(33))).toEqual({ ok: false, reason: 'too_long' });
    expect(validateAccountName('Alice')).toEqual({ ok: false, reason: 'bad_chars' });
    expect(validateAccountName('.alice')).toEqual({ ok: false, reason: 'bad_edge' });
    expect(normalizeAccountName('ＡＬＩＣＥ')).toEqual({ ok: true, name: 'alice' });
  });
});

describe('errors and push', () => {
  it('maps codes to statuses', () => {
    expect(ERROR_STATUS.E_ACCOUNT_DELETED).toBe(410);
    expect(ERROR_STATUS.E_CLOCK_SKEW).toBe(400);
    expect(ERROR_STATUS.E_STALE_KEY).toBe(409);
    expect(ERROR_STATUS.E_VERSION_CONFLICT).toBe(409);
    expect(ERROR_STATUS.E_RC_FROZEN).toBe(423);
  });
  it('ApiError body round trip', () => {
    const e = new ApiError('E_CLOCK_SKEW', 'skew', { serverTime: NOW });
    expect(e.status).toBe(400);
    const back = ApiError.fromBody(e.toBody());
    expect(back?.code).toBe('E_CLOCK_SKEW');
    expect(back?.details).toEqual({ serverTime: NOW });
    expect(ApiError.fromBody({ error: { code: 'E_NOPE', message: 'x' } })).toBeNull();
  });
  it('push payloads', () => {
    expect(pushPayloadSchema.safeParse({ t: 'unlock', r: ID }).success).toBe(true);
    expect(pushPayloadSchema.safeParse({ t: 'rc_frozen' }).success).toBe(true);
    expect(pushPayloadSchema.safeParse({ t: 'unlock' }).success).toBe(false);
  });
});

describe('route table', () => {
  it('has unique method+path and unique names', () => {
    const keys = routeList.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(ROUTE_NAMES).size).toBe(ROUTE_NAMES.length);
    for (const [k, r] of Object.entries(routes)) expect(r.name).toBe(k);
  });
  it('placeholders have a params schema', () => {
    for (const r of routeList) {
      expect(/\{id\}/.test(r.path), r.name).toBe(r.request.params !== undefined);
      if (r.status === 204) expect(r.response.safeParse(undefined).success, r.name).toBe(true);
    }
  });
  it('rate limits refer to existing routes', () => {
    for (const l of RATE_LIMITS)
      expect(l.route === 'global' || l.route in routes, l.route).toBe(true);
  });
  it('validates request bodies', () => {
    const batch = routes.postRecordsBatch.request.body;
    const change = { id: ID, baseRev: 0, deleted: false, vkVersion: 1, nonce: b(12), ct: b(30) };
    expect(batch.safeParse({ changes: [change] }).success).toBe(true);
    expect(batch.safeParse({ changes: [] }).success).toBe(false);
    expect(batch.safeParse({ changes: Array.from({ length: 101 }, () => change) }).success).toBe(
      false,
    );
    const q = routes.getRecords.request.query;
    expect(q.parse({ since: '12', limit: '500' })).toEqual({ since: 12, limit: 500 });
    expect(q.safeParse({ since: '-1' }).success).toBe(false);
    expect(q.safeParse({ since: '1', limit: '501' }).success).toBe(false);
    const unlock = routes.createUnlockRequest.request.body;
    const p = {
      requestNonce: b(16),
      ephPub: b(65),
      code: '47',
      issuedAt: '2026-11-11T09:00:00Z',
      sig: b(64),
    };
    expect(unlock.safeParse(p).success).toBe(true);
    expect(unlock.safeParse({ ...p, code: '07' }).success).toBe(false);
    expect(unlock.safeParse({ ...p, issuedAt: NOW }).success).toBe(false);
    const acct = routes.createAccount.request.body;
    const device = {
      deviceId: ID,
      type: 'mobile',
      platform: 'ios',
      signPub: b(65),
      adminPub: b(65),
    };
    const body = {
      inviteCode: 'x',
      accountId: ID,
      accountName: 'alice',
      keyset,
      verifier: b(32),
      device,
    };
    expect(acct.safeParse(body).success).toBe(true);
    expect(acct.safeParse({ ...body, device: { ...device, adminPub: null } }).success).toBe(false);
    expect(
      acct.safeParse({
        ...body,
        device: { ...device, type: 'extension', platform: 'chrome', adminPub: null },
      }).success,
    ).toBe(false);
    expect(acct.safeParse({ ...body, accountName: 'Alice' }).success).toBe(false);
    // open mode: the app sends no invite code
    expect(acct.safeParse({ ...body, inviteCode: '' }).success).toBe(true);
  });
  it('buildPath', () => {
    expect(buildPath(routes.deleteDevice.path, { id: ID })).toBe(`/v1/devices/${ID}`);
    expect(buildPath(routes.getRecords.path, undefined, { since: 3, limit: undefined })).toBe(
      '/v1/records?since=3',
    );
    expect(() => buildPath('/v1/x/{id}')).toThrow();
  });
});
