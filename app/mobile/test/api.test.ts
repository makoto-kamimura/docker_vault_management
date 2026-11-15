import { ApiError } from '@localvault/protocol';
import { describe, expect, it } from 'vitest';
import {
  checkServerUrl,
  createApiClient,
  createAuthedApi,
  InvalidRequestError,
  InvalidResponseError,
  matchRoute,
  NetworkError,
} from '../src/api';
import { FakeVaultCore, fakeB64, fakeId } from '../src/native/fake/FakeVaultCore';
import { apiError, json, makeFetch } from './helpers';

const base = () => 'https://vault.example.com';

describe('server URL policy', () => {
  it('requires https and normalises', () => {
    expect(checkServerUrl('Vault.Example.com:443', { allowInsecureLocalhost: false })).toEqual({
      ok: true,
      origin: 'https://vault.example.com',
    });
    expect(
      checkServerUrl('http://vault.example.com', { allowInsecureLocalhost: true }),
    ).toMatchObject({ ok: false, reason: 'not_https' });
    expect(
      checkServerUrl('https://a.example/path', { allowInsecureLocalhost: false }),
    ).toMatchObject({ ok: false, reason: 'has_path' });
  });
  it('accepts http localhost only with the dev exception', () => {
    expect(checkServerUrl('http://localhost:8787', { allowInsecureLocalhost: true })).toEqual({
      ok: true,
      origin: 'http://localhost:8787',
    });
    expect(
      checkServerUrl('http://localhost:8787', { allowInsecureLocalhost: false }),
    ).toMatchObject({ ok: false });
    expect(checkServerUrl('http://evil.example', { allowInsecureLocalhost: true })).toMatchObject({
      ok: false,
    });
  });
});

describe('route matching', () => {
  it('prefers literal segments over placeholders', () => {
    expect(matchRoute('PUT', '/v1/devices/self/push-token')?.name).toBe('putPushToken');
    expect(matchRoute('DELETE', `/v1/devices/${fakeId()}`)?.name).toBe('deleteDevice');
    expect(matchRoute('GET', '/v1/records?since=0&limit=500')?.name).toBe('getRecords');
  });
});

describe('api client', () => {
  it('validates responses and sends JSON', async () => {
    const { fetch, calls } = makeFetch((c) =>
      c.url.endsWith('/v1/health')
        ? json(200, { version: '0.4.0', registrationMode: 'open' })
        : undefined,
    );
    const api = createApiClient({ baseUrl: base, fetch });
    await expect(api.call('health')).resolves.toEqual({
      version: '0.4.0',
      registrationMode: 'open',
    });
    expect(calls[0]?.url).toBe('https://vault.example.com/v1/health');
  });

  it('rejects a response that does not match the schema', async () => {
    const { fetch } = makeFetch(() => json(200, { version: 1 }));
    await expect(createApiClient({ baseUrl: base, fetch }).call('health')).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it('validates request bodies before sending and never echoes values', async () => {
    const { fetch, calls } = makeFetch();
    const api = createApiClient({ baseUrl: base, fetch });
    const err = await api
      .call('authChallenge', { body: { deviceId: 'SECRET-not-a-uuid' } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(String(err.message)).not.toContain('SECRET');
    expect(calls).toHaveLength(0);
  });

  it('maps error bodies to ApiError, including details', async () => {
    const { fetch } = makeFetch(() =>
      apiError(400, 'E_CLOCK_SKEW', { serverTime: '2026-11-12T00:00:00.000Z' }),
    );
    const e = await createApiClient({ baseUrl: base, fetch })
      .call('health')
      .catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('E_CLOCK_SKEW');
    expect(e.details).toEqual({ serverTime: '2026-11-12T00:00:00.000Z' });
  });

  it('treats a bare 500 as E_INTERNAL', async () => {
    const { fetch } = makeFetch(() => new Response('oops', { status: 500 }));
    const e = await createApiClient({ baseUrl: base, fetch })
      .call('health')
      .catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('E_INTERNAL');
  });

  it('maps fetch failures and timeouts to NetworkError', async () => {
    const failing = (async () => {
      throw new TypeError('Network request failed');
    }) as unknown as typeof fetch;
    const e1 = await createApiClient({ baseUrl: base, fetch: failing })
      .call('health')
      .catch((x) => x);
    expect(e1).toBeInstanceOf(NetworkError);
    expect(e1.kind).toBe('network');

    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, rej) =>
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
      )) as unknown as typeof fetch;
    const e2 = await createApiClient({ baseUrl: base, fetch: hanging, timeoutMs: 20 })
      .call('health')
      .catch((x) => x);
    expect(e2).toBeInstanceOf(NetworkError);
    expect(e2.kind).toBe('timeout');
  });
});

describe('token manager and refresh', () => {
  function setup(opts: { reject401Once?: boolean } = {}) {
    let tokenCount = 0;
    let rejected = false;
    const exp = () => new Date(Date.now() + 3_600_000).toISOString();
    const { fetch, calls } = makeFetch((c) => {
      if (c.url.endsWith('/v1/auth/challenge'))
        return json(200, { challenge: fakeB64(32), expiresAt: exp() });
      if (c.url.endsWith('/v1/auth/token'))
        return json(200, { accessToken: `a.b.t${++tokenCount}`, expiresAt: exp() });
      if (c.url.endsWith('/v1/keyset')) {
        if (opts.reject401Once && !rejected) {
          rejected = true;
          return apiError(401, 'E_UNAUTHORIZED');
        }
        return json(200, {
          keyset: {
            keysetVersion: 1,
            vkVersion: 1,
            kdf: { alg: 'PBKDF2-HMAC-SHA256', iterations: 600000, salt: fakeB64(16) },
            wrappedVK: { nonce: fakeB64(12), ct: fakeB64(48) },
          },
        });
      }
      return undefined;
    });
    const core = new FakeVaultCore({ lockState: 'unlocked', masterPassword: 'x' });
    const { api } = createAuthedApi(core, { baseUrl: base, fetch });
    return { api, calls };
  }

  it('fetches a token once (single flight) and reuses it', async () => {
    const { api, calls } = setup();
    await Promise.all([api.call('getKeyset'), api.call('getKeyset')]);
    await api.call('getKeyset');
    expect(calls.filter((c) => c.url.endsWith('/v1/auth/token'))).toHaveLength(1);
    const auth = calls
      .filter((c) => c.url.endsWith('/v1/keyset'))
      .map((c) => c.headers.Authorization);
    expect(new Set(auth)).toEqual(new Set(['Bearer a.b.t1']));
  });

  it('refreshes the token once after a 401 and retries', async () => {
    const { api, calls } = setup({ reject401Once: true });
    await api.call('getKeyset');
    expect(calls.filter((c) => c.url.endsWith('/v1/auth/token'))).toHaveLength(2);
    const keysetCalls = calls.filter((c) => c.url.endsWith('/v1/keyset'));
    expect(keysetCalls.map((c) => c.headers.Authorization)).toEqual([
      'Bearer a.b.t1',
      'Bearer a.b.t2',
    ]);
  });

  it('does not loop on repeated 401', async () => {
    const { fetch } = makeFetch(
      (c) =>
        c.url.endsWith('/v1/auth/challenge')
          ? json(200, {
              challenge: fakeB64(32),
              expiresAt: new Date(Date.now() + 3.6e6).toISOString(),
            })
          : undefined,
      (c) =>
        c.url.endsWith('/v1/auth/token')
          ? json(200, {
              accessToken: 'a.b.c',
              expiresAt: new Date(Date.now() + 3.6e6).toISOString(),
            })
          : undefined,
      () => apiError(401, 'E_UNAUTHORIZED'),
    );
    const core = new FakeVaultCore({ lockState: 'unlocked' });
    const { api } = createAuthedApi(core, { baseUrl: base, fetch });
    const e = await api.call('getKeyset').catch((x) => x);
    expect(e.code).toBe('E_UNAUTHORIZED');
  });
});

describe('sendServerRequest', () => {
  it('validates the body and passes VaultCore headers through', async () => {
    const { fetch, calls } = makeFetch(() => json(201, {}));
    const core = new FakeVaultCore();
    const { request } = await core.createAccount({
      serverUrl: 'https://vault.example.com',
      accountName: 'alice',
      masterPassword: 'x'.repeat(12),
      inviteCode: '',
    });
    const api = createApiClient({ baseUrl: base, fetch });
    await api.sendServerRequest({ ...request, headers: { 'X-LV-Admin': 'deviceId=x' } });
    expect(calls[0]?.headers['X-LV-Admin']).toBe('deviceId=x');
    await expect(
      api.sendServerRequest({ method: 'POST', path: '/v1/accounts', body: { nope: 1 } }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(
      api.sendServerRequest({ method: 'GET', path: '/v1/nothing' }),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});
