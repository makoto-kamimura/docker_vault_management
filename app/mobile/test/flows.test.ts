import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api';
import {
  createAccountFlow,
  pollClaimFlow,
  restoreAccountFlow,
  startClaimFlow,
} from '../src/features/setup/flows';
import { FakeVaultCore, fakeB64, fakeId, fakeKeyset } from '../src/native/fake/FakeVaultCore';
import { createFakeFetch } from '../src/native/fake/fakeFetch';
import { apiError, json, makeFetch } from './helpers';

const makeApiWith = (f: typeof fetch) => (origin: string) =>
  createApiClient({ baseUrl: () => origin, fetch: f });

describe('account creation flow', () => {
  it('commits only after the server accepted', async () => {
    const core = new FakeVaultCore();
    const { recoveryKey } = await createAccountFlow({
      core,
      makeApi: makeApiWith(createFakeFetch()),
      serverUrl: 'https://vault.example.com',
      accountName: 'Alice',
      masterPassword: 'correct horse battery',
      inviteCode: '',
    });
    expect(recoveryKey).toMatch(/^LV2(-[0-9A-Z]{4}){7}$/);
    expect(await core.getLockState()).toBe('unlocked');
    expect((await core.getAccountInfo()).accountName).toBe('alice');
  });

  it('reports key generation before registering with the server', async () => {
    const steps: string[] = [];
    await createAccountFlow({
      core: new FakeVaultCore(),
      makeApi: makeApiWith(createFakeFetch()),
      serverUrl: 'https://vault.example.com',
      accountName: 'alice',
      masterPassword: 'correct horse battery',
      inviteCode: '',
      onProgress: (s) => steps.push(s),
    });
    expect(steps).toEqual(['keys', 'register']);
  });

  it('discards the pending account when the server refuses', async () => {
    const core = new FakeVaultCore();
    const { fetch } = makeFetch(() => apiError(403, 'E_REGISTRATION_CLOSED'));
    await expect(
      createAccountFlow({
        core,
        makeApi: makeApiWith(fetch),
        serverUrl: 'https://v.example.com',
        accountName: 'alice',
        masterPassword: 'correct horse battery',
        inviteCode: 'x',
      }),
    ).rejects.toMatchObject({ code: 'E_REGISTRATION_CLOSED' });
    expect(await core.getLockState()).toBe('uninitialized');
    await expect(core.commitAccount()).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });
});

describe('restore flow', () => {
  it('lower-cases the name for prelogin and stops on a mistyped key before any request', async () => {
    const { fetch, calls } = makeFetch(
      (c) =>
        c.url.includes('/v1/prelogin')
          ? json(200, { accountId: fakeId(), kdf: fakeKeyset().kdf })
          : undefined,
      (c) =>
        c.url.endsWith('/v1/auth/recover')
          ? json(200, {
              accessToken: 'a.b.c',
              expiresAt: new Date(Date.now() + 1e6).toISOString(),
              keyset: fakeKeyset(),
            })
          : undefined,
    );
    const core = new FakeVaultCore();
    const key = (await core.regenerateRecoveryKey('x')).recoveryKey;
    const typo = key.slice(0, -1) + (key.endsWith('0') ? '1' : '0');
    await expect(
      restoreAccountFlow({
        core,
        makeApi: makeApiWith(fetch),
        serverUrl: 'https://v.example.com',
        accountName: 'Alice',
        masterPassword: 'pw',
        recoveryKey: typo,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_RECOVERY_KEY' });
    expect(calls).toHaveLength(0);

    await restoreAccountFlow({
      core,
      makeApi: makeApiWith(fetch),
      serverUrl: 'https://v.example.com',
      accountName: 'ＡＬＩＣＥ',
      masterPassword: 'pw',
      recoveryKey: key,
    });
    expect(calls[0]?.url).toContain('account=alice');
    expect(await core.getLockState()).toBe('unlocked');
  });
});

describe('recovery claim flows', () => {
  it('starts a claim by QR-less manual input and remembers it', async () => {
    const { fetch } = makeFetch(
      (c) =>
        c.url.includes('/v1/prelogin')
          ? json(200, { accountId: fakeId(), kdf: fakeKeyset().kdf })
          : undefined,
      (c) =>
        c.url.endsWith('/v1/recovery-claims')
          ? json(201, {
              claimId: fakeId(),
              claimToken: fakeB64(32),
              availableAt: new Date(Date.now() + 1e6).toISOString(),
              accountName: 'alice',
            })
          : undefined,
    );
    const core = new FakeVaultCore();
    const r = await startClaimFlow({
      core,
      makeApi: makeApiWith(fetch),
      source: {
        kind: 'manual',
        serverUrl: 'vault.example.com',
        accountName: 'alice',
        text: 'LVRC-X',
      },
    });
    expect(r.accountName).toBe('alice');
    expect(await core.getPendingRecoveryClaim()).not.toBeNull();
  });

  it('treats E_CLAIM_WAITING as waiting and completes afterwards', async () => {
    const core = new FakeVaultCore();
    await core.rememberRecoveryClaim({
      claimId: fakeId(),
      claimToken: fakeB64(32),
      availableAt: new Date().toISOString(),
    });
    const availableAt = new Date(Date.now() + 60_000).toISOString();
    let waiting = true;
    const { fetch } = makeFetch((c) =>
      c.url.includes('/complete')
        ? waiting
          ? apiError(409, 'E_CLAIM_WAITING', { availableAt })
          : json(200, {
              accessToken: 'a.b.c',
              accountName: 'alice',
              keyset: fakeKeyset(),
              wrappedVK: fakeKeyset().wrappedVK,
              vkVersion: 1,
            })
        : undefined,
    );
    const deps = { core, makeApi: makeApiWith(fetch) };
    await expect(pollClaimFlow(deps)).resolves.toEqual({ status: 'waiting', availableAt });
    waiting = false;
    await expect(pollClaimFlow(deps)).resolves.toEqual({ status: 'completed' });
    expect(await core.getLockState()).toBe('unlocked');
  });
});
