import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sample } from './helpers/data';
import { uniqueName, World } from './helpers/world';

let w: World;
beforeAll(async () => {
  w = await World.create();
});
afterAll(async () => w.close());

async function setup() {
  const a = w.phone({ name: 'Phone' });
  await a.createAccount({ name: uniqueName() });
  await a.registerPush();
  await a.engine.saveItem(sample('pc'));
  await a.syncOnce();
  const pc = w.pc();
  const { qr } = await pc.beginPairing();
  await a.approvePairing(qr);
  await pc.completePairing();
  return { a, pc };
}

describe('scenario 3: PC pairing and unlock', () => {
  test('AC-22: pairing unlocks the PC and it can read the vault', async () => {
    const { a, pc } = await setup();
    expect(pc.state).toBe('unlocked');
    expect(pc.items()).toEqual([
      {
        title: sample('pc').title,
        username: sample('pc').username,
        password: sample('pc').password,
      },
    ]);
    const devices = await a.engine.listDevices();
    expect(devices.find((d) => d.type === 'extension')).toMatchObject({
      name: 'Chrome (Windows)',
      revokedAt: null,
    });
    await a.engine.saveItem(sample('later'));
    await a.syncOnce();
    await pc.sync();
    expect(pc.items()).toHaveLength(2);
  });

  test('AC-23: unlock with the 2-digit code; "one-time" session value is delivered', async () => {
    const { a, pc } = await setup();
    await a.engine.updateSettings({ pcSessionMaxSec: 0 }); // 1 operation only
    await a.syncOnce();
    pc.lock();
    expect(pc.state).toBe('locked');
    expect(pc.items()).toEqual([]);
    const { requestId, code } = await pc.requestUnlock();
    const [req] = await a.pendingUnlocks();
    expect(req?.requestId).toBe(requestId);
    expect(await a.engine.verifyUnlockRequest(req as never)).toMatchObject({
      ok: true,
      deviceName: 'Chrome (Windows)',
    });
    await a.approveUnlock(req as never, code);
    expect(await pc.awaitUnlock(requestId)).toBe('unlocked');
    expect(pc.sessionMaxSec).toBe(0);
    expect(pc.items()).toHaveLength(1);
    // the request is single-use: nothing pending any more
    expect(await a.pendingUnlocks()).toEqual([]);
    await w.env.deps.tasks.idle();
    expect(w.push.sent.some((s) => s.payload.t === 'unlock')).toBe(true);
  });

  test('AC-23: three wrong codes -> the request is denied', async () => {
    const { a, pc } = await setup();
    pc.lock();
    const { requestId, code } = await pc.requestUnlock();
    const wrong = code === '11' ? '12' : '11';
    const [req] = await a.pendingUnlocks();
    const left: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await a.approveUnlock(req as never, wrong).catch((x) => x);
      expect(e.code).toBe('E_CODE_MISMATCH');
      left.push(e.details.attemptsLeft);
    }
    expect(left).toEqual([2, 1, 0]);
    await a.denyUnlock(req as never); // "at 0 the caller sends a rejection"
    expect(await pc.awaitUnlock(requestId)).toBe('denied');
    expect(pc.state).toBe('locked');
    expect(pc.items()).toEqual([]);
  });

  test('deny from the phone', async () => {
    const { a, pc } = await setup();
    pc.lock();
    const { requestId } = await pc.requestUnlock();
    const [req] = await a.pendingUnlocks();
    await a.denyUnlock(req as never);
    expect(await pc.awaitUnlock(requestId)).toBe('denied');
    expect(await a.pendingUnlocks()).toEqual([]);
  });
});
