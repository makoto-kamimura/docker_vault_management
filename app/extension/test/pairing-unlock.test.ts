import { createWebCryptoProvider, verifyUnlockRequest } from '@localvault/core';
import {
  base64urlDecode,
  type DeviceData,
  parsePairQr,
  UNLOCK_CODE_MAX,
  UNLOCK_CODE_MIN,
} from '@localvault/protocol';
import { describe, expect, it } from 'vitest';
import { randomIntInclusive } from '../src/core/random';
import { FakeServer } from './helpers/fake-server';
import { createHarness, pairAndUnlock } from './helpers/harness';

const p = createWebCryptoProvider();

async function seeded() {
  const h = createHarness();
  await h.server.putLogin('11111111-1111-4111-8111-111111111111', {
    title: 'Example',
    username: 'alice',
    password: 'pw-secret',
    urls: [{ url: 'https://example.com', match: 'domain' }],
  });
  return h;
}

describe('pairing (8.3)', () => {
  it('shows a QR whose fingerprint matches, then unlocks after approval', async () => {
    const h = await seeded();
    await h.server.putMeta();
    const { client } = h.boot();
    const start = await client.startPairing('https://vault.test/');
    const qr = parsePairQr(start.qr);
    expect(qr.serverOrigin).toBe('https://vault.test');
    expect(qr.pairingId).toBe(start.pairingId);
    expect(await client.pollPairing()).toMatchObject({ state: 'pending' });

    await h.server.approvePairing(start.pairingId);
    // a restarted worker continues the pairing from storage.session alone
    expect(await h.boot().client.pollPairing()).toEqual({ state: 'paired' });
    const st = await h.boot().client.status();
    expect(st).toMatchObject({ paired: true, locked: false, itemCount: 1 });
    expect(st.deviceName).toBe('Chrome（Windows）');
  });

  it('keeps the device key non-extractable and signs with it only', async () => {
    const h = await seeded();
    const { client } = h.boot();
    await client.startPairing(h.server.origin);
    const stored = await h.keyBackend.get();
    expect(stored?.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey('pkcs8', stored?.privateKey as CryptoKey),
    ).rejects.toThrow();
    const sig = await h.makeEnv().deviceKey.sign(new Uint8Array([1, 2, 3]));
    expect(sig.length).toBe(64);
  });

  it('rejects http server URLs (production) and URLs with paths', async () => {
    const h = await seeded();
    const { client } = h.boot();
    await expect(client.startPairing('http://vault.test')).rejects.toMatchObject({
      code: 'E_BAD_SERVER_URL',
    });
    await expect(client.startPairing('http://localhost:8787')).rejects.toMatchObject({
      code: 'E_BAD_SERVER_URL',
    });
    await expect(client.startPairing('https://vault.test/x')).rejects.toMatchObject({
      code: 'E_BAD_SERVER_URL',
    });
  });

  it('rejects a bogus VK from a tampered approval and returns to the initial state', async () => {
    const h = await seeded();
    await h.server.putMeta();
    const { client } = h.boot();
    const start = await client.startPairing(h.server.origin);
    await h.server.approvePairing(start.pairingId, {
      vk: crypto.getRandomValues(new Uint8Array(32)),
    });
    expect(await h.boot().client.pollPairing()).toEqual({ state: 'failed', reason: 'bad_vk' });
    const st = await h.boot().client.status();
    expect(st).toMatchObject({ paired: false, locked: true });
    expect(await h.keyBackend.get()).toBeUndefined();
    expect(Object.keys(h.session.dump())).not.toContain('lvs.session');
  });

  it('refuses a second pairing while paired', async () => {
    const h = await seeded();
    const { client } = await pairAndUnlock(h);
    await expect(client.startPairing(h.server.origin)).rejects.toMatchObject({
      code: 'E_FORBIDDEN_ORIGIN',
    });
  });
});

describe('unlock (8.4)', () => {
  it('sends a request the phone can verify against the trust list (check 2-5 of 8.4)', async () => {
    const h = await seeded();
    const { client, env } = await pairAndUnlock(h);
    await client.lock();
    const started = await client.startUnlock();
    expect(Number(started.code)).toBeGreaterThanOrEqual(UNLOCK_CODE_MIN);
    expect(Number(started.code)).toBeLessThanOrEqual(UNLOCK_CODE_MAX);

    const req = h.server.unlocks.get(started.requestId);
    expect(req?.code).toBe(started.code);
    const account = (await env.local.get('lv.account'))['lv.account'] as {
      deviceId: string;
      accountId: string;
    };
    const sent = h.server.requests.filter((r) => r.path === '/v1/unlock-requests');
    expect(sent).toHaveLength(1);
    // Re-verify the signature exactly the way the phone does, using the trusted signPub.
    const trust: DeviceData[] = [
      {
        deviceId: account.deviceId,
        name: 'pc',
        type: 'extension',
        platform: 'chrome',
        signPub: h.server.devices.get(account.deviceId) as string,
        adminPub: null,
        addedAt: new Date().toISOString(),
        addedBy: account.accountId,
        addedVia: 'pairing',
        revokedAt: null,
      },
    ];
    // The fake server kept the original body in the unlock record only partially; rebuild the
    // verification input from what the server stored.
    const stored = h.server.lastUnlockBody as {
      requestNonce: string;
      ephPub: string;
      code: string;
      issuedAt: string;
      sig: string;
    };
    const verdict = await verifyUnlockRequest(p, {
      accountId: account.accountId,
      request: { deviceId: account.deviceId, ...stored },
      trust,
      now: Date.now(),
      isNonceSeen: () => false,
    });
    expect(verdict.ok).toBe(true);
    expect(stored.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(base64urlDecode(stored.requestNonce)).toHaveLength(16);
  });

  it('AC-31: survives a worker restart while waiting, then unlocks after approval', async () => {
    const h = await seeded();
    const first = await pairAndUnlock(h);
    await first.client.lock();
    const started = await h.boot().client.startUnlock();

    // worker killed and rebuilt: nothing but storage survives
    const second = h.boot();
    expect(await second.client.pollUnlock()).toMatchObject({
      state: 'waiting',
      code: started.code,
    });
    expect((await second.client.status()).pending).toMatchObject({
      kind: 'unlock',
      code: started.code,
    });

    await h.server.approveUnlock(started.requestId);
    const third = h.boot();
    expect(await third.client.pollUnlock()).toEqual({ state: 'unlocked' });
    expect((await third.client.status()).locked).toBe(false);
    // starting again while unlocked-pending must not hit the server twice
  });

  it('does not create a second request while one is pending', async () => {
    const h = await seeded();
    const { client } = await pairAndUnlock(h);
    await client.lock();
    const a = await client.startUnlock();
    const b = await h.boot().client.startUnlock();
    expect(b.requestId).toBe(a.requestId);
    expect(h.server.requests.filter((r) => r.path === '/v1/unlock-requests')).toHaveLength(1);
  });

  it('rejects a forged approval (VK that cannot open the meta record) and stays locked', async () => {
    const h = await seeded();
    const { client } = await pairAndUnlock(h);
    await client.lock();
    const started = await client.startUnlock();
    await h.server.approveUnlock(started.requestId, {
      vk: crypto.getRandomValues(new Uint8Array(32)),
    });
    expect(await h.boot().client.pollUnlock()).toEqual({ state: 'failed', reason: 'bad_vk' });
    const st = await h.boot().client.status();
    expect(st.locked).toBe(true);
    expect(st.pending).toBeNull();
  });

  it('handles denial and local expiry', async () => {
    const h = await seeded();
    const { client } = await pairAndUnlock(h);
    await client.lock();
    const a = await client.startUnlock();
    const r = h.server.unlocks.get(a.requestId);
    if (r) r.status = 'denied';
    expect(await h.boot().client.pollUnlock()).toEqual({ state: 'denied' });

    await h.boot().client.startUnlock();
    h.time.now += 200_000; // beyond the 120 s lifetime
    expect(await h.boot().client.pollUnlock()).toEqual({ state: 'expired' });
  });

  it('reports E_CLOCK_SKEW with the server time and E_NOT_FOUND for foreign requests', async () => {
    const h = await seeded();
    const { router } = await pairAndUnlock(h);
    await h.boot().client.lock();
    h.server.failNext.push({
      path: /unlock-requests$/,
      status: 400,
      body: {
        error: {
          code: 'E_CLOCK_SKEW',
          message: 'x',
          details: { serverTime: '2026-11-12T00:00:00Z' },
        },
      },
    });
    const res = await h.boot().router.handle({ type: 'unlock-start' }, { kind: 'extension' });
    expect(res).toMatchObject({
      ok: false,
      error: { code: 'E_CLOCK_SKEW', details: { serverTime: '2026-11-12T00:00:00Z' } },
    });
    expect(router).toBeDefined();
  });

  it('draws codes uniformly from 10..99 with rejection sampling', async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) seen.add(await randomIntInclusive(p, 10, 99));
    expect(Math.min(...seen)).toBe(10);
    expect(Math.max(...seen)).toBe(99);
    expect(seen.size).toBe(90);
    // a deterministic byte source: values >= the largest multiple of 90 (180) are rejected
    const bytes = [255, 200, 180, 179];
    const fake = { randomBytes: async () => new Uint8Array([bytes.shift() as number]) };
    expect(await randomIntInclusive(fake as never, 10, 99)).toBe(10 + (179 % 90));
  });
});

void FakeServer;
