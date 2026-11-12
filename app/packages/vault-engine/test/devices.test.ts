import {
  open,
  type PendingUnlockRequest,
  pairingFingerprint,
  signUnlockRequest,
} from '@localvault/core';
import {
  base64urlEncode,
  formatPairQr,
  sealContextPair,
  sealContextUnlock,
} from '@localvault/protocol';
import { describe, expect, test } from 'vitest';
import {
  webcrypto as c,
  FakeServer,
  item,
  newPhone,
  PW,
  restoreOn,
  setup,
  syncOnce,
} from './helpers';

const b64 = base64urlEncode;
const uuid = () => crypto.randomUUID();

async function pcPairing(_phone: ReturnType<typeof newPhone>) {
  const sign = await c.generateKeyPair();
  const eph = await c.generateKeyPair();
  const pairing = {
    pairingId: uuid(),
    deviceId: uuid(),
    platform: 'chrome',
    signPub: b64(sign.publicKey),
    ephPub: b64(eph.publicKey),
  };
  const fingerprint = await pairingFingerprint(c, pairing.signPub, pairing.ephPub);
  const qr = formatPairQr({
    serverOrigin: 'https://vault.test',
    pairingId: pairing.pairingId,
    fingerprint,
  });
  return { sign, eph, pairing, fingerprint, qr };
}

async function paired() {
  const s = new FakeServer();
  const p = newPhone();
  await setup(s, p);
  await p.e.saveItem(item('Doc'));
  const pc = await pcPairing(p);
  const parsed = await p.e.parsePairingQr(pc.qr);
  const req = await p.e.approvePairing({
    pairing: pc.pairing,
    fingerprint: parsed.fingerprint,
    name: 'Chrome (Windows)',
  });
  return { s, p, pc, req };
}

describe('pairing (§8.3)', () => {
  test('approval seals the VK to the PC key and registers the PC in the trust list', async () => {
    const { s, p, pc, req } = await paired();
    expect(req.path).toBe(`/v1/pairings/${pc.pairing.pairingId}/approve`);
    expect(req.headers?.['X-LV-Admin']).toMatch(/^deviceId=/);
    const m = await open(
      c,
      pc.eph.privateKey,
      sealContextPair(pc.pairing.pairingId),
      (req.body as { response: never }).response,
    );
    expect(m.vkVersion).toBe(1);
    expect(m.sessionMaxSec).toBe(3600);
    const dev = (await p.e.listDevices()).find((d) => d.deviceId === pc.pairing.deviceId);
    expect(dev).toMatchObject({ name: 'Chrome (Windows)', type: 'extension', isThisDevice: false });
    await syncOnce(p.e, s);
    await p.e.renameDevice(pc.pairing.deviceId, 'Office PC');
    expect((await p.e.listDevices()).find((d) => d.deviceId === pc.pairing.deviceId)?.name).toBe(
      'Office PC',
    );
  });

  test('fingerprint mismatch (different public key from the server) and server mismatch', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    const pc = await pcPairing(p);
    const other = await c.generateKeyPair();
    await expect(
      p.e.approvePairing({
        pairing: { ...pc.pairing, signPub: b64(other.publicKey) },
        fingerprint: pc.fingerprint,
        name: 'PC',
      }),
    ).rejects.toMatchObject({ code: 'E_FINGERPRINT_MISMATCH' });
    const evil = formatPairQr({
      serverOrigin: 'https://evil.test',
      pairingId: pc.pairing.pairingId,
      fingerprint: pc.fingerprint,
    });
    await expect(p.e.parsePairingQr(evil)).rejects.toMatchObject({ code: 'E_SERVER_MISMATCH' });
    await expect(p.e.parsePairingQr('lvpair:v1?bogus')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    expect((await p.e.listDevices()).filter((d) => d.type === 'extension')).toHaveLength(0);
  });
});

describe('unlock requests (§8.4)', () => {
  async function request(
    p: ReturnType<typeof newPhone>,
    pc: Awaited<ReturnType<typeof pcPairing>>,
    o: { code?: string; issuedAt?: string; nonce?: string } = {},
  ) {
    const eph = await c.generateKeyPair();
    const requestNonce = o.nonce ?? b64(await c.randomBytes(16));
    const issuedAt =
      o.issuedAt ??
      p.clock
        .now()
        .toISOString()
        .replace(/\.\d+Z$/, 'Z');
    const code = o.code ?? '47';
    const info = await p.e.getAccountInfo();
    const sig = await signUnlockRequest(c, pc.sign.privateKey, {
      accountId: info.accountId,
      deviceId: pc.pairing.deviceId,
      requestNonce,
      ephPub: b64(eph.publicKey),
      code,
      issuedAt,
    });
    const req: PendingUnlockRequest = {
      requestId: uuid(),
      deviceId: pc.pairing.deviceId,
      expiresAt: new Date(p.clock.now().getTime() + 120_000).toISOString(),
      payload: { requestNonce, ephPub: b64(eph.publicKey), code, issuedAt, sig },
    };
    return { req, eph };
  }

  test('happy path, then the same nonce is a replay for 24 hours', async () => {
    const { p, pc } = await paired();
    const { req, eph } = await request(p, pc);
    expect(await p.e.verifyUnlockRequest(req)).toEqual({
      ok: true,
      deviceName: 'Chrome (Windows)',
    });
    const ok = await p.e.approveUnlock({ request: req, typedCode: '47' });
    expect(ok.path).toBe(`/v1/unlock-requests/${req.requestId}/approve`);
    const m = await open(
      c,
      eph.privateKey,
      sealContextUnlock(req.requestId),
      (ok.body as { response: never }).response,
    );
    expect(m.vk).toHaveLength(43);
    expect(await p.e.verifyUnlockRequest(req)).toEqual({ ok: false, reason: 'replayed' });
    p.clock.advance(25 * 3_600_000);
    const stale = await p.e.verifyUnlockRequest(req);
    expect(stale).toEqual({ ok: false, reason: 'stale' });
  });

  test('AC-23: three wrong codes burn the request', async () => {
    const { p, pc } = await paired();
    const { req } = await request(p, pc);
    const left: (number | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await p.e.approveUnlock({ request: req, typedCode: '11' }).catch((x) => x);
      expect(e.code).toBe('E_CODE_MISMATCH');
      left.push(e.details?.attemptsLeft);
    }
    expect(left).toEqual([2, 1, 0]);
    // even the right code no longer works
    await expect(p.e.approveUnlock({ request: req, typedCode: '47' })).rejects.toMatchObject({
      code: 'E_CODE_MISMATCH',
    });
  });

  test('forged signature, unknown device, revoked device, old request', async () => {
    const { s, p, pc } = await paired();
    const { req } = await request(p, pc);
    const forged = { ...req, payload: { ...req.payload, sig: b64(await c.randomBytes(64)) } };
    expect(await p.e.verifyUnlockRequest(forged)).toEqual({ ok: false, reason: 'bad_signature' });
    await expect(p.e.approveUnlock({ request: forged, typedCode: '47' })).rejects.toMatchObject({
      code: 'E_UNTRUSTED_DEVICE',
    });
    expect(await p.e.verifyUnlockRequest({ ...req, deviceId: uuid() })).toEqual({
      ok: false,
      reason: 'unknown_device',
    });
    const old = await request(p, pc, { issuedAt: '2026-11-11T08:00:00Z' });
    expect(await p.e.verifyUnlockRequest(old.req)).toEqual({ ok: false, reason: 'stale' });
    const reqs = await p.e.revokeDevice({ deviceId: pc.pairing.deviceId, rotateKey: false });
    expect(reqs.at(-1)).toMatchObject({
      method: 'DELETE',
      path: `/v1/devices/${pc.pairing.deviceId}`,
    });
    await syncOnce(p.e, s);
    expect(await p.e.verifyUnlockRequest(req)).toEqual({ ok: false, reason: 'revoked' });
  });

  test('biometric cancel leaves the request unapproved', async () => {
    const { p, pc } = await paired();
    const { req } = await request(p, pc);
    p.deps.biometric.script('cancel');
    await expect(p.e.approveUnlock({ request: req, typedCode: '47' })).rejects.toMatchObject({
      code: 'E_AUTH_CANCELED',
    });
    expect((await p.e.verifyUnlockRequest(req)).ok).toBe(true); // nonce not consumed
  });
});

describe('recovery code (§8.11)', () => {
  test('issue: RC exists nowhere on the issuing device (AC-42)', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    await p.e.saveItem(item('Doc'));
    const { request, sheet } = await p.e.issueRecoveryCode({ waitSec: 172800 });
    expect(request.path).toBe('/v1/recovery-code');
    expect(sheet.text).toMatch(/^LVRC(-[0-9A-Z]{6}){9}$/);
    const rcB64 = new URL(sheet.qr.replace('lvrc:v1?', 'http://x/?')).searchParams.get(
      'c',
    ) as string;
    const needles = [rcB64, sheet.text.replaceAll('-', '').slice(4, 20)];
    const hay: string[] = [];
    for (const [, v] of p.deps.storage.dump()) hay.push(new TextDecoder('latin1').decode(v));
    for (const [, v] of p.deps.keystore.dump())
      hay.push(new TextDecoder('latin1').decode(v), b64(v));
    const rcBytes = Uint8Array.from(atob(rcB64.replaceAll('-', '+').replaceAll('_', '/')), (ch) =>
      ch.charCodeAt(0),
    );
    for (const h of hay) {
      for (const n of needles) expect(h.toLowerCase()).not.toContain(n.toLowerCase());
      expect(h).not.toContain(new TextDecoder('latin1').decode(rcBytes));
    }
    expect(p.deps.files.files.size).toBe(0);
  });

  test('full claim on a new phone, new master password (AC-37 shape)', async () => {
    const s = new FakeServer();
    const a = newPhone();
    await setup(s, a);
    const x = await a.e.saveItem(item('Doc'));
    await syncOnce(a.e, s);
    const { request, sheet } = await a.e.issueRecoveryCode({ waitSec: 86400 });
    const reg = request.body as {
      rcId: string;
      wrappedVK: { nonce: string; ct: string };
      vkVersion: number;
    };

    const n = newPhone({ clock: a.clock });
    const claim = await n.e.startRecoveryClaim({ qr: sheet.qr });
    expect((claim.request.body as { rcId: string }).rcId).toBe(reg.rcId);
    expect(await n.e.getPendingRecoveryClaim()).toBeNull();
    await n.e.rememberRecoveryClaim({
      claimId: uuid(),
      claimToken: b64(await c.randomBytes(32)),
      availableAt: '2026-11-12T09:00:00Z',
    });
    expect(await n.e.getPendingRecoveryClaim()).toMatchObject({
      availableAt: '2026-11-12T09:00:00Z',
    });
    const done = await n.e.buildCompleteRecoveryClaim();
    expect(done.headers?.Authorization).toMatch(/^Claim /);

    const info = await a.e.getAccountInfo();
    await n.e.completeRecoveryClaim({
      accessToken: 'x',
      accountName: info.accountName,
      keyset: s.keyset,
      wrappedVK: reg.wrappedVK,
      vkVersion: reg.vkVersion,
    });
    expect(n.deps.keystore.slots.has('claim')).toBe(false); // RC and claimToken erased
    await syncOnce(n.e, s);
    expect(await n.e.revealPassword(x.id)).toBe('Doc-pass');
    expect((await n.e.listDevices()).some((d) => d.isThisDevice)).toBe(true);
    const put = await n.e.setMasterPasswordAfterCodeRecovery('brand new master pw');
    s.setKeyset((put.body as { keyset: typeof s.keyset }).keyset);
    await n.e.confirmKeysetAccepted();
    await n.e.lock();
    await n.e.unlockWithPassword('brand new master pw');
    await syncOnce(n.e, s);
    await expect(n.e.unlockWithPassword(PW)).rejects.toMatchObject({ code: 'E_WRONG_PASSWORD' });
  });

  test('bad inputs, abandon, cancel / approve-now / wait / revoke builders', async () => {
    const s = new FakeServer();
    const a = newPhone();
    await setup(s, a);
    await expect(a.e.startRecoveryClaim({ qr: 'lvrc:v1?nope' })).rejects.toMatchObject({
      code: 'E_INVALID_RECOVERY_CODE',
    });
    await expect(
      a.e.startRecoveryClaim({
        serverUrl: 'https://vault.test',
        accountId: uuid(),
        text: 'LVRC-AAAA',
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_RECOVERY_CODE' });
    const { sheet } = await a.e.issueRecoveryCode({ waitSec: 86400 });
    const n = newPhone();
    await n.e.startRecoveryClaim({ qr: sheet.qr });
    await n.e.abandonRecoveryClaim();
    expect(await n.e.getPendingRecoveryClaim()).toBeNull();
    const id = uuid();
    expect((await a.e.buildCancelRecoveryClaim(id)).path).toBe(`/v1/recovery-claims/${id}/cancel`);
    expect((await a.e.buildApproveRecoveryClaimNow(id)).path).toBe(
      `/v1/recovery-claims/${id}/approve-now`,
    );
    expect((await a.e.buildSetRecoveryWait(259200)).body).toEqual({ waitSec: 259200 });
    expect((await a.e.buildRevokeRecoveryCode()).method).toBe('DELETE');
    a.deps.biometric.script('cancel');
    await expect(a.e.issueRecoveryCode({ waitSec: 86400 })).rejects.toMatchObject({
      code: 'E_AUTH_CANCELED',
    });
  });

  test('admin key re-registration after a biometric change (FR-13)', async () => {
    const s = new FakeServer();
    const a = newPhone();
    await setup(s, a);
    a.deps.biometric.invalidate();
    await expect(a.e.buildRevokeRecoveryCode()).rejects.toMatchObject({
      code: 'E_BIOMETRY_INVALIDATED',
    });
    const req = await a.e.reregisterAdminKey(PW);
    expect(req.headers?.['X-LV-AuthKey']).toBeDefined();
    expect(req.path).toBe('/v1/devices/self/admin-key');
    expect((await a.e.getDeviceRegistration()).adminPub).toBe(
      (req.body as { adminPub: string }).adminPub,
    );
    await a.e.buildRevokeRecoveryCode();
    const del = await a.e.buildDeleteAccount(PW);
    expect(del.headers).toMatchObject({
      'X-LV-AuthKey': expect.any(String),
      'X-LV-Admin': expect.any(String),
    });
  });

  test('restore with wrong credentials', async () => {
    const s = new FakeServer();
    const a = newPhone();
    const { recoveryKey } = await setup(s, a);
    const b = newPhone();
    await expect(restoreOn(s, b, recoveryKey, 'wrong password!!')).rejects.toMatchObject({
      code: 'E_WRONG_CREDENTIALS',
    });
    await expect(
      b.e.deriveAuthKey({
        accountId: s.accountId,
        kdf: s.keyset.kdf,
        masterPassword: PW,
        recoveryKey: 'LV2-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA',
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_RECOVERY_KEY' });
  });
});
