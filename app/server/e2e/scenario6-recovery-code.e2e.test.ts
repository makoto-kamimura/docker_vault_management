import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sample } from './helpers/data';
import type { VirtualPhone } from './helpers/phone';
import { HttpError } from './helpers/transport';
import { uniqueName, World } from './helpers/world';

let w: World;
beforeAll(async () => {
  w = await World.create();
});
afterAll(async () => w.close());

const DAY = 86_400_000;
const NEW_PW = 'new password after code recovery';

async function setup(waitSec: 86400 | 172800 | 259200 = 86400) {
  const name = uniqueName();
  const a = w.phone({ name: 'Home phone' });
  const { recoveryKey, accountId } = await a.createAccount({ name });
  await a.registerPush();
  const x = await a.engine.saveItem(sample('rc'));
  await a.syncOnce();
  const { request, sheet } = await a.engine.issueRecoveryCode({ waitSec });
  await a.send(request);
  return { name, a, x, sheet, recoveryKey, accountId };
}

/** The new phone starts a claim and remembers it (§8.11.4 steps 1-3). */
async function startClaim(sheet: { qr: string }) {
  const n = w.phone({ name: 'New phone' });
  const { request } = await n.engine.startRecoveryClaim({ qr: sheet.qr });
  const claim = await n.session.call(request, { auth: false });
  await n.engine.rememberRecoveryClaim(claim);
  return { n, claim };
}

const tryComplete = (n: VirtualPhone) =>
  n.engine.buildCompleteRecoveryClaim().then((r) => n.session.call(r));

describe('scenario 6: recovery code (§8.11)', () => {
  test('AC-37: full restore after the wait, then a new master password', async () => {
    const { a, x, sheet } = await setup();
    const { n, claim } = await startClaim(sheet);
    expect(await n.engine.getPendingRecoveryClaim()).toMatchObject({ claimId: claim.claimId });
    await expect(tryComplete(n)).rejects.toMatchObject({ code: 'E_CLAIM_WAITING' });
    await w.env.deps.tasks.idle();
    expect(w.push.sent.some((s) => s.payload.t === 'rc_claim')).toBe(true);

    w.advance(DAY + 1000); // the server clock moves; the wait is over
    const done = await tryComplete(n);
    await n.engine.completeRecoveryClaim(done);
    expect(await n.engine.getPendingRecoveryClaim()).toBeNull();
    await n.session.login();
    await n.syncOnce();
    expect(await n.engine.revealPassword(x.id)).toBe(sample('rc').password);
    const put = await n.engine.setMasterPasswordAfterCodeRecovery(NEW_PW);
    await n.send(put);
    await n.engine.confirmKeysetAccepted();
    await n.engine.lock();
    await n.engine.unlockWithPassword(NEW_PW);
    expect((await n.engine.listDevices()).find((d) => d.isThisDevice)?.name).toBeDefined();
    await a.syncOnce();
    expect((await a.engine.listDevices()).filter((d) => d.revokedAt === null)).toHaveLength(2);
    // the code is spent
    await expect(
      n.session.call((await w.phone().engine.startRecoveryClaim({ qr: sheet.qr })).request, {
        auth: false,
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  test('AC-38: cancel on the home phone -> claim closed, code dead', async () => {
    const { a, sheet } = await setup();
    const { n, claim } = await startClaim(sheet);
    const pending = await a.session.call({ method: 'GET', path: '/v1/recovery-claims/pending' });
    expect(pending.claims.map((c: { claimId: string }) => c.claimId)).toEqual([claim.claimId]);
    await a.send(await a.engine.buildCancelRecoveryClaim(claim.claimId));
    w.advance(2 * DAY);
    await expect(tryComplete(n)).rejects.toMatchObject({ code: 'E_CLAIM_CLOSED' });
    const retry = await w.phone().engine.startRecoveryClaim({ qr: sheet.qr });
    await expect(w.phone().session.call(retry.request, { auth: false })).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED',
    });
    expect(await a.session.call({ method: 'GET', path: '/v1/recovery-code' })).toEqual({
      enabled: false,
    });
  });

  test('AC-39: approve-now completes without waiting', async () => {
    const { a, x, sheet } = await setup(259200);
    const { n, claim } = await startClaim(sheet);
    await expect(tryComplete(n)).rejects.toMatchObject({ code: 'E_CLAIM_WAITING' });
    await a.send(await a.engine.buildApproveRecoveryClaimNow(claim.claimId));
    await n.engine.completeRecoveryClaim(await tryComplete(n));
    await n.session.login();
    await n.syncOnce();
    expect(await n.engine.revealPassword(x.id)).toBe(sample('rc').password);
  });

  test('AC-40: used, reissued and revoked codes are rejected', async () => {
    const { a, sheet: first } = await setup();
    // reissue: the old sheet dies
    const second = await a.engine.issueRecoveryCode({ waitSec: 86400 });
    await a.send(second.request);
    const old = await w.phone().engine.startRecoveryClaim({ qr: first.qr });
    await expect(w.phone().session.call(old.request, { auth: false })).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED',
    });
    // the new sheet works once, then is spent
    const { n } = await startClaim(second.sheet);
    w.advance(DAY + 1000);
    await n.engine.completeRecoveryClaim(await tryComplete(n));
    const again = await w.phone().engine.startRecoveryClaim({ qr: second.sheet.qr });
    await expect(w.phone().session.call(again.request, { auth: false })).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED',
    });
  });

  test('AC-41: two simultaneous claims freeze the code and notify the approver', async () => {
    const { a, sheet } = await setup();
    const { n: n1 } = await startClaim(sheet);
    const second = w.phone({ name: 'Thief' });
    const { request } = await second.engine.startRecoveryClaim({ qr: sheet.qr });
    const claim2 = await second.session.call(request, { auth: false }); // accepted, but disputed
    await second.engine.rememberRecoveryClaim(claim2);
    await w.env.deps.tasks.idle();
    expect(w.push.sent.some((s) => s.payload.t === 'rc_frozen')).toBe(true);
    expect(await a.session.call({ method: 'GET', path: '/v1/recovery-code' })).toMatchObject({
      enabled: true,
      frozen: true,
    });
    w.advance(5 * DAY);
    await expect(tryComplete(n1)).rejects.toMatchObject({ code: 'E_RC_FROZEN' });
    await expect(tryComplete(second)).rejects.toMatchObject({ code: 'E_RC_FROZEN' });
    const third = await w.phone().engine.startRecoveryClaim({ qr: sheet.qr });
    await expect(w.phone().session.call(third.request, { auth: false })).rejects.toMatchObject({
      code: 'E_RC_FROZEN',
    });
  });

  test('AC-42: RC is nowhere on the issuing phone (storage, keystore, files) after issuing', async () => {
    const { a, sheet } = await setup();
    const rcB64 = new URL(sheet.qr.replace('lvrc:v1?', 'http://x/?')).searchParams.get(
      'c',
    ) as string;
    const rcBytes = Buffer.from(rcB64, 'base64url');
    const compact = sheet.text.replaceAll('-', '').slice(4);
    const needles = [
      rcB64,
      rcBytes.toString('hex'),
      rcBytes.toString('latin1'),
      rcBytes.toString('base64'),
      compact.slice(0, 40),
      sheet.text,
    ];
    const blobs = [
      ...a.deps.storage.dump().values(),
      ...a.deps.keystore.dump().values(),
      ...a.deps.files.files.values(),
    ];
    for (const b of blobs) {
      const hay = [
        Buffer.from(b).toString('latin1'),
        Buffer.from(b).toString('hex'),
        Buffer.from(b).toString('base64'),
      ];
      for (const h of hay) for (const n of needles) expect(h).not.toContain(n);
    }
    // even after lock / unlock / sync
    await a.engine.lock();
    await a.engine.unlockWithPassword('correct horse battery staple');
    await a.syncOnce();
    for (const b of a.deps.storage.dump().values()) {
      expect(Buffer.from(b).toString('latin1')).not.toContain(rcB64);
    }
  });

  test('AC-43: no recovery code enabled -> claim fails, normal recovery is unaffected', async () => {
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey, accountId } = await a.createAccount({ name });
    await a.engine.saveItem(sample('none'));
    await a.syncOnce();
    // a sheet from ANOTHER account's code, aimed at this account id
    const other = await setup();
    const { request } = await w.phone().engine.startRecoveryClaim({
      serverUrl: 'https://vault.test',
      accountId,
      text: other.sheet.text,
    });
    await expect(w.phone().session.call(request, { auth: false })).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED',
    });
    // disabled after being enabled
    await other.a.send(await other.a.engine.buildRevokeRecoveryCode());
    const dead = await w.phone().engine.startRecoveryClaim({ qr: other.sheet.qr });
    await expect(w.phone().session.call(dead.request, { auth: false })).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED',
    });
    const b = w.phone();
    await b.restore({ name, recoveryKey });
    expect(await b.engine.listItems()).toHaveLength(1);
  });
});
