import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api';
import {
  abortRotationFlow,
  confirmPairing,
  defaultDeviceName,
  isLastApprover,
  loadDevices,
  pendingRotation,
  preparePairing,
  RevokeFlowError,
  type RotationProgress,
  resumeRotationFlow,
  revokeDeviceFlow,
  rotationPercent,
} from '../src/features/devices/flows';
import { createMemoryFlagStore, FLAGS } from '../src/lib/flagStore';
import { FakeVaultCore, fakeB64, fakeId } from '../src/native/fake/FakeVaultCore';
import { w4b } from '../src/native/fake/w4bFake';
import { apiError, json, makeFetch } from './helpers';

const device = (o: Partial<import('@localvault/core').DeviceInfo> = {}) => ({
  deviceId: fakeId(),
  name: 'Chrome（PC）',
  type: 'extension' as const,
  platform: 'chrome',
  addedAt: '2026-11-01T00:00:00Z',
  addedVia: 'pairing' as const,
  revokedAt: null,
  isThisDevice: false,
  ...o,
});
const rotationHandlers =
  (rotationId: string, extra?: (u: string, m: string) => Response | undefined) =>
  (c: { url: string; method: string }) => {
    const x = extra?.(c.url, c.method);
    if (x) return x;
    if (c.url.endsWith('/v1/recovery-code'))
      return json(200, {
        enabled: true,
        createdAt: '2026-11-01T00:00:00Z',
        waitSec: 172800,
        frozen: false,
      });
    if (c.method === 'POST' && c.url.endsWith('/v1/rotations'))
      return json(201, { rotationId, expiresAt: '2030-01-01T00:00:00Z' });
    if (c.url.endsWith('/commit')) return json(200, { cursor: 77 });
    return json(204, undefined);
  };
const setup = (...h: Parameters<typeof makeFetch>) => {
  const f = makeFetch(...h);
  const api = createApiClient({ baseUrl: () => 'https://vault.example.com', fetch: f.fetch });
  const core = new FakeVaultCore({ lockState: 'unlocked' });
  return { ...f, api, core, store: createMemoryFlagStore() };
};

describe('device list', () => {
  it('merges last-seen and tolerates an offline server', async () => {
    const d = device();
    const me = device({ isThisDevice: true, type: 'mobile', name: 'iPhone' });
    const gone = device({ revokedAt: '2026-11-05T00:00:00Z' });
    const s = setup((c) =>
      c.url.endsWith('/v1/devices')
        ? json(200, {
            devices: [
              {
                deviceId: d.deviceId,
                type: 'extension',
                platform: 'chrome',
                createdAt: d.addedAt,
                lastSeenAt: '2026-11-10T00:00:00Z',
                revokedAt: null,
              },
            ],
          })
        : undefined,
    );
    w4b(s.core).devices = [d, me, gone];
    const lists = await loadDevices(s.core, s.api);
    expect(lists.active.map((x) => x.name)).toEqual(['iPhone', 'Chrome（PC）']);
    expect(lists.active[1]?.lastSeenAt).toBe('2026-11-10T00:00:00Z');
    expect(lists.revoked).toHaveLength(1);
    const off = setup(() => apiError(500, 'E_INTERNAL'));
    w4b(off.core).devices = [d];
    expect((await loadDevices(off.core, off.api)).serverReachable).toBe(false);
  });
  it('detects the last approver', () => {
    expect(isLastApprover([device({ isThisDevice: true, type: 'mobile' }), device()])).toBe(true);
    expect(
      isLastApprover([device({ isThisDevice: true, type: 'mobile' }), device({ type: 'mobile' })]),
    ).toBe(false);
  });
});

describe('pairing', () => {
  const qr = (origin: string, fp = 'f') =>
    `lvpair:v1?s=${encodeURIComponent(origin)}&p=${fakeId()}&f=${fp}`;
  const pairingBody = (id: string) => ({
    pairingId: id,
    deviceId: fakeId(),
    platform: 'chrome',
    signPub: fakeB64(65),
    ephPub: fakeB64(65),
    expiresAt: '2030-01-01T00:00:00Z',
  });
  it('names, previews and approves', async () => {
    const s = setup((c) =>
      c.method === 'GET'
        ? json(200, pairingBody(c.url.split('/').pop() as string))
        : json(204, undefined),
    );
    const preview = await preparePairing(s.core, s.api, qr('https://vault.example.com'));
    expect(preview.defaultName).toBe(defaultDeviceName('chrome'));
    await confirmPairing({ core: s.core, api: s.api }, preview, '  Büro PC ');
    expect(s.calls.at(-1)?.url).toContain('/approve');
  });
  it('refuses a QR of another server before any request', async () => {
    const s = setup(() => json(200, {}));
    await expect(
      preparePairing(s.core, s.api, qr('https://evil.example.com')),
    ).rejects.toMatchObject({ code: 'E_SERVER_MISMATCH' });
    expect(s.calls).toHaveLength(0);
  });
  it('surfaces a fingerprint mismatch from VaultCore and sends nothing', async () => {
    const s = setup((c) =>
      c.method === 'GET'
        ? json(200, pairingBody(c.url.split('/').pop() as string))
        : json(204, undefined),
    );
    const preview = await preparePairing(s.core, s.api, qr('https://vault.example.com', 'bad'));
    const before = s.calls.length;
    await expect(confirmPairing({ core: s.core, api: s.api }, preview, 'x')).rejects.toMatchObject({
      code: 'E_FINGERPRINT_MISMATCH',
    });
    expect(s.calls).toHaveLength(before);
  });
});

describe('revocation', () => {
  it('without rotation just sends the chain', async () => {
    const s = setup(() => json(204, undefined));
    const out = await revokeDeviceFlow(
      { core: s.core, api: s.api, store: s.store },
      { deviceId: fakeId(), rotateKey: false },
    );
    expect(out.rotated).toBe(false);
    expect(s.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
  it('rotation: ordered requests, progress, confirm with the commit cursor', async () => {
    const rid = fakeId();
    const s = setup(rotationHandlers(rid));
    const progress: RotationProgress[] = [];
    const out = await revokeDeviceFlow(
      { core: s.core, api: s.api, store: s.store, onProgress: (p) => progress.push(p) },
      { deviceId: fakeId(), rotateKey: true, masterPassword: 'pw' },
    );
    expect(out).toEqual({ rotated: true, rcWasEnabled: true });
    const seq = s.calls
      .filter((c) => c.method !== 'GET')
      .map((c) => `${c.method} ${new URL(c.url).pathname.replace(rid, 'ID')}`);
    expect(seq).toEqual([
      `DELETE /v1/devices/${new URL(s.calls[1]?.url ?? 'http://x').pathname.split('/').pop()}`,
      'POST /v1/rotations',
      'PUT /v1/rotations/ID/records',
      'PUT /v1/rotations/ID/records',
      'POST /v1/rotations/ID/commit',
    ]);
    expect(w4b(s.core).confirmedCursor).toBe(77);
    expect(await s.store.get(FLAGS.rotationId)).toBeNull();
    const staging = progress.filter((p) => p.phase === 'staging');
    expect(staging.at(-1)).toMatchObject({ done: 2, total: 3 });
    expect(rotationPercent(progress.at(-1) ?? null)).toBeGreaterThan(0.9);
  });
  it('needs the master password for rotation', async () => {
    const s = setup(() => json(204, undefined));
    await expect(
      revokeDeviceFlow(
        { core: s.core, api: s.api, store: s.store },
        { deviceId: fakeId(), rotateKey: true },
      ),
    ).rejects.toBeInstanceOf(RevokeFlowError);
  });
  it('aborts when a staging upload fails', async () => {
    const rid = fakeId();
    let puts = 0;
    const s = setup(
      rotationHandlers(rid, (u, m) =>
        m === 'PUT' && u.includes('/records') && ++puts === 2
          ? apiError(500, 'E_INTERNAL')
          : undefined,
      ),
    );
    await expect(
      revokeDeviceFlow(
        { core: s.core, api: s.api, store: s.store },
        { deviceId: fakeId(), rotateKey: true, masterPassword: 'pw' },
      ),
    ).rejects.toMatchObject({ stage: 'rotation', revoked: true });
    expect(w4b(s.core).aborted).toEqual([rid]);
    expect(
      s.calls.some((c) => c.method === 'DELETE' && c.url.endsWith(`/v1/rotations/${rid}`)),
    ).toBe(true);
    expect(w4b(s.core).confirmedCursor).toBeNull();
  });
  it('keeps the rotation resumable when the commit response is lost', async () => {
    const rid = fakeId();
    const f = rotationHandlers(rid);
    let failCommit = true;
    const s = setup((c) => {
      if (c.url.endsWith('/commit') && failCommit) throw new Error('boom');
      return f(c);
    });
    await expect(
      revokeDeviceFlow(
        { core: s.core, api: s.api, store: s.store },
        { deviceId: fakeId(), rotateKey: true, masterPassword: 'pw' },
      ),
    ).rejects.toBeInstanceOf(RevokeFlowError);
    expect(w4b(s.core).aborted).toEqual([]);
    expect(await s.store.get(FLAGS.rotationId)).toBe(rid);
    expect(await pendingRotation(s.core, s.store)).toEqual({ rotationId: rid });
    failCommit = false;
    await resumeRotationFlow({ core: s.core, api: s.api, store: s.store }, rid);
    expect(w4b(s.core).confirmedCursor).toBe(77);
    expect(await pendingRotation(s.core, s.store)).toBeNull();
  });
  it('abort at start sends the DELETE and clears the flag', async () => {
    const rid = fakeId();
    const s = setup(() => json(204, undefined));
    w4b(s.core).rotationPending = true;
    await s.store.set(FLAGS.rotationId, rid);
    await abortRotationFlow({ core: s.core, api: s.api, store: s.store }, rid);
    expect(s.calls[0]?.url).toContain(`/v1/rotations/${rid}`);
    expect(await s.store.get(FLAGS.rotationId)).toBeNull();
    expect(await s.core.isRotationPending()).toBe(false);
  });
});
