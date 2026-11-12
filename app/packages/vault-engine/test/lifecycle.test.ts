import { VaultCoreError } from '@localvault/core';
import { describe, expect, test } from 'vitest';
import { FakeServer, newPhone, noble, PW, restart, setup } from './helpers';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof VaultCoreError) return e;
    throw e;
  }
  throw new Error('did not reject');
};

describe('account creation and lock state', () => {
  test('two-phase creation, discard, lock/unlock, restart', async () => {
    const s = new FakeServer();
    const p = newPhone();
    expect(await p.e.getLockState()).toBe('uninitialized');
    const events: string[] = [];
    p.e.on('onLockStateChange', (x) => events.push(x.state));

    const { request, recoveryKey } = await p.e.createAccount({
      serverUrl: 'https://Vault.test:443',
      accountName: 'Alice',
      masterPassword: PW,
      inviteCode: 'inv',
    });
    expect(request.path).toBe('/v1/accounts');
    expect(recoveryKey).toMatch(/^LV2(-[0-9A-Z]{4}){7}$/);
    const body = request.body as {
      accountName: string;
      keyset: { keysetVersion: number; vkVersion: number };
    };
    expect(body.accountName).toBe('alice');
    expect(body.keyset).toMatchObject({ keysetVersion: 1, vkVersion: 1 });
    expect(await p.e.getLockState()).toBe('uninitialized');
    await p.e.discardPendingAccount();
    await code(p.e.commitAccount());

    const again = await p.e.createAccount({
      serverUrl: 'https://vault.test',
      accountName: 'alice',
      masterPassword: PW,
      inviteCode: 'x',
    });
    s.keyset = (again.request.body as { keyset: typeof s.keyset }).keyset;
    await p.e.commitAccount();
    expect(await p.e.getLockState()).toBe('unlocked');
    expect((await p.e.getAccountInfo()).serverUrl).toBe('https://vault.test');
    expect((await p.e.getSyncState()).pendingCount).toBe(2); // meta + device record

    await p.e.lock();
    expect(await p.e.getLockState()).toBe('locked');
    await code(p.e.listItems()).then((e) => expect(e.code).toBe('E_LOCKED'));

    const q = restart(p);
    expect(await q.e.getLockState()).toBe('locked');
    await q.e.unlockWithPassword(PW);
    expect(await q.e.getLockState()).toBe('unlocked');
    expect(events).toContain('unlocked');
    expect(await q.e.getRecoveryKey()).toBe(again.recoveryKey);
  });

  test('rejects short passwords and bad account names', async () => {
    const p = newPhone();
    const base = { serverUrl: 'https://vault.test', inviteCode: 'x' };
    expect(
      (await code(p.e.createAccount({ ...base, accountName: 'alice', masterPassword: 'short' })))
        .code,
    ).toBe('E_INVALID_INPUT');
    expect(
      (await code(p.e.createAccount({ ...base, accountName: '-x', masterPassword: PW }))).code,
    ).toBe('E_INVALID_INPUT');
    expect(
      (
        await code(
          p.e.createAccount({
            serverUrl: 'http://example.com',
            inviteCode: 'x',
            accountName: 'alice',
            masterPassword: PW,
          }),
        )
      ).code,
    ).toBe('E_INVALID_INPUT');
  });
});

describe('throttle and biometrics', () => {
  test('FR-12: 5 failures -> wait, doubles, persisted across restart, reset on success', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    await p.e.lock();
    for (let i = 0; i < 4; i++) {
      const e = await code(p.e.unlockWithPassword('wrong-password'));
      expect(e.code).toBe('E_WRONG_PASSWORD');
      expect(e.details?.attemptsLeft).toBe(4 - i);
    }
    const fifth = await code(p.e.unlockWithPassword('wrong-password'));
    expect(fifth.code).toBe('E_WRONG_PASSWORD');
    expect(fifth.details?.retryAfterSec).toBe(30);
    const q = restart(p); // the counter lives in the keystore, not in memory
    const th = await code(q.e.unlockWithPassword(PW));
    expect(th.code).toBe('E_THROTTLED');
    expect(th.details?.retryAfterSec).toBeGreaterThan(0);
    expect((await q.e.getThrottleState()).failedCount).toBe(5);
    p.clock.advance(31_000);
    await q.e.unlockWithPassword(PW);
    expect(await q.e.getThrottleState()).toEqual({ failedCount: 0, retryAfterSec: 0 });
  });

  test('biometric unlock: success, cancel, fail, invalidated -> password -> re-enable (FR-13)', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    await p.e.enableBiometrics();
    await p.e.lock();
    await p.e.unlockWithBiometrics();
    expect(await p.e.getLockState()).toBe('unlocked');
    await p.e.lock();
    p.deps.biometric.script('cancel');
    expect((await code(p.e.unlockWithBiometrics())).code).toBe('E_AUTH_CANCELED');
    p.deps.biometric.script('fail');
    expect((await code(p.e.unlockWithBiometrics())).code).toBe('E_AUTH_FAILED');
    p.deps.biometric.invalidate();
    expect((await code(p.e.unlockWithBiometrics())).code).toBe('E_BIOMETRY_INVALIDATED');
    await p.e.unlockWithPassword(PW);
    await p.e.enableBiometrics();
    await p.e.lock();
    await p.e.unlockWithBiometrics();
    await p.e.disableBiometrics();
    await p.e.lock();
    expect((await code(p.e.unlockWithBiometrics())).code).toBe('E_BIOMETRY_UNAVAILABLE');
  });

  test('FR-11: auto-lock uses the time spent in the background', async () => {
    const s = new FakeServer();
    const p = newPhone();
    await setup(s, p);
    await p.e.updateSettings({ autoLockSec: 30 });
    await p.e.onBackground();
    p.clock.advance(20_000);
    await p.e.onForeground();
    expect(await p.e.getLockState()).toBe('unlocked');
    await p.e.onBackground();
    p.clock.advance(31_000);
    await p.e.onForeground();
    expect(await p.e.getLockState()).toBe('locked');
  });
});

describe('noble provider smoke', () => {
  test('create, save, lock, unlock with the pure-JS provider', async () => {
    const s = new FakeServer();
    const p = newPhone({ crypto: noble });
    await setup(s, p);
    const saved = await p.e.saveItem({
      title: 'Smoke',
      username: 'u',
      password: 'pw',
      urls: [],
      notes: '',
      favorite: false,
    });
    await p.e.lock();
    await p.e.unlockWithPassword(PW);
    expect(await p.e.revealPassword(saved.id)).toBe('pw');
  }, 300_000);
});
