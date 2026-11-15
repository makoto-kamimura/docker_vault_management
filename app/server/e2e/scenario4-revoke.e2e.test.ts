import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sample } from './helpers/data';
import { MASTER_PW } from './helpers/phone';
import { HttpError } from './helpers/transport';
import { uniqueName, World } from './helpers/world';

let w: World;
beforeAll(async () => {
  w = await World.create();
});
afterAll(async () => w.close());

async function setup() {
  const name = uniqueName();
  const a = w.phone({ name: 'A' });
  const { recoveryKey } = await a.createAccount({ name });
  const x = await a.engine.saveItem(sample('rv'));
  await a.syncOnce();
  const pc = w.pc();
  const { qr } = await pc.beginPairing();
  await a.approvePairing(qr);
  await pc.completePairing();
  return { name, a, pc, x, recoveryKey };
}

describe('scenario 4: revocation and key rotation', () => {
  test('AC-24: revoked PC is refused on its next request and wipes itself', async () => {
    const { a, pc } = await setup();
    expect(pc.cachedCount()).toBeGreaterThan(0);
    await a.revokeDevice(pc.id);
    await expect(pc.sync()).rejects.toMatchObject({ code: 'E_DEVICE_REVOKED' });
    expect(pc.state).toBe('wiped');
    expect(pc.cachedCount()).toBe(0);
    expect(pc.items()).toEqual([]);
    expect(pc.hasDeviceKey).toBe(false);
    const dev = (await a.engine.listDevices()).find((d) => d.deviceId === pc.id);
    expect(dev?.revokedAt).not.toBeNull();
  });

  test('AC-36: revoke with rotation -> other phone migrates with its master password', async () => {
    const { name, a, pc, x, recoveryKey } = await setup();
    const b = w.phone({ name: 'B' });
    await b.restore({ name, recoveryKey });
    await a.syncOnce();
    await a.revokeDevice(pc.id, { rotate: true });
    // A itself keeps working with the new key
    expect(await a.engine.revealPassword(x.id)).toBe(sample('rv').password);
    expect((await a.engine.getSyncState()).pendingCount).toBe(0);

    const r = await b.syncOnce();
    expect(r.needsMasterPassword).toBe(true);
    expect(await b.engine.isRotationPending()).toBe(true);
    await b.engine.unlockWithPassword(MASTER_PW);
    expect((await b.syncOnce()).needsMasterPassword).toBe(false);
    expect(await b.engine.revealPassword(x.id)).toBe(sample('rv').password);
    expect((await b.engine.listItems()).map((i) => i.title)).toEqual([sample('rv').title]);
    // B can write with the new key and A reads it
    const y = await b.engine.saveItem(sample('after'));
    await b.syncOnce();
    await a.syncOnce();
    expect(await a.engine.revealPassword(y.id)).toBe(sample('after').password);
    // the revoked PC cannot read anything (token dead)
    await expect(pc.sync()).rejects.toMatchObject({ code: 'E_DEVICE_REVOKED' });
    // vkVersion is now 2 on the server
    const ks = await a.session.call({ method: 'GET', path: '/v1/keyset' });
    expect(ks.keyset.vkVersion).toBe(2);
  });

  test('rotation invalidates the recovery code (AC-40, pre-rotation code)', async () => {
    const { a, pc } = await setup();
    const { request, sheet } = await a.engine.issueRecoveryCode({ waitSec: 86400 });
    await a.send(request);
    expect(await a.session.call({ method: 'GET', path: '/v1/recovery-code' })).toMatchObject({
      enabled: true,
    });
    await a.revokeDevice(pc.id, { rotate: true });
    expect(await a.session.call({ method: 'GET', path: '/v1/recovery-code' })).toEqual({
      enabled: false,
    });
    const n = w.phone();
    const { request: claim } = await n.engine.startRecoveryClaim({ qr: sheet.qr });
    await expect(n.session.call(claim, { auth: false })).rejects.toBeInstanceOf(HttpError);
  });

  test('a stale rotation (records changed meanwhile) fails at commit with E_VERSION_CONFLICT', async () => {
    const { name, a, pc, recoveryKey } = await setup();
    const b = w.phone();
    await b.restore({ name, recoveryKey });
    await a.syncOnce();
    const [del, start] = await a.engine.revokeDevice({
      deviceId: pc.id,
      rotateKey: true,
      masterPassword: MASTER_PW,
    });
    await a.send(del as never);
    const { rotationId } = await a.send(start as never);
    // B writes after A's last sync, before A commits
    await b.engine.saveItem(sample('sneaky'));
    await b.syncOnce();
    const more = await a.engine.continueRotation(rotationId);
    for (const m of more.slice(0, -1)) await a.send(m);
    await expect(a.send(more.at(-1) as never)).rejects.toMatchObject({
      code: 'E_VERSION_CONFLICT',
    });
    // A still works with the old key and converges after a sync
    await a.syncOnce();
    expect((await a.engine.listItems()).some((i) => i.title === sample('sneaky').title)).toBe(true);
    expect((await a.session.call({ method: 'GET', path: '/v1/keyset' })).keyset.vkVersion).toBe(1);
  });
});
