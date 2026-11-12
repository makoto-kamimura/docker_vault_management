import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sample } from './helpers/data';
import type { VirtualPhone } from './helpers/phone';
import { uniqueName, World } from './helpers/world';

let w: World;
beforeAll(async () => {
  w = await World.create();
});
afterAll(async () => w.close());

async function twoPhones(): Promise<[VirtualPhone, VirtualPhone]> {
  const name = uniqueName();
  const a = w.phone({ name: 'A' });
  const { recoveryKey } = await a.createAccount({ name });
  const b = w.phone({ name: 'B' });
  await b.restore({ name, recoveryKey });
  return [a, b];
}

describe('scenario 2: two phones, offline edits, conflicts', () => {
  test('AC-20: the same item edited offline on both phones -> conflict copy survives', async () => {
    const [a, b] = await twoPhones();
    const x = await a.engine.saveItem(sample('doc'));
    await a.syncOnce();
    await b.syncOnce();
    // both are "offline" while editing
    await a.engine.saveItem({ ...sample('doc'), id: x.id, notes: 'edit from A' });
    await b.engine.saveItem({ ...sample('doc'), id: x.id, notes: 'edit from B' });
    await a.syncOnce();
    await b.syncOnce();
    await a.syncOnce();
    for (const p of [a, b]) {
      const list = await p.engine.listItems();
      expect(list).toHaveLength(2);
      expect((await p.engine.getItem(x.id)).notes).toBe('edit from A');
      const copy = list.find((i) => i.isConflictCopy);
      expect(copy?.title).toContain('競合コピー');
      expect((await p.engine.getItem(copy?.id as string)).notes).toBe('edit from B');
    }
  });

  test('AC-21: offline edits propagate after reconnecting', async () => {
    const [a, b] = await twoPhones();
    const x = await a.engine.saveItem(sample('late'));
    await a.syncOnce();
    await b.syncOnce();
    await b.engine.saveItem({ ...sample('late'), id: x.id, notes: 'written offline' });
    const added = await b.engine.saveItem(sample('new-offline'));
    expect((await b.engine.getSyncState()).pendingCount).toBe(2);
    await b.syncOnce(); // connectivity returns
    await a.syncOnce();
    expect((await a.engine.getItem(x.id)).notes).toBe('written offline');
    expect((await a.engine.getItem(added.id)).title).toBe(sample('new-offline').title);
  });

  test('delete on one phone vs edit on the other', async () => {
    const [a, b] = await twoPhones();
    const x = await a.engine.saveItem(sample('del-edit'));
    const y = await a.engine.saveItem(sample('edit-del'));
    await a.syncOnce();
    await b.syncOnce();
    // A deletes x, B edits x  -> the edit is restored as a NEW item on B
    await a.engine.purgeItem(x.id);
    await a.syncOnce();
    await b.engine.saveItem({ ...sample('del-edit'), id: x.id, notes: 'B edited' });
    // B deletes y, A edits y -> A's edit (server) wins on B
    await a.engine.saveItem({ ...sample('edit-del'), id: y.id, notes: 'A edited' });
    await a.syncOnce();
    await b.engine.purgeItem(y.id);
    await b.syncOnce();
    await a.syncOnce();
    const notices = await b.engine.drainNotices();
    expect(notices.map((n) => n.kind).sort()).toEqual(['restored-as-new', 'server-edit-won']);
    for (const p of [a, b]) {
      const notes = await Promise.all(
        (await p.engine.listItems()).map(async (i) => (await p.engine.getItem(i.id)).notes),
      );
      expect(notes.sort()).toEqual(['A edited', 'B edited']);
    }
    await expect(b.engine.getItem(x.id)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });
});
