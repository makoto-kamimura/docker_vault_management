import { VaultCoreError } from '@localvault/core';
import { describe, expect, test } from 'vitest';
import { FakeServer, item, newPhone, PW, restart, setup, syncOnce } from './helpers';

async function fresh() {
  const s = new FakeServer();
  const p = newPhone();
  await setup(s, p);
  return { s, p, e: p.e };
}

describe('items', () => {
  test('CRUD, summaries, hosts, search, favorites', async () => {
    const { e } = await fresh();
    const a = await e.saveItem(item('Github', { favorite: true }));
    await e.saveItem(item('Gitlab'));
    expect(a.hasPassword).toBe(true);
    expect(a).not.toHaveProperty('password');
    const list = await e.listItems();
    expect(list.map((i) => i.title).sort()).toEqual(['Github', 'Gitlab']);
    expect(list.find((i) => i.title === 'Github')?.hosts).toEqual(['github.example.com']);
    expect((await e.searchItems('ＧＩＴＨＵＢ')).map((i) => i.title)).toEqual(['Github']);
    const upd = await e.saveItem({ ...item('Github'), id: a.id, username: 'new' });
    expect(upd.username).toBe('new');
    expect(await e.revealPassword(a.id)).toBe('Github-pass'); // password omitted = unchanged
    await expect(e.getItem('00000000-0000-4000-8000-0000000000aa')).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
  });

  test('F2 password history: newest first, max 5, reveal/copy/clear', async () => {
    const { e, p } = await fresh();
    const a = await e.saveItem(item('Bank'));
    for (let i = 1; i <= 7; i++) await e.saveItem({ ...item('Bank'), id: a.id, password: `p${i}` });
    const h = await e.getPasswordHistory(a.id);
    expect(h).toHaveLength(5);
    expect(await e.revealHistoricPassword(a.id, 0)).toBe('p6');
    expect(await e.revealHistoricPassword(a.id, 4)).toBe('p2');
    const r = await e.copyHistoricPassword(a.id, 1);
    expect(p.deps.clipboard.text).toBe('p5');
    expect(r.clearsAt).not.toBeNull();
    await e.clearPasswordHistory(a.id);
    expect(await e.getPasswordHistory(a.id)).toEqual([]);
    await expect(e.revealHistoricPassword(a.id, 0)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });

  test('copy uses the clipboard dependency and the TTL setting; usage history is local', async () => {
    const { e, p } = await fresh();
    const a = await e.saveItem(item('Mail'));
    const r = await e.copy(a.id, 'password');
    expect(p.deps.clipboard.history.at(-1)).toEqual({ text: 'Mail-pass', ttlSec: 60 });
    expect(r.clearsAt).toBe(new Date(p.clock.now().getTime() + 60_000).toISOString());
    await e.updateSettings({ clipboardClearSec: null });
    expect((await e.copy(a.id, 'username')).clearsAt).toBeNull();
    expect((await e.listItems())[0]?.lastUsedAt).not.toBeNull();
    // the usage file is encrypted and not part of the vault
    const usage = p.deps.storage.files.get('usage.lv');
    expect(usage).toBeDefined();
    expect(new TextDecoder().decode(usage)).not.toContain('lastUsedAt');
    await e.lock();
    await restart(p).e.unlockWithPassword(PW);
  });

  test('trash, restore, purge; 30-day purge produces real deletions (§7.6)', async () => {
    const { s, e, p } = await fresh();
    const a = await e.saveItem(item('Old'));
    const b = await e.saveItem(item('Keep'));
    await syncOnce(e, s);
    await e.trashItem(a.id);
    expect((await e.listItems()).map((i) => i.title)).toEqual(['Keep']);
    expect(await e.listItems({ includeTrashed: true })).toHaveLength(2);
    await e.restoreItem(a.id);
    expect(await e.listItems()).toHaveLength(2);
    await e.trashItem(a.id);
    await syncOnce(e, s);
    expect(s.records.get(a.id)?.deleted).toBe(false);
    p.clock.advance(29 * 86_400_000);
    expect(await e.purgeExpiredTrash()).toBe(0);
    p.clock.advance(2 * 86_400_000);
    await syncOnce(e, s); // getPendingChanges purges first
    expect(s.records.get(a.id)).toMatchObject({ deleted: true, nonce: null, ct: null });
    expect(s.records.get(b.id)?.deleted).toBe(false);
    await expect(e.getItem(a.id)).rejects.toBeInstanceOf(VaultCoreError);
  });

  test('purge of a never-synced item sends nothing', async () => {
    const { e } = await fresh();
    const before = (await e.getSyncState()).pendingCount;
    const a = await e.saveItem(item('Temp'));
    await e.purgeItem(a.id);
    expect((await e.getSyncState()).pendingCount).toBe(before);
  });

  test('generator and settings', async () => {
    const { e } = await fresh();
    const pw = await e.generatePassword({
      length: 24,
      upper: true,
      lower: true,
      digits: true,
      symbols: false,
      excludeAmbiguous: true,
    });
    expect(pw).toHaveLength(24);
    await expect(
      e.generatePassword({
        length: 3,
        upper: true,
        lower: true,
        digits: true,
        symbols: true,
        excludeAmbiguous: false,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    await e.updateSettings({ autoLockSec: 300, pcSessionMaxSec: 28800 });
    expect(await e.getSettings()).toMatchObject({ autoLockSec: 300, pcSessionMaxSec: 28800 });
    expect(await e.getAutofillStatus()).toEqual({
      supported: false,
      enabled: false,
      textInsertionSupported: false,
    });
    expect(await e.requestEnableAutofill()).toBe(false);
  });

  test('G8 trusted browsers: Android only, built-ins fixed', async () => {
    const ios = await fresh();
    expect(await ios.e.listTrustedBrowsers()).toEqual([]);
    const s = new FakeServer();
    const p = newPhone({ platform: 'android' });
    await setup(s, p);
    const base = (await p.e.listTrustedBrowsers()).length;
    await p.e.addTrustedBrowser('com.vivaldi.browser');
    expect(await p.e.listTrustedBrowsers()).toHaveLength(base + 1);
    await p.e.removeTrustedBrowser('com.vivaldi.browser');
    await expect(p.e.removeTrustedBrowser('com.android.chrome')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
  });

  test('backup: export / inspect / import strategies, CSV (F1), lastExportAt', async () => {
    const { e, p } = await fresh();
    const a = await e.saveItem(item('One'));
    await e.saveItem(item('Two'));
    const t = await e.saveItem(item('Gone'));
    await e.trashItem(t.id);
    expect((await e.getBackupInfo()).lastExportAt).toBeNull();
    const { fileUri } = await e.exportVault('export-password-1');
    expect((await e.getBackupInfo()).lastExportAt).not.toBeNull();
    expect(await e.inspectImport(fileUri, 'export-password-1')).toEqual({
      itemCount: 2,
      conflictCount: 2,
    });
    await expect(e.inspectImport(fileUri, 'wrong-password-1')).rejects.toMatchObject({
      code: 'E_WRONG_PASSWORD',
    });
    const bad = p.deps.files.put('x.lvbackup', 'not json');
    await expect(e.inspectImport(bad, 'x')).rejects.toMatchObject({ code: 'E_IMPORT_FORMAT' });

    await e.saveItem({ ...item('One'), id: a.id, title: 'One edited' });
    expect(await e.importVault(fileUri, 'export-password-1', 'newer')).toEqual({
      added: 0,
      updated: 0,
    });
    expect(await e.importVault(fileUri, 'export-password-1', 'append')).toEqual({
      added: 2,
      updated: 0,
    });
    expect(await e.listItems()).toHaveLength(4);
    expect(await e.importVault(fileUri, 'export-password-1', 'replace')).toEqual({
      added: 0,
      updated: 2,
    });
    expect((await e.listItems()).map((i) => i.title).sort()).toEqual(['One', 'Two']);
    await e.deleteExportFile(fileUri);
    expect(p.deps.files.files.has(fileUri)).toBe(false);

    const csv =
      'name,url,username,password,note\nShop,https://shop.example.com,bob,s3cret,hi\nNo pw,https://x.example,u,,\nOne,https://one.example.com,One-user,dup,\n';
    const f = p.deps.files.put('pw.csv', csv);
    expect(await e.inspectCsvImport(f)).toEqual({
      format: 'chrome',
      itemCount: 2,
      duplicateCount: 1,
      skippedCount: 1,
    });
    expect(await e.importCsv(f, { skipDuplicates: true })).toEqual({ added: 1, skipped: 2 });
    expect((await e.searchItems('shop'))[0]?.username).toBe('bob');
  });
});
