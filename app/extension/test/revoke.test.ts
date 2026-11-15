import { describe, expect, it } from 'vitest';
import { createHarness, pairAndUnlock } from './helpers/harness';

const A = '11111111-1111-4111-8111-111111111111';

async function ready() {
  const h = createHarness();
  await h.server.putLogin(A, { title: 'A', username: 'a', password: 'pw', urls: [] });
  const booted = await pairAndUnlock(h);
  const account = h.local.dump()['lv.account'] as { deviceId: string };
  return { h, deviceId: account.deviceId, ...booted };
}

describe('revocation and account deletion', () => {
  it('AC-24: E_DEVICE_REVOKED wipes session, cache, token and the device key', async () => {
    const { h, deviceId } = await ready();
    h.server.revoked.add(deviceId);
    h.session.dump(); // sanity
    // drop the cached token so the next call hits the login and sees the revocation
    await h.session.remove('lvs.token');
    const r = await h.boot().router.handle({ type: 'sync' }, { kind: 'extension' });
    expect(r).toMatchObject({ ok: false, error: { code: 'E_DEVICE_REVOKED' } });
    expect(h.session.dump()).toEqual({});
    const local = h.local.dump();
    expect(Object.keys(local).sort()).toEqual(['lv.config', 'lv.notice']);
    expect(local['lv.notice']).toMatchObject({ kind: 'revoked' });
    expect(await h.keyBackend.get()).toBeUndefined();
    const st = await h.boot().client.status();
    expect(st).toMatchObject({ paired: false, locked: true, notice: { kind: 'revoked' } });
  });

  it('revocation seen through an authenticated call with a still-valid token also wipes', async () => {
    const { h, deviceId } = await ready();
    h.server.revoked.add(deviceId);
    await h
      .boot()
      .client.sync()
      .catch(() => undefined);
    expect((await h.boot().client.status()).paired).toBe(false);
    expect(await h.keyBackend.get()).toBeUndefined();
  });

  it('E_ACCOUNT_DELETED wipes with its own notice', async () => {
    const { h, deviceId } = await ready();
    h.server.deleted.add(deviceId);
    await h
      .boot()
      .client.sync()
      .catch(() => undefined);
    expect(await h.boot().client.status()).toMatchObject({
      paired: false,
      notice: { kind: 'account_deleted' },
    });
  });

  it('manual unpair returns to the initial state but keeps the server URL', async () => {
    const { h, client } = await ready();
    await client.unpair();
    expect(await h.keyBackend.get()).toBeUndefined();
    const st = await h.boot().client.status();
    expect(st).toMatchObject({
      paired: false,
      serverUrl: 'https://vault.test',
      notice: { kind: 'unpaired' },
    });
    expect(h.local.dump()['lv.records']).toBeUndefined();
  });

  it('a network failure does NOT wipe anything', async () => {
    const { h } = await ready();
    h.server.offline = true;
    await h
      .boot()
      .client.sync()
      .catch(() => undefined);
    expect((await h.boot().client.status()).paired).toBe(true);
  });
});
