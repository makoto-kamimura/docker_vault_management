import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sample } from './helpers/data';
import { HttpError } from './helpers/transport';
import { uniqueName, World } from './helpers/world';

let w: World;
beforeAll(async () => {
  w = await World.create();
});
afterAll(async () => w.close());

describe('scenario 1: account creation and restore', () => {
  test('AC-26: second phone restores with master password + recovery key', async () => {
    const name = uniqueName();
    const a = w.phone({ name: 'Phone A' });
    const { recoveryKey } = await a.createAccount({ name });
    const x = await a.engine.saveItem(sample('one'));
    const y = await a.engine.saveItem(sample('two'));
    await a.syncOnce();

    const b = w.phone({ name: 'Phone B' });
    await b.restore({ name: name.toUpperCase(), recoveryKey }); // account names are case-folded
    expect((await b.engine.listItems()).map((i) => i.title).sort()).toEqual(
      [sample('one').title, sample('two').title].sort(),
    );
    expect(await b.engine.revealPassword(x.id)).toBe(sample('one').password);
    expect(await b.engine.revealPassword(y.id)).toBe(sample('two').password);
    expect(await b.engine.getLockState()).toBe('unlocked');
    await a.syncOnce();
    expect((await a.engine.listDevices()).filter((d) => d.revokedAt === null)).toHaveLength(2);
    expect(await a.engine.getRecoveryKey()).toBe(recoveryKey);
  });

  test('AC-27: a wrong recovery key fails at the server, a wrong password fails locally', async () => {
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey } = await a.createAccount({ name });
    const other = (await w.phone().createAccount({ name: uniqueName() })).recoveryKey;

    const b = w.phone();
    await expect(b.restore({ name, recoveryKey: other })).rejects.toMatchObject({
      constructor: HttpError,
      code: 'E_UNAUTHORIZED',
    });
    expect(await b.engine.getLockState()).toBe('uninitialized');

    const c = w.phone();
    await expect(
      b.restore({ name, recoveryKey: 'LV2-0000-0000-0000-0000-0000-0000-0000' }),
    ).rejects.toMatchObject({
      code: 'E_INVALID_RECOVERY_KEY',
    });
    // right key, wrong password: the server rejects the authKey too
    await expect(
      c.restore({ name, recoveryKey, password: 'not the right password' }),
    ).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED',
    });
    await c.restore({ name, recoveryKey });
    expect(await c.engine.getLockState()).toBe('unlocked');
  });
});
