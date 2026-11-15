import { type VaultCore, VaultCoreError } from '@localvault/core';
import { ApiError, AUDIT_EVENT_KINDS } from '@localvault/protocol';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '../src/api';
import { NetworkError } from '../src/api/errors';
import {
  accountNameMatches,
  changeMasterPasswordFlow,
  deleteAccountFlow,
  regenerateRecoveryKeyFlow,
  signOutFlow,
} from '../src/features/account/flows';
import {
  exportFlow,
  exportPasswordProblem,
  runCsvImport,
  runImport,
} from '../src/features/backup/flows';
import {
  confirmSheetFlow,
  disableRecoveryCodeFlow,
  getRcStatus,
  issueRecoveryCodeFlow,
  sheetTail,
  tailMatches,
} from '../src/features/recovery-code/flows';
import {
  deviceNameMap,
  KIND_LABEL,
  loadAuditPage,
  severity,
} from '../src/features/security-log/flows';
import { describeActionError, isClockSkew, isRetryable } from '../src/features/settings/errors';
import { patchSettings, reenrollBiometrics, setBiometrics } from '../src/features/settings/flows';
import { changeServerFlow, ServerChangeError } from '../src/features/settings/serverFlows';
import { createMemoryFlagStore, FLAGS } from '../src/lib/flagStore';
import { formatSpan, relativeTime } from '../src/lib/format';
import { FakeVaultCore, fakeB64, fakeId, fakeKeyset } from '../src/native/fake/FakeVaultCore';
import { w4b } from '../src/native/fake/w4bFake';
import { apiError, json, makeFetch } from './helpers';

const setup = (...h: Parameters<typeof makeFetch>) => {
  const f = makeFetch(...h);
  const api = createApiClient({ baseUrl: () => 'https://vault.example.com', fetch: f.fetch });
  const core = new FakeVaultCore({
    lockState: 'unlocked',
    masterPassword: 'correct horse battery',
  });
  return { ...f, api, core, store: createMemoryFlagStore() };
};
const ok = () => json(204, undefined);

describe('settings', () => {
  it('patches settings and reads them back', async () => {
    const { core } = setup();
    expect(
      (await patchSettings(core, { autoLockSec: 300, clipboardClearSec: null })).autoLockSec,
    ).toBe(300);
    expect((await core.getSettings()).clipboardClearSec).toBeNull();
  });
  it('reads biometricsEnabled from settings and handles the invalidated re-setup path (FR-13)', async () => {
    const { core } = setup();
    expect((await core.getSettings()).biometricsEnabled).toBe(false);
    expect(await setBiometrics(core, true)).toEqual({ ok: true });
    expect((await core.getSettings()).biometricsEnabled).toBe(true);
    await core.updateSettings({ biometricsEnabled: false });
    expect((await core.getSettings()).biometricsEnabled).toBe(true); // read-only via updateSettings
    expect(await setBiometrics(core, false)).toEqual({ ok: true });
    expect((await core.getSettings()).biometricsEnabled).toBe(false);
    core.enableBiometrics = async () => {
      throw new VaultCoreError('E_BIOMETRY_INVALIDATED');
    };
    expect(await setBiometrics(core, true)).toEqual({ ok: false, reason: 'invalidated' });
    const fresh = new FakeVaultCore({ lockState: 'unlocked' });
    expect(await reenrollBiometrics(fresh)).toEqual({ ok: true });
    expect((await fresh.getSettings()).biometricsEnabled).toBe(true);
  });
});

describe('error text', () => {
  it('maps actions, ignores cancel, flags retry and clock skew', () => {
    expect(describeActionError(new VaultCoreError('E_AUTH_CANCELED'))).toBeNull();
    expect(describeActionError(new VaultCoreError('E_WRONG_PASSWORD'))).toContain(
      'マスターパスワード',
    );
    expect(
      describeActionError(new VaultCoreError('E_THROTTLED', 'x', { retryAfterSec: 90 })),
    ).toContain('01:30');
    expect(
      describeActionError(
        new ApiError('E_CLOCK_SKEW', 'x', { serverTime: '2026-01-01T00:00:00Z' }),
      ),
    ).toContain('時刻');
    expect(isClockSkew(new ApiError('E_CLOCK_SKEW'))).toBe(true);
    expect(isRetryable(new ApiError('E_INTERNAL'))).toBe(true);
    expect(isRetryable(new NetworkError('timeout'))).toBe(true);
    expect(isRetryable(new ApiError('E_FORBIDDEN'))).toBe(false);
  });
  it('never echoes the error message', () => {
    expect(describeActionError(new Error('secret-password-123'))).not.toContain('secret');
  });
});

describe('account flows', () => {
  it('changes the master password, confirming only after the server accepted', async () => {
    const s = setup(ok);
    await changeMasterPasswordFlow(s, 'correct horse battery', 'new password long');
    expect(s.calls[0]?.url).toContain('/v1/keyset');
    const bad = setup(() => apiError(409, 'E_VERSION_CONFLICT'));
    let confirmed = 0;
    bad.core.confirmKeysetAccepted = async () => void confirmed++;
    await expect(
      changeMasterPasswordFlow(bad, 'correct horse battery', 'x'),
    ).rejects.toBeInstanceOf(ApiError);
    expect(confirmed).toBe(0);
    await expect(changeMasterPasswordFlow(s, 'wrong', 'x')).rejects.toMatchObject({
      code: 'E_WRONG_PASSWORD',
    });
  });
  it('regenerates the recovery key', async () => {
    const s = setup(ok);
    expect(await regenerateRecoveryKeyFlow(s, 'correct horse battery')).toMatch(/^LV2-/);
  });
  it('matches the account name loosely but exactly', () => {
    expect(accountNameMatches(' Alice ', 'alice')).toBe(true);
    expect(accountNameMatches('alic', 'alice')).toBe(false);
  });
  it('deletes the account then wipes', async () => {
    const s = setup(ok);
    await deleteAccountFlow(s, 'pw');
    expect(s.calls[0]?.method).toBe('DELETE');
    expect(s.core.wiped).toBe(1);
    expect(await s.core.getLockState()).toBe('uninitialized');
  });
  it('keeps the data when the delete request fails', async () => {
    const s = setup(() => apiError(500, 'E_INTERNAL'));
    await expect(deleteAccountFlow(s, 'pw')).rejects.toBeInstanceOf(ApiError);
    expect(s.core.wiped).toBe(0);
  });
  it('signs out, tolerating an already revoked device', async () => {
    const s = setup(ok);
    await signOutFlow(s);
    expect(s.core.wiped).toBe(1);
    const revoked = setup(() => apiError(401, 'E_DEVICE_REVOKED'));
    await signOutFlow(revoked);
    expect(revoked.core.wiped).toBe(1);
    const failing = setup(() => apiError(500, 'E_INTERNAL'));
    await expect(signOutFlow(failing)).rejects.toBeInstanceOf(ApiError);
    expect(failing.core.wiped).toBe(0);
  });
});

describe('recovery code', () => {
  it('issues, flags the sheet unconfirmed, then confirms by the last 6 characters', async () => {
    const s = setup(ok);
    const sheet = await issueRecoveryCodeFlow(s, s.store, 172800);
    expect(await s.store.get(FLAGS.rcSheetUnconfirmed)).toBe(true);
    expect(sheetTail(sheet.text)).toBe('TVWXYZ'.slice(-6));
    expect(tailMatches(sheet.text, 'tvwxy')).toBe(false);
    expect(tailMatches(sheet.text, 'tv-wxyz')).toBe(true);
    expect(tailMatches(sheet.text, 'AAAAAA')).toBe(false);
    await confirmSheetFlow(s.store);
    expect(await s.store.get(FLAGS.rcSheetUnconfirmed)).toBeNull();
  });
  it('does not flag or hand out a sheet when the server refuses', async () => {
    const s = setup(() => apiError(409, 'E_STALE_KEY'));
    await expect(issueRecoveryCodeFlow(s, s.store, 86400)).rejects.toBeInstanceOf(ApiError);
    expect(await s.store.get(FLAGS.rcSheetUnconfirmed)).toBeNull();
  });
  it('reads status and disables', async () => {
    const s = setup((c) =>
      c.method === 'GET'
        ? json(200, {
            enabled: true,
            createdAt: '2026-11-01T00:00:00Z',
            waitSec: 259200,
            frozen: true,
          })
        : ok(),
    );
    expect(await getRcStatus(s.api)).toMatchObject({
      enabled: true,
      frozen: true,
      waitSec: 259200,
    });
    await s.store.set(FLAGS.rcSheetUnconfirmed, true);
    await disableRecoveryCodeFlow(s, s.store);
    expect(await s.store.get(FLAGS.rcSheetUnconfirmed)).toBeNull();
  });
});

describe('backup', () => {
  it('validates the export password', () => {
    expect(exportPasswordProblem('short', 'short')).toBe('short');
    expect(exportPasswordProblem('long enough pw', 'long enough px')).toBe('mismatch');
    expect(exportPasswordProblem('long enough pw', 'long enough pw')).toBeNull();
  });
  it('deletes the export file even when sharing fails', async () => {
    const { core } = setup();
    await expect(
      exportFlow(core, 'export-password', async () => {
        throw new Error('share failed');
      }),
    ).rejects.toThrow();
    expect(w4b(core).exportDeleted).toEqual(['file:///tmp/fake.lvbackup']);
    expect((await core.getBackupInfo()).lastExportAt).not.toBeNull();
  });
  it('imports with a preview and requests a sync', async () => {
    const core: VaultCore = setup().core;
    expect(await core.inspectImport('f', 'export-password')).toEqual({
      itemCount: 12,
      conflictCount: 3,
    });
    await expect(core.inspectImport('f', 'wrong')).rejects.toMatchObject({
      code: 'E_IMPORT_FORMAT',
    });
    let synced = 0;
    expect(
      await runImport(core, 'f', 'export-password', 'newer', async () => void synced++),
    ).toEqual({ added: 9, updated: 3 });
    expect(synced).toBe(1);
  });
  it('csv import honours skipDuplicates', async () => {
    const { core } = setup();
    expect(await runCsvImport(core, 'f', true)).toEqual({ added: 8, skipped: 1 });
    expect(await runCsvImport(core, 'f', false)).toEqual({ added: 10, skipped: 1 });
  });
});

describe('security log', () => {
  it('labels every kind and resolves device names', async () => {
    for (const k of AUDIT_EVENT_KINDS) expect(KIND_LABEL[k]).toBeDefined();
    expect(severity('rc_frozen')).toBe('warning');
    const d = fakeId();
    const s = setup((c) => {
      const u = new URL(c.url);
      return u.searchParams.get('before') === null
        ? json(200, {
            events: [
              { id: 9, kind: 'device_added', deviceId: d, createdAt: '2026-11-01T00:00:00Z' },
              { id: 8, kind: 'rotated', deviceId: null, createdAt: '2026-10-01T00:00:00Z' },
            ],
            hasMore: true,
          })
        : json(200, { events: [], hasMore: false });
    });
    const page = await loadAuditPage(s.api);
    expect(page).toMatchObject({ hasMore: true, nextBefore: 8 });
    expect(s.calls[0]?.url).toContain('limit=50');
    await loadAuditPage(s.api, 8);
    expect(s.calls[1]?.url).toContain('before=8');
    w4b(s.core).devices = [
      {
        deviceId: d,
        name: 'Büro',
        type: 'extension',
        platform: 'chrome',
        addedAt: '',
        addedVia: 'pairing',
        revokedAt: null,
        isThisDevice: false,
      },
    ];
    expect((await deviceNameMap(s.core)).get(d)).toBe('Büro');
  });
  it('formats times in Japanese', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    expect(relativeTime('2026-11-12T11:55:00Z', now)).toBe('5分前');
    expect(relativeTime('2026-11-12T09:00:00Z', now)).toBe('3時間前');
    expect(formatSpan(2 * 86400 + 4 * 3600)).toBe('2日4時間');
  });
});

describe('server change (G14)', () => {
  const accountId = fakeId();
  const handler = (id: string) => (c: { url: string; method: string }) => {
    if (c.url.includes('/v1/prelogin')) return json(200, { accountId: id, kdf: fakeKeyset().kdf });
    if (c.url.endsWith('/auth/challenge'))
      return json(200, { challenge: fakeB64(32), expiresAt: '2030-01-01T00:00:00Z' });
    if (c.url.endsWith('/auth/token'))
      return json(200, { accessToken: 'a.b.c', expiresAt: '2030-01-01T00:00:00Z' });
    return undefined;
  };
  it('switches only when the account matches and device login works', async () => {
    const s = setup(handler(accountId));
    s.core.getAccountInfo = async () => ({
      accountId,
      accountName: 'alice',
      serverUrl: 'https://old.example.com',
      deviceId: fakeId(),
    });
    let changed: string | null = null;
    (s.core as VaultCore).changeServerUrl = async (u: string) => {
      changed = u;
    };
    const makeApi = (o: string) => createApiClient({ baseUrl: () => o, fetch: s.fetch });
    expect(
      await changeServerFlow({
        core: s.core,
        makeApi,
        fetchImpl: s.fetch,
        input: 'new.example.com',
      }),
    ).toBe('https://new.example.com');
    expect(changed).toBe('https://new.example.com');
  });
  it('rejects a different account, the same URL and a bad URL', async () => {
    const s = setup(handler(fakeId()));
    s.core.getAccountInfo = async () => ({
      accountId,
      accountName: 'alice',
      serverUrl: 'https://old.example.com',
      deviceId: fakeId(),
    });
    let changed = false;
    s.core.changeServerUrl = async () => {
      changed = true;
    };
    const makeApi = (o: string) => createApiClient({ baseUrl: () => o, fetch: s.fetch });
    const run = (input: string) =>
      changeServerFlow({ core: s.core, makeApi, fetchImpl: s.fetch, input });
    await expect(run('new.example.com')).rejects.toMatchObject({ reason: 'otherAccount' });
    await expect(run('https://old.example.com')).rejects.toMatchObject({ reason: 'sameUrl' });
    await expect(run('http://insecure.example.com')).rejects.toBeInstanceOf(ServerChangeError);
    expect(changed).toBe(false);
  });
});
