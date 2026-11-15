import { describe, expect, test } from 'vitest';
import { FakeServer, item, newPhone, PW, restart, setup } from './helpers';

describe('保存 (§17.1, NFR-06)', () => {
  test('crash after step 1 (tmp written): old file intact', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    const a = await p.e.saveItem(item('Before'));
    p.deps.storage.failWhen = (op, detail) =>
      op === 'rename' && detail === 'vault.lv->vault.lv.bak';
    await expect(
      p.e.saveItem({ ...item('Before'), id: a.id, notes: 'lost' }),
    ).rejects.toMatchObject({ code: 'E_IO' });
    p.deps.storage.failWhen = null;
    const q = restart(p);
    await q.e.unlockWithPassword(PW);
    expect((await q.e.getItem(a.id)).notes).toBe('');
  });

  test('crash after step 2 (main renamed to .bak, tmp not yet promoted): tmp is used', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    const a = await p.e.saveItem(item('Before'));
    p.deps.storage.failWhen = (op, detail) =>
      op === 'rename' && detail === 'vault.lv.tmp->vault.lv';
    await expect(p.e.saveItem({ ...item('Before'), id: a.id, notes: 'new' })).rejects.toMatchObject(
      { code: 'E_IO' },
    );
    p.deps.storage.failWhen = null;
    expect(p.deps.storage.files.has('vault.lv')).toBe(false);
    const q = restart(p);
    await q.e.unlockWithPassword(PW);
    expect((await q.e.getItem(a.id)).notes).toBe('new');
    expect((await q.e.getStorageStatus()).recoveredFromBackup).toBe(true);
  });

  test('crash after step 2 with a partial tmp: falls back to .bak', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    const a = await p.e.saveItem(item('Before'));
    p.deps.storage.failWhen = (op, detail) =>
      op === 'rename' && detail === 'vault.lv.tmp->vault.lv';
    await expect(p.e.saveItem({ ...item('Before'), id: a.id, notes: 'new' })).rejects.toBeDefined();
    p.deps.storage.failWhen = null;
    p.deps.storage.files.set('vault.lv.tmp', new TextEncoder().encode('{"format":"loc'));
    const q = restart(p);
    await q.e.unlockWithPassword(PW);
    expect((await q.e.getItem(a.id)).notes).toBe('');
  });

  test('AC-12: 1-byte corruption of a record -> recovered from .bak', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    const a = await p.e.saveItem(item('Keep'));
    await p.e.saveItem(item('Second')); // creates a .bak that contains the first item
    const raw = new TextDecoder().decode(p.deps.storage.files.get('vault.lv'));
    const at = raw.indexOf('"ct":"', raw.indexOf(a.id)) + 12;
    p.deps.storage.corrupt('vault.lv', at);
    const q = restart(p);
    await q.e.unlockWithPassword(PW);
    expect(await q.e.getItem(a.id)).toMatchObject({ title: 'Keep' });
    expect((await q.e.getStorageStatus()).recoveredFromBackup).toBe(true);
  });

  test('AC-12: damaged file and damaged backup -> E_CORRUPTED, then wipe and restore path', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    const a = await p.e.saveItem(item('Keep'));
    await p.e.saveItem(item('Second'));
    for (const f of ['vault.lv', 'vault.lv.bak']) {
      const raw = new TextDecoder().decode(p.deps.storage.files.get(f));
      p.deps.storage.corrupt(f, raw.indexOf('"ct":"', raw.indexOf(a.id)) + 12);
    }
    const q = restart(p);
    await expect(q.e.unlockWithPassword(PW)).rejects.toMatchObject({ code: 'E_CORRUPTED' });
    // unreadable JSON is E_CORRUPTED as well
    p.deps.storage.files.set('vault.lv', new TextEncoder().encode('garbage'));
    p.deps.storage.files.set('vault.lv.bak', new TextEncoder().encode('garbage'));
    const r = restart(p);
    expect(await r.e.getLockState()).toBe('locked');
    await expect(r.e.unlockWithPassword(PW)).rejects.toMatchObject({ code: 'E_CORRUPTED' });
    await r.e.wipeLocal();
    expect(await r.e.getLockState()).toBe('uninitialized');
    expect(p.deps.storage.files.size).toBe(0);
    expect(p.deps.keystore.slots.size).toBe(0);
  });

  test('a wiped device leaves nothing behind (sign-out, G2)', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    const reqs = await p.e.buildSignOutDevice();
    expect(reqs.at(-1)?.method).toBe('DELETE');
    expect(reqs.at(-1)?.path).toMatch(/^\/v1\/devices\//);
    expect(reqs[0]?.path).toBe('/v1/records/batch');
    await p.e.wipeLocal();
    expect(p.deps.storage.files.size).toBe(0);
  });
});
