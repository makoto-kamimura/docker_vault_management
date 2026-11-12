import { signUnlockRequest } from '@localvault/core';
import { base64urlEncode as b64 } from '@localvault/protocol';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sample } from './helpers/data';
import { provider } from './helpers/phone';
import type { HttpReq } from './helpers/transport';
import { uniqueName, World } from './helpers/world';

let w: World;
beforeAll(async () => {
  w = await World.create();
});
afterAll(async () => w.close());

const is = (method: string, re: RegExp) => (r: HttpReq) =>
  r.method === method && re.test(r.path.split('?')[0] as string);

describe('scenario 7: malicious server (AC-25, §17.3)', () => {
  test('(a) pairing returns a different public key -> E_FINGERPRINT_MISMATCH', async () => {
    const t = w.tampering();
    const a = w.phone({ transport: t });
    await a.createAccount({ name: uniqueName() });
    const pc = w.pc();
    const { qr } = await pc.beginPairing();
    const attacker = await provider.generateKeyPair();
    t.rewrite({
      match: is('GET', /^\/v1\/pairings\/[0-9a-f-]{36}$/),
      apply: (res) => ({ ...res, body: { ...res.body, signPub: b64(attacker.publicKey) } }),
    });
    await expect(a.approvePairing(qr)).rejects.toMatchObject({ code: 'E_FINGERPRINT_MISMATCH' });
    await a.syncOnce();
    expect((await a.engine.listDevices()).filter((d) => d.type === 'extension')).toEqual([]);
    await expect(pc.completePairing()).rejects.toThrow(/pending/);
    expect(pc.state).toBe('pairing');
  });

  test('(a2) QR for a different server -> E_SERVER_MISMATCH', async () => {
    const a = w.phone();
    await a.createAccount({ name: uniqueName() });
    const pc = w.pc();
    const { qr } = await pc.beginPairing();
    const evil = qr.replace(/s=[^&]+/, `s=${b64(new TextEncoder().encode('https://evil.test'))}`);
    await expect(a.engine.parsePairingQr(evil)).rejects.toMatchObject({
      code: 'E_SERVER_MISMATCH',
    });
  });

  async function pairedPc(t = w.tampering()) {
    const a = w.phone({ transport: t });
    await a.createAccount({ name: uniqueName() });
    await a.engine.saveItem(sample('mal'));
    await a.syncOnce();
    const pc = w.pc();
    const { qr } = await pc.beginPairing();
    await a.approvePairing(qr);
    await pc.completePairing();
    pc.lock();
    return { a, pc, t };
  }

  test('(b) unlock request signature replaced -> rejected, PC stays locked', async () => {
    const { a, pc, t } = await pairedPc();
    const { code } = await pc.requestUnlock();
    const attacker = await provider.generateKeyPair();
    const info = await a.engine.getAccountInfo();
    const pending = await a.session.call({ method: 'GET', path: '/v1/unlock-requests/pending' });
    const orig = pending.requests[0];
    const sig = await signUnlockRequest(provider, attacker.privateKey, {
      accountId: info.accountId,
      deviceId: orig.deviceId,
      requestNonce: orig.payload.requestNonce,
      ephPub: orig.payload.ephPub,
      code: orig.payload.code,
      issuedAt: orig.payload.issuedAt,
    });
    t.rewrite({
      match: is('GET', /^\/v1\/unlock-requests\/pending$/),
      apply: (res) => ({
        ...res,
        body: {
          requests: res.body.requests.map((r: { payload: object }) => ({
            ...r,
            payload: { ...r.payload, sig },
          })),
        },
      }),
    });
    const [req] = await a.pendingUnlocks();
    expect(await a.engine.verifyUnlockRequest(req as never)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    await expect(a.approveUnlock(req as never, code)).rejects.toMatchObject({
      code: 'E_UNTRUSTED_DEVICE',
    });
    expect(await pc.awaitUnlock(orig.requestId)).toBe('pending');
    expect(pc.state).toBe('locked');
  });

  test('(c) an old unlock request replayed -> rejected', async () => {
    const { a, pc, t } = await pairedPc();
    const r1 = await pc.requestUnlock();
    const [req1] = await a.pendingUnlocks();
    await a.approveUnlock(req1 as never, r1.code);
    expect(await pc.awaitUnlock(r1.requestId)).toBe('unlocked');
    // the server re-lists the already-handled request as a fresh one
    const replay = { ...(req1 as object), requestId: crypto.randomUUID() };
    t.rewrite({
      match: is('GET', /^\/v1\/unlock-requests\/pending$/),
      apply: (res) => ({ ...res, body: { requests: [...res.body.requests, replay] } }),
    });
    const list = await a.pendingUnlocks();
    expect(list).toHaveLength(1);
    expect(await a.engine.verifyUnlockRequest(list[0] as never)).toEqual({
      ok: false,
      reason: 'replayed',
    });
    await expect(a.approveUnlock(list[0] as never, r1.code)).rejects.toMatchObject({
      code: 'E_UNTRUSTED_DEVICE',
    });
    // and a request that is simply old (outside the 5 minute window) is stale
    pc.lock();
    const r2 = await pc.requestUnlock();
    const [req2] = await a.pendingUnlocks();
    t.clear();
    w.advance(6 * 60_000);
    expect(await a.engine.verifyUnlockRequest(req2 as never)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(r2.requestId).toBeDefined();
  });

  test("(d) two records' ciphertexts swapped -> decryption fails, nothing is silently accepted", async () => {
    const t = w.tampering();
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey } = await a.createAccount({ name });
    const x = await a.engine.saveItem(sample('swap-1'));
    const y = await a.engine.saveItem(sample('swap-2'));
    await a.syncOnce();

    const swap = (res: {
      body: {
        records: { id: string; nonce: string | null; ct: string | null; deleted: boolean }[];
      };
    }) => {
      const rx = res.body.records.find((r) => r.id === x.id);
      const ry = res.body.records.find((r) => r.id === y.id);
      if (!rx || !ry) return res;
      return {
        ...res,
        body: {
          ...res.body,
          records: res.body.records.map((r) =>
            r.id === x.id
              ? { ...r, nonce: ry.nonce, ct: ry.ct }
              : r.id === y.id
                ? { ...r, nonce: rx.nonce, ct: rx.ct }
                : r,
          ),
        },
      };
    };
    // phone restoring through the malicious server
    const b = w.phone({ transport: t });
    t.rewrite({ match: is('GET', /^\/v1\/records$/), apply: swap as never });
    await expect(b.restore({ name, recoveryKey })).rejects.toMatchObject({ code: 'E_CORRUPTED' });
    expect(await b.engine.listItems()).toEqual([]);

    // PC syncing through it
    t.clear();
    const t2 = w.tampering();
    const c = w.phone({ transport: t2 });
    await c.restore({ name, recoveryKey });
    const pc = w.pc(t2);
    const { qr } = await pc.beginPairing();
    await c.approvePairing(qr);
    await pc.completePairing();
    expect(pc.items()).toHaveLength(2);
    t2.rewrite({ match: is('GET', /^\/v1\/records$/), apply: swap as never });
    await a.engine.saveItem({ ...sample('swap-1'), id: x.id, notes: 'touch' });
    await a.engine.saveItem({ ...sample('swap-2'), id: y.id, notes: 'touch' });
    await a.syncOnce();
    await expect(pc.sync()).rejects.toBeDefined();
  });

  test('(e) rev / keyset version rolled back -> E_ROLLBACK_DETECTED and sync stops (AC-33)', async () => {
    const t = w.tampering();
    const a = w.phone({ transport: t });
    const { recoveryKey } = await a.createAccount({ name: uniqueName() });
    await a.engine.saveItem(sample('rb-1'));
    await a.syncOnce();
    await a.engine.saveItem(sample('rb-2'));
    await a.syncOnce();
    const before = await a.engine.getSyncState();

    t.rewrite({
      match: is('GET', /^\/v1\/records$/),
      apply: (res) => ({ ...res, body: { ...res.body, cursor: 1, records: [], hasMore: false } }),
      once: true,
    });
    await expect(a.syncOnce()).rejects.toMatchObject({ code: 'E_ROLLBACK_DETECTED' });
    expect(await a.engine.getSyncState()).toMatchObject({
      cursor: before.cursor,
      maxSeenRev: before.maxSeenRev,
    });
    // sync is stopped even though the server is honest again
    await expect(a.syncOnce()).rejects.toMatchObject({ code: 'E_ROLLBACK_DETECTED' });
    expect((await a.engine.listItems()).length).toBe(2); // local data untouched
    // the user accepts the server state: everything is refetched
    await a.engine.acceptServerState();
    await a.syncOnce();
    expect((await a.engine.getSyncState()).cursor).toBeGreaterThanOrEqual(before.cursor);

    // keyset version rolled back
    const t2 = w.tampering();
    const name = uniqueName();
    const p = w.phone();
    const rk = (await p.createAccount({ name })).recoveryKey;
    const b = w.phone({ transport: t2 });
    await b.restore({ name, recoveryKey: rk });
    const firstKeyset = t2.seen.map((s) => s.res.body?.keyset).find(Boolean);
    await p.changeMasterPassword('correct horse battery staple', 'second master password!');
    await b.syncOnce(); // honest: sees keysetVersion 2
    t2.rewrite({
      match: is('GET', /^\/v1\/records$/),
      apply: (res) => ({ ...res, body: { ...res.body, keyset: firstKeyset } }),
    });
    await expect(b.syncOnce()).rejects.toMatchObject({ code: 'E_ROLLBACK_DETECTED' });
    expect(recoveryKey).toBeDefined();
  });
});
