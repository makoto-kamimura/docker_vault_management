// A tiny in-memory server for FakeVaultCore visual checks (EXPO_PUBLIC_LV_FAKE_CORE=1, dev builds
// only). It answers just enough of the protocol for the setup and unlock flows.
import { fakeB64, fakeId, fakeKeyset } from './FakeVaultCore';

function json(status: number, body: unknown): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createFakeFetch(
  opts: { registrationMode?: 'open' | 'invite' | 'closed' } = {},
): typeof fetch {
  const accountId = fakeId();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const inOneHour = new Date(Date.now() + 3_600_000).toISOString();
    await new Promise((r) => setTimeout(r, 250));
    const route = `${method} ${path}`;
    switch (route) {
      case 'GET /v1/health':
        return json(200, {
          version: '0.4.0-fake',
          registrationMode: opts.registrationMode ?? 'open',
        });
      case 'GET /v1/prelogin':
        return json(200, { accountId, kdf: fakeKeyset().kdf });
      case 'POST /v1/accounts':
        return json(201, {});
      case 'POST /v1/auth/challenge':
        return json(200, { challenge: fakeB64(32), expiresAt: inOneHour });
      case 'POST /v1/auth/token':
        return json(200, { accessToken: 'fake.fake.fake', expiresAt: inOneHour });
      case 'POST /v1/auth/recover':
        return json(200, {
          accessToken: 'fake.fake.fake',
          expiresAt: inOneHour,
          keyset: fakeKeyset(),
        });
      case 'GET /v1/records':
        return json(200, { records: [], cursor: 0, hasMore: false, fullResync: false });
      case 'POST /v1/records/batch':
        return json(200, { results: [] });
      case 'PUT /v1/devices/self/push-token':
      case 'PUT /v1/keyset':
        return json(204, undefined);
      // W4b: screens that list server state (empty answers; tests use their own handlers).
      case 'GET /v1/devices':
        return json(200, { devices: [] });
      case 'GET /v1/unlock-requests/pending':
        return json(200, { requests: [] });
      case 'GET /v1/recovery-claims/pending':
        return json(200, { claims: [] });
      case 'GET /v1/recovery-code':
        return json(200, { enabled: false });
      case 'GET /v1/audit-events':
        return json(200, { events: [], hasMore: false });
      default:
        return json(404, { error: { code: 'E_NOT_FOUND', message: 'fake server' } });
    }
  }) as typeof fetch;
}
