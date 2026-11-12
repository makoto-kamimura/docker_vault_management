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

describe('scenario 9: sign-out, account deletion, CSV, export/import', () => {
  test('G2: sign out of this device', async () => {
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey } = await a.createAccount({ name });
    const b = w.phone();
    await b.restore({ name, recoveryKey });
    const bId = (await b.engine.getAccountInfo()).deviceId;
    const token = b.session.token;
    await a.syncOnce();
    expect(await a.engine.isLastApprover()).toBe(false);
    await b.engine.saveItem(sample('so')); // unsynced edit is pushed by the sign-out batch
    const reqs = await b.engine.buildSignOutDevice();
    await b.sendAll(reqs);
    await b.engine.wipeLocal();
    expect(await b.engine.getLockState()).toBe('uninitialized');
    expect(b.deps.keystore.slots.size).toBe(0);

    const dead = await w.transport.send({
      method: 'GET',
      path: '/v1/records?since=0',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(dead.body.error.code).toBe('E_DEVICE_REVOKED');
    await a.syncOnce();
    expect(
      (await a.engine.listDevices()).find((d) => d.deviceId === bId)?.revokedAt,
    ).not.toBeNull();
    expect((await a.engine.listItems()).map((i) => i.title)).toContain(sample('so').title);
    expect(await a.engine.isLastApprover()).toBe(true);
  });

  test('G1: a revoked phone locks and stops syncing', async () => {
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey } = await a.createAccount({ name });
    const b = w.phone();
    await b.restore({ name, recoveryKey });
    const bId = (await b.engine.getAccountInfo()).deviceId;
    await a.revokeDevice(bId);
    await expect(b.syncOnce()).rejects.toMatchObject({ code: 'E_DEVICE_REVOKED' });
    expect(await b.engine.getLockState()).toBe('locked');
    await expect(b.syncOnce()).rejects.toMatchObject({ code: 'E_DEVICE_REVOKED' });
    await b.engine.wipeLocal();
  });

  test('G3: account deletion -> the other phone gets E_ACCOUNT_DELETED', async () => {
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey } = await a.createAccount({ name });
    const b = w.phone();
    await b.restore({ name, recoveryKey });
    // deletion needs the master password (and both proofs)
    await expect(a.engine.buildDeleteAccount('nope nope nope nope')).rejects.toMatchObject({
      code: 'E_WRONG_PASSWORD',
    });
    await a.send(await a.engine.buildDeleteAccount(MASTER_PW));
    await expect(b.syncOnce()).rejects.toMatchObject({ code: 'E_ACCOUNT_DELETED' });
    await b.engine.wipeLocal();
    expect(await b.engine.getLockState()).toBe('uninitialized');
    // the name is free again and prelogin no longer knows the account
    const again = w.phone();
    await expect(again.restore({ name, recoveryKey })).rejects.toBeInstanceOf(HttpError);
  });

  test('F1: CSV import, then sync to the other phone', async () => {
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey } = await a.createAccount({ name });
    const b = w.phone();
    await b.restore({ name, recoveryKey });
    await a.engine.saveItem({
      ...sample('existing'),
      username: 'dup@zq.example',
      urls: [{ url: 'https://shop.example.com', match: 'domain' }],
    });
    const csv = [
      'name,url,username,password,note',
      'Shop,https://shop.example.com/login,dup@zq.example,pw-dup,',
      'News,https://news.example.org,reader,pw-news,"line1',
      'line2"',
      'Empty,https://e.example,u,,',
    ].join('\r\n');
    const f = a.deps.files.put('passwords.csv', csv);
    expect(await a.engine.inspectCsvImport(f)).toEqual({
      format: 'chrome',
      itemCount: 2,
      duplicateCount: 1,
      skippedCount: 1,
    });
    expect(await a.engine.importCsv(f, { skipDuplicates: true })).toEqual({ added: 1, skipped: 2 });
    await a.syncOnce();
    await b.syncOnce();
    const news = (await b.engine.listItems()).find((i) => i.title === 'News');
    expect(news).toBeDefined();
    expect(await b.engine.revealPassword(news?.id as string)).toBe('pw-news');
    expect((await b.engine.getItem(news?.id as string)).notes).toBe('line1\r\nline2');
  });

  test('AC-11 equivalent: export on phone A, import on phone B (another account)', async () => {
    const a = w.phone({ platform: 'ios' });
    await a.createAccount({ name: uniqueName() });
    const items = [sample('e1'), sample('e2'), sample('e3')];
    for (const i of items) await a.engine.saveItem(i);
    const { fileUri } = await a.engine.exportVault('export password 123');

    const b = w.phone({ platform: 'android' });
    await b.createAccount({ name: uniqueName() });
    const moved = b.deps.files.put('moved.lvbackup', await a.deps.files.read(fileUri));
    expect(await b.engine.inspectImport(moved, 'export password 123')).toEqual({
      itemCount: 3,
      conflictCount: 0,
    });
    await expect(b.engine.inspectImport(moved, 'wrong password 123')).rejects.toMatchObject({
      code: 'E_WRONG_PASSWORD',
    });
    expect(await b.engine.importVault(moved, 'export password 123', 'append')).toEqual({
      added: 3,
      updated: 0,
    });
    await b.syncOnce();
    const got = await Promise.all(
      (await b.engine.listItems()).map(async (i) => ({
        title: i.title,
        username: i.username,
        password: await b.engine.revealPassword(i.id),
        notes: (await b.engine.getItem(i.id)).notes,
      })),
    );
    expect(got.sort((x, y) => x.title.localeCompare(y.title))).toEqual(
      items
        .map((i) => ({
          title: i.title,
          username: i.username,
          password: i.password,
          notes: i.notes,
        }))
        .sort((x, y) => x.title.localeCompare(y.title)),
    );
  });
});
