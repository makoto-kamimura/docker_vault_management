import { describe, expect, test } from 'vitest';
import { FakeServer, item, newPhone, PW, restart, restoreOn, setup, syncOnce } from './helpers';

async function two() {
  const s = new FakeServer();
  const a = newPhone();
  const { recoveryKey } = await setup(s, a);
  const b = newPhone({ clock: a.clock });
  await restoreOn(s, b, recoveryKey);
  await syncOnce(a.e, s);
  return { s, a, b, recoveryKey };
}

describe('sync (§17.1 同期)', () => {
  test('push, pull, restore on a second phone (AC-26 shape)', async () => {
    const { s, a, b } = await two();
    const x = await a.e.saveItem(item('Shared'));
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    expect((await b.e.getItem(x.id)).title).toBe('Shared');
    expect(await b.e.revealPassword(x.id)).toBe('Shared-pass');
    expect((await a.e.listDevices()).filter((d) => !d.revokedAt)).toHaveLength(2);
  });

  test('both edit the same item: server wins, local edit survives as conflict copy (AC-20)', async () => {
    const { s, a, b } = await two();
    const x = await a.e.saveItem(item('Doc'));
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    await a.e.saveItem({ ...item('Doc'), id: x.id, notes: 'from A' });
    await b.e.saveItem({ ...item('Doc'), id: x.id, notes: 'from B' });
    await syncOnce(a.e, s);
    await syncOnce(b.e, s); // B pushes second -> conflict
    await syncOnce(a.e, s);
    for (const p of [a, b]) {
      const list = await p.e.listItems();
      expect(list).toHaveLength(2);
      const copy = list.find((i) => i.isConflictCopy);
      expect(copy?.title).toMatch(/^Doc（競合コピー \d{4}-\d{2}-\d{2}）$/);
      expect((await p.e.getItem(x.id)).notes).toBe('from A');
      expect(copy && (await p.e.getItem(copy.id)).conflictOf).toBe(x.id);
    }
    // resolve: keep the copy
    const copy = (await b.e.listItems()).find((i) => i.isConflictCopy);
    await b.e.resolveConflict(copy?.id as string, 'copy');
    expect((await b.e.listItems()).map((i) => i.isConflictCopy)).toEqual([false]);
  });

  test('identical edits do not create a copy', async () => {
    const { s, a, b } = await two();
    const x = await a.e.saveItem(item('Same'));
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    await a.e.saveItem({ ...item('Same'), id: x.id, notes: 'n' });
    await b.e.saveItem({ ...item('Same'), id: x.id, notes: 'n' });
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    expect(await b.e.listItems()).toHaveLength(1);
  });

  test('server deleted + local edited -> restored as a NEW item with notice', async () => {
    const { s, a, b } = await two();
    const x = await a.e.saveItem(item('Victim'));
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    await a.e.purgeItem(x.id);
    await syncOnce(a.e, s);
    await b.e.saveItem({ ...item('Victim'), id: x.id, notes: 'edited offline' });
    await syncOnce(b.e, s);
    const list = await b.e.listItems();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).not.toBe(x.id);
    expect((await b.e.getItem(list[0]?.id as string)).notes).toBe('edited offline');
    expect(await b.e.drainNotices()).toMatchObject([{ kind: 'restored-as-new', originalId: x.id }]);
    await syncOnce(a.e, s);
    expect(await a.e.listItems()).toHaveLength(1);
  });

  test('local deleted + server edited -> server version wins, notice', async () => {
    const { s, a, b } = await two();
    const x = await a.e.saveItem(item('Both'));
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    await a.e.saveItem({ ...item('Both'), id: x.id, notes: 'server edit' });
    await syncOnce(a.e, s);
    await b.e.purgeItem(x.id);
    await syncOnce(b.e, s);
    expect((await b.e.getItem(x.id)).notes).toBe('server edit');
    expect(await b.e.drainNotices()).toMatchObject([{ kind: 'server-edit-won', id: x.id }]);
  });

  test('tombstones propagate and offline edits are re-sent after reconnect (AC-21)', async () => {
    const { s, a, b } = await two();
    const x = await a.e.saveItem(item('Gone'));
    const y = await a.e.saveItem(item('Stay'));
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    await a.e.purgeItem(x.id);
    await b.e.saveItem({ ...item('Stay'), id: y.id, notes: 'offline edit' });
    // B is "offline": nothing pushed. A syncs.
    await syncOnce(a.e, s);
    expect((await b.e.getSyncState()).pendingCount).toBeGreaterThan(0);
    await syncOnce(b.e, s);
    await syncOnce(a.e, s);
    expect((await a.e.getItem(y.id)).notes).toBe('offline edit');
    expect((await b.e.listItems()).map((i) => i.title)).toEqual(['Stay']);
  });

  test('a failed push leaves changes dirty and the next sync re-sends them', async () => {
    const { s, a } = await two();
    const x = await a.e.saveItem(item('Retry'));
    const changes = await a.e.getPendingChanges(100);
    expect(changes.some((c) => c.id === x.id)).toBe(true);
    // response lost: results never applied
    expect((await a.e.getSyncState()).pendingCount).toBeGreaterThan(0);
    await syncOnce(a.e, s);
    expect((await a.e.getSyncState()).pendingCount).toBe(0);
  });

  test('edit during an in-flight push stays dirty', async () => {
    const { s, a } = await two();
    const x = await a.e.saveItem(item('Race'));
    const changes = await a.e.getPendingChanges(100);
    await a.e.saveItem({ ...item('Race'), id: x.id, notes: 'second' });
    await a.e.applyPushResults(s.push(changes));
    expect((await a.e.getSyncState()).pendingCount).toBe(1);
    await syncOnce(a.e, s);
    expect((await a.e.getSyncState()).pendingCount).toBe(0);
  });

  test('fullResync (W2 rule): restart from 0, ignore later flags, drop records the server lacks', async () => {
    const { s, a, b } = await two();
    const x = await a.e.saveItem(item('Purged'));
    const y = await a.e.saveItem(item('Alive'));
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    const local = await b.e.saveItem(item('Local only'));
    // server physically purges the tombstone of x and raises min_valid_cursor
    await a.e.purgeItem(x.id);
    await syncOnce(a.e, s);
    s.records.delete(x.id);
    s.minValid = s.recordRev;
    const r = await syncOnce(b.e, s);
    expect(r.needsMasterPassword).toBe(false);
    expect((await b.e.listItems()).map((i) => i.title).sort()).toEqual(['Alive', 'Local only']);
    await expect(b.e.getItem(x.id)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(s.records.has(local.id)).toBe(true); // the local-only record was pushed, not dropped
    expect(y.id).toBeDefined();
  });

  test('rollback detection (§7.5): older cursor, older keyset; sticky until acceptServerState', async () => {
    const { s, a } = await two();
    await a.e.saveItem(item('R1'));
    await syncOnce(a.e, s);
    const before = await a.e.getSyncState();
    s.tamperPull = (res) => ({ ...res, cursor: before.maxSeenRev - 2, records: [] });
    await expect(syncOnce(a.e, s)).rejects.toMatchObject({ code: 'E_ROLLBACK_DETECTED' });
    s.tamperPull = null;
    await expect(a.e.getPendingChanges(10)).rejects.toMatchObject({ code: 'E_ROLLBACK_DETECTED' });
    expect((await a.e.listItems()).map((i) => i.title)).toContain('R1'); // local data kept
    await a.e.acceptServerState();
    await syncOnce(a.e, s);
    expect((await a.e.getSyncState()).maxSeenRev).toBe(s.recordRev);
  });

  test('rollback detection: keyset version going backwards', async () => {
    const { s, a } = await two();
    const old = s.keyset;
    const req = await a.e.changeMasterPassword(PW, 'new master password 1');
    s.setKeyset((req.body as { keyset: typeof old }).keyset);
    await a.e.confirmKeysetAccepted();
    s.tamperPull = (res) => ({ ...res, keyset: old });
    await expect(syncOnce(a.e, s)).rejects.toMatchObject({ code: 'E_ROLLBACK_DETECTED' });
  });

  test('swapped ciphertexts are rejected, nothing is accepted', async () => {
    const { s, a, b } = await two();
    const x = await a.e.saveItem(item('X'));
    const y = await a.e.saveItem(item('Y'));
    await syncOnce(a.e, s);
    const rx = s.records.get(x.id);
    const ry = s.records.get(y.id);
    s.tamperPull = (res) => ({
      ...res,
      records: res.records.map((r) =>
        r.id === x.id && ry && !ry.deleted
          ? { ...ry, id: r.id, rev: r.rev }
          : r.id === y.id && rx && !rx.deleted
            ? { ...rx, id: r.id, rev: r.rev }
            : r,
      ),
    });
    await expect(syncOnce(b.e, s)).rejects.toMatchObject({ code: 'E_CORRUPTED' });
    expect(await b.e.listItems()).toHaveLength(0);
  });

  test('master password change on A is picked up by B (AC-28); recovery key reissue updates SK (AC-29)', async () => {
    const { s, a, b } = await two();
    const req = await a.e.changeMasterPassword(PW, 'second master password');
    expect(req.headers?.['X-LV-Admin']).toBeDefined();
    s.setKeyset((req.body as { keyset: typeof s.keyset }).keyset);
    await a.e.confirmKeysetAccepted();
    await syncOnce(b.e, s);
    await b.e.lock();
    await expect(b.e.unlockWithPassword(PW)).rejects.toMatchObject({ code: 'E_WRONG_PASSWORD' });
    await b.e.unlockWithPassword('second master password');

    const re = await a.e.regenerateRecoveryKey('second master password');
    s.setKeyset((re.request.body as { keyset: typeof s.keyset }).keyset);
    await a.e.confirmKeysetAccepted();
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    expect(await b.e.getRecoveryKey()).toBe(re.recoveryKey);
    await b.e.lock();
    await b.e.unlockWithPassword('second master password'); // uses the new SK picked up from the meta record
  });

  test('wrong version request preconditions: reset password needs the right recovery key (§8.10)', async () => {
    const { a, recoveryKey } = await two();
    await expect(
      a.e.resetMasterPassword('LV2-0000-0000-0000-0000-0000-0000-0000', 'another password 1'),
    ).rejects.toBeDefined();
    const req = await a.e.resetMasterPassword(recoveryKey, 'another password 1');
    expect((req.body as { keyset: { keysetVersion: number } }).keyset.keysetVersion).toBe(2);
  });

  test('VK rotation by another device: needsMasterPassword, then migration (AC-36 shape)', async () => {
    const { s, a, b, recoveryKey } = await two();
    const x = await a.e.saveItem(item('Rot'));
    await syncOnce(a.e, s);
    await syncOnce(b.e, s);
    const bDev = (await a.e.listDevices()).find((d) => !d.isThisDevice)?.deviceId as string;

    const reqs = await a.e.revokeDevice({ deviceId: bDev, rotateKey: true, masterPassword: PW });
    expect(reqs.map((r) => r.path)).toEqual([`/v1/devices/${bDev}`, '/v1/rotations']);
    const more = await a.e.continueRotation('11111111-1111-4111-8111-111111111111');
    const staged = more.slice(0, -1).flatMap((r) => (r.body as { records: never[] }).records);
    const commit = more.at(-1)?.body as { keyset: typeof s.keyset };
    const cursor = s.rotate(staged, commit.keyset);
    await a.e.confirmRotation({ cursor });
    await syncOnce(a.e, s);
    expect((await a.e.getItem(x.id)).title).toBe('Rot');

    // C: another approver (restored with the NEW keyset) and the "other phone" B2 which still has the old state
    const r = await syncOnce(b.e, s);
    expect(r.needsMasterPassword).toBe(true);
    expect(await b.e.isRotationPending()).toBe(true);
    await expect(b.e.getPendingChanges(10)).resolves.toEqual([]);
    await b.e.unlockWithPassword(PW);
    expect(await b.e.isRotationPending()).toBe(false);
    await syncOnce(b.e, s);
    expect((await b.e.getItem(x.id)).title).toBe('Rot');
    expect(await b.e.revealPassword(x.id)).toBe('Rot-pass');
    // revoked device record travelled in the rotation
    expect((await b.e.listDevices()).find((d) => d.deviceId === bDev)?.revokedAt).not.toBeNull();
    expect(recoveryKey).toBeDefined();
  });

  test('rotation without the master password is refused', async () => {
    const { a } = await two();
    const bDev = (await a.e.listDevices()).find((d) => !d.isThisDevice)?.deviceId as string;
    await expect(a.e.revokeDevice({ deviceId: bDev, rotateKey: true })).rejects.toMatchObject({
      code: 'E_NEEDS_MASTER_PASSWORD',
    });
  });

  test('restart keeps dirty state (persisted)', async () => {
    const { s, a } = await two();
    const x = await a.e.saveItem(item('Persist'));
    const q = restart(a);
    await q.e.unlockWithPassword(PW);
    expect((await q.e.getSyncState()).pendingCount).toBeGreaterThan(0);
    await syncOnce(q.e, s);
    expect(s.records.has(x.id)).toBe(true);
  });
});
