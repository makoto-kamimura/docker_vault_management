import { afterAll, beforeAll, expect, test } from 'vitest';
import { sample } from './helpers/data';
import { MASTER_PW } from './helpers/phone';
import { uniqueName, World } from './helpers/world';

let w: World;
beforeAll(async () => {
  w = await World.create();
});
afterAll(async () => w.close());

test('AC-19: no table of the database contains any plaintext secret', async () => {
  const name = uniqueName();
  const a = w.phone({ name: 'Taro-iPhone-zq' });
  const { recoveryKey, accountId } = await a.createAccount({ name });
  await a.registerPush('apns-token-zq-1234');
  const items = [sample('alpha'), sample('beta'), sample('gamma')];
  for (const i of items) await a.engine.saveItem(i);
  await a.engine.renameDevice((await a.engine.getAccountInfo()).deviceId, 'Taro-iPhone-renamed-zq');
  const b = w.phone({ name: 'Hanako-Pixel-zq' });
  await b.restore({ name, recoveryKey });
  const pc = w.pc();
  const { qr } = await pc.beginPairing();
  await a.approvePairing(qr, 'Office-Chrome-zq');
  await pc.completePairing();
  pc.lock();
  const { code } = await pc.requestUnlock();
  const [req] = await a.pendingUnlocks();
  await a.approveUnlock(req as never, code);
  await pc.awaitUnlock(pc.lastUnlockRequestId);
  const { request, sheet } = await a.engine.issueRecoveryCode({ waitSec: 86400 });
  await a.send(request);
  await a.syncOnce();
  await b.syncOnce();
  // a claim is in flight as well
  const n = w.phone();
  const claim = await n.engine.startRecoveryClaim({ qr: sheet.qr });
  await n.session.call(claim.request, { auth: false });
  await w.env.deps.tasks.idle();

  const info = await b.session.call(
    { method: 'GET', path: `/v1/prelogin?account=${name}` },
    { auth: false },
  );
  const authKey = await a.engine.deriveAuthKey({
    accountId,
    kdf: info.kdf,
    masterPassword: MASTER_PW,
    recoveryKey,
  });
  const rcB64 = new URL(sheet.qr.replace('lvrc:v1?', 'http://x/?')).searchParams.get('c') as string;
  const authKeyBytes = Buffer.from(authKey, 'base64url');
  const rcBytes = Buffer.from(rcB64, 'base64url');
  const skBytes = Buffer.from(
    // the SK bytes are the Crockford payload; derive them from the keystore of A for the scan
    a.deps.keystore.slots.get('sk')?.value ?? new Uint8Array(),
  );

  const dump = (await w.dumpDatabase()).toLowerCase();
  expect(dump).toContain(accountId); // sanity: the dump really contains the account
  expect(dump).toContain(name);

  const secrets: string[] = [
    MASTER_PW,
    recoveryKey,
    recoveryKey.replaceAll('-', ''),
    sheet.text,
    sheet.text.replaceAll('-', ''),
    rcB64,
    rcBytes.toString('hex'),
    authKey,
    authKeyBytes.toString('hex'),
    authKeyBytes.toString('base64'),
    skBytes.toString('hex'),
    skBytes.toString('base64url'),
    'Taro-iPhone-zq',
    'Taro-iPhone-renamed-zq',
    'Hanako-Pixel-zq',
    'Office-Chrome-zq',
    'Chrome (Windows)',
    ...items.flatMap((i) => [i.title, i.username, i.password ?? '', i.notes, i.urls[0]?.url ?? '']),
    'login.alpha-zq.example.org',
    'mail.zq.example',
  ];
  for (const s of secrets) {
    expect(s.length).toBeGreaterThan(5);
    expect(dump, `database leaks: ${s.slice(0, 12)}…`).not.toContain(s.toLowerCase());
  }
  // server logs as well (AC-18 on the server side)
  const logs = w.env.logs.join('\n').toLowerCase();
  for (const s of secrets) expect(logs).not.toContain(s.toLowerCase());
});
