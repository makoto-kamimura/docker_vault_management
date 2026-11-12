import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sample } from './helpers/data';
import { MASTER_PW } from './helpers/phone';
import { uniqueName, World } from './helpers/world';

let w: World;
beforeAll(async () => {
  w = await World.create();
});
afterAll(async () => w.close());

const NEW_PW = 'a completely different master password';

describe('scenario 5: master password and recovery key changes', () => {
  test('AC-28: master password change is seen by the other phone', async () => {
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey } = await a.createAccount({ name });
    const x = await a.engine.saveItem(sample('pw'));
    await a.syncOnce();
    const b = w.phone();
    await b.restore({ name, recoveryKey });

    await a.changeMasterPassword(MASTER_PW, NEW_PW);
    await b.syncOnce();
    await b.engine.lock();
    await expect(b.engine.unlockWithPassword(MASTER_PW)).rejects.toMatchObject({
      code: 'E_WRONG_PASSWORD',
    });
    await b.engine.unlockWithPassword(NEW_PW);
    expect(await b.engine.revealPassword(x.id)).toBe(sample('pw').password);

    // a fresh device restores with the new password only
    const c = w.phone();
    await expect(c.restore({ name, recoveryKey })).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED',
    });
    await c.restore({ name, recoveryKey, password: NEW_PW });
    expect(await c.engine.revealPassword(x.id)).toBe(sample('pw').password);
    // a wrong current password is refused locally
    await expect(
      a.engine.changeMasterPassword('wrong wrong wrong', 'whatever whatever'),
    ).rejects.toMatchObject({ code: 'E_WRONG_PASSWORD' });
  });

  test('AC-29: recovery key reissue -> old key rejected, new accepted; the other phone follows', async () => {
    const name = uniqueName();
    const a = w.phone();
    const { recoveryKey: oldKey } = await a.createAccount({ name });
    const x = await a.engine.saveItem(sample('rk'));
    await a.syncOnce();
    const b = w.phone();
    await b.restore({ name, recoveryKey: oldKey });

    const newKey = await a.regenerateRecoveryKey();
    expect(newKey).not.toBe(oldKey);
    await expect(w.phone().restore({ name, recoveryKey: oldKey })).rejects.toMatchObject({
      code: 'E_UNAUTHORIZED',
    });
    const c = w.phone();
    await c.restore({ name, recoveryKey: newKey });
    expect(await c.engine.revealPassword(x.id)).toBe(sample('rk').password);

    await b.syncOnce(); // picks up the new SK from the meta record (§7.7)
    expect(await b.engine.getRecoveryKey()).toBe(newKey);
    await b.engine.lock();
    await b.engine.unlockWithPassword(MASTER_PW);
    // §8.10: forgot the master password but still unlocked by biometrics -> reset with the recovery key
    const req = await b.engine.resetMasterPassword(newKey, 'reset via recovery key 1');
    await b.send(req);
    await b.engine.confirmKeysetAccepted();
    await a.syncOnce();
    await a.engine.lock();
    await a.engine.unlockWithPassword('reset via recovery key 1');
  });
});
