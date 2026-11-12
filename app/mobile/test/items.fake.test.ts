import { describe, expect, it } from 'vitest';
import { FakeVaultCore } from '../src/native/fake/FakeVaultCore';

const base = { username: 'u', urls: [], notes: '', favorite: false };

describe('FakeVaultCore items (F2 history, copy, trash)', () => {
  it('stacks the previous password on change, newest first, max 5, and clears', async () => {
    const core = new FakeVaultCore({ lockState: 'unlocked' });
    const d = await core.saveItem({ ...base, title: 'a', password: 'p0' });
    for (let i = 1; i <= 7; i++)
      await core.saveItem({ ...base, id: d.id, title: 'a', password: `p${i}` });
    const h = await core.getPasswordHistory(d.id);
    expect(h).toHaveLength(5);
    expect(await core.revealHistoricPassword(d.id, 0)).toBe('p6');
    expect(await core.revealPassword(d.id)).toBe('p7');
    await core.clearPasswordHistory(d.id);
    expect(await core.getPasswordHistory(d.id)).toEqual([]);
  });

  it('an unchanged password (omitted) does not touch the history', async () => {
    const core = new FakeVaultCore({ lockState: 'unlocked' });
    const d = await core.saveItem({ ...base, title: 'a', password: 'p0' });
    await core.saveItem({ ...base, id: d.id, title: 'renamed' });
    expect(await core.getPasswordHistory(d.id)).toEqual([]);
    expect(await core.revealPassword(d.id)).toBe('p0');
  });

  it('copy reports when the clipboard clears, trash and restore round-trip', async () => {
    const core = new FakeVaultCore({ lockState: 'unlocked', now: () => 1_000 });
    const d = await core.saveItem({ ...base, title: 'a', password: 'p' });
    expect((await core.copy(d.id, 'password')).clearsAt).toBe(new Date(31_000).toISOString());
    await core.trashItem(d.id);
    expect(await core.listItems()).toHaveLength(0);
    await core.restoreItem(d.id);
    expect(await core.listItems()).toHaveLength(1);
    await core.purgeItem(d.id);
    await expect(core.getItem(d.id)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });
});
