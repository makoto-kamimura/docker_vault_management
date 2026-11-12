import { VaultCoreError } from '@localvault/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/api';
import { FakeVaultCore, fakeKeyset } from '../src/native/fake/FakeVaultCore';
import { backoffDelayMs, createSyncEngine, syncOnce } from '../src/sync/engine';
import type { SyncStatus } from '../src/sync/types';
import { apiError, json, makeFetch, record } from './helpers';

const base = () => 'https://vault.example.com';

function page(over: Record<string, unknown> = {}) {
  return { records: [], cursor: 0, hasMore: false, fullResync: false, ...over };
}

function setup(handlers: Parameters<typeof makeFetch>) {
  const f = makeFetch(...handlers);
  const api = createApiClient({ baseUrl: base, fetch: f.fetch });
  const core = new FakeVaultCore({ lockState: 'unlocked' });
  return { ...f, api, core };
}

const records = (c: { url: string }) => c.url.includes('/v1/records?');

describe('syncOnce', () => {
  it('pushes pending changes in batches then pulls', async () => {
    const change = {
      id: record().id,
      baseRev: 0,
      deleted: false as const,
      vkVersion: 1,
      nonce: record().nonce,
      ct: record().ct,
    };
    const { api, core, calls } = setup([
      (c) =>
        c.url.endsWith('/v1/records/batch')
          ? json(200, {
              results: [
                {
                  id: (c.body as { changes: { id: string }[] }).changes[0]?.id,
                  status: 'ok',
                  rev: 1,
                },
              ],
            })
          : undefined,
      (c) => (records(c) ? json(200, page({ cursor: 1 })) : undefined),
    ]);
    core.pendingChanges = [change];
    const r = await syncOnce({ core, api });
    expect(r.needsMasterPassword).toBe(false);
    expect(core.pushedResults).toHaveLength(1);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /v1/records/batch',
      'GET /v1/records',
    ]);
    expect(core.syncCursor).toBe(1);
  });

  it('pages through hasMore and passes keyset and cursor', async () => {
    const ks = fakeKeyset();
    const { api, core, calls } = setup([
      (c) => {
        if (!records(c)) return undefined;
        const since = Number(new URL(c.url).searchParams.get('since'));
        return since === 0
          ? json(
              200,
              page({ records: [record(undefined, 1)], cursor: 5, hasMore: true, keyset: ks }),
            )
          : json(200, page({ records: [record(undefined, 6)], cursor: 9 }));
      },
    ]);
    await syncOnce({ core, api });
    expect(calls.map((c) => new URL(c.url).searchParams.get('since'))).toEqual(['0', '5']);
    expect(core.pulled.map((p) => p.cursor)).toEqual([5, 9]);
    expect(core.pulled[0]?.keyset).toEqual(ks);
    expect(core.pulled.every((p) => !p.fullResync)).toBe(true);
  });

  it('restarts from since=0 on fullResync and ignores it on later pages (W2)', async () => {
    const sinces: string[] = [];
    const { api, core } = setup([
      (c) => {
        if (!records(c)) return undefined;
        const since = new URL(c.url).searchParams.get('since') as string;
        sinces.push(since);
        if (since === '7') return json(200, page({ cursor: 12, fullResync: true, hasMore: true }));
        if (since === '0')
          return json(
            200,
            page({ records: [record()], cursor: 3, hasMore: true, fullResync: true }),
          );
        return json(200, page({ records: [record()], cursor: 12, fullResync: true })); // flag repeated: must NOT restart again
      },
    ]);
    core.syncCursor = 7;
    await syncOnce({ core, api });
    expect(sinces).toEqual(['7', '0', '3']);
    expect(core.pulled.map((p) => p.cursor)).toEqual([3, 12]);
    expect(core.pulled.every((p) => p.fullResync)).toBe(true);
  });

  it('reports needsMasterPassword', async () => {
    const { api, core } = setup([(c) => (records(c) ? json(200, page({ cursor: 2 })) : undefined)]);
    core.applyPulledImpl = async () => ({ conflicts: 0, needsMasterPassword: true });
    await expect(syncOnce({ core, api })).resolves.toEqual({ needsMasterPassword: true });
  });

  it('pulls then retries the push once on E_STALE_KEY', async () => {
    let batchCalls = 0;
    const change = {
      id: record().id,
      baseRev: 0,
      deleted: false as const,
      vkVersion: 1,
      nonce: record().nonce,
      ct: record().ct,
    };
    const { api, core, calls } = setup([
      (c) => {
        if (!c.url.endsWith('/v1/records/batch')) return undefined;
        batchCalls++;
        return batchCalls === 1
          ? apiError(409, 'E_STALE_KEY')
          : json(200, { results: [{ id: change.id, status: 'ok', rev: 2 }] });
      },
      (c) => (records(c) ? json(200, page({ cursor: 1 })) : undefined),
    ]);
    core.pendingChanges = [change];
    await syncOnce({ core, api });
    expect(batchCalls).toBe(2);
    expect(calls.filter(records).length).toBe(2);
  });
});

describe('sync engine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function engineSetup(handler: Parameters<typeof makeFetch>[0]) {
    const s = setup([handler]);
    const statuses: SyncStatus[] = [];
    const hooks = { revoked: 0, deleted: 0 };
    const engine = createSyncEngine({
      core: s.core,
      api: s.api,
      report: (x) => statuses.push(x),
      onDeviceRevoked: () => void hooks.revoked++,
      onAccountDeleted: () => void hooks.deleted++,
    });
    return {
      ...s,
      engine,
      statuses,
      hooks,
      last: () => statuses[statuses.length - 1] as SyncStatus,
    };
  }

  const ok = (c: { url: string }) => (records(c) ? json(200, page()) : undefined);

  it('goes syncing -> synced and records the time', async () => {
    const e = engineSetup(ok);
    await e.engine.requestSync('launch');
    expect(e.statuses.map((x) => x.kind)).toEqual(['syncing', 'synced']);
    expect(e.last().lastSyncedAt).not.toBeNull();
  });

  it('coalesces saves for one second', async () => {
    const e = engineSetup(ok);
    e.engine.notifySyncNeeded();
    await vi.advanceTimersByTimeAsync(500);
    e.engine.notifySyncNeeded();
    await vi.advanceTimersByTimeAsync(900);
    expect(e.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(e.calls).toHaveLength(1);
  });

  it('runs every 5 minutes in the foreground and stops in the background', async () => {
    const e = engineSetup(ok);
    e.engine.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(e.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(e.calls).toHaveLength(2);
    e.engine.setForeground(false);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(e.calls).toHaveLength(2);
    e.engine.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(e.calls).toHaveLength(3);
    e.engine.stop();
  });

  it('backs off 5 s, 10 s, 20 s ... capped at 5 min, shows offline', async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffDelayMs)).toEqual([
      5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000,
    ]);
    let fail = true;
    const e = engineSetup((c) => {
      if (!records(c)) return undefined;
      if (fail) throw new TypeError('offline');
      return json(200, page());
    });
    await e.engine.requestSync('launch');
    expect(e.last()).toMatchObject({ kind: 'offline', retryInMs: 5000 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(e.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(e.calls).toHaveLength(2);
    expect(e.last()).toMatchObject({ kind: 'offline', retryInMs: 10000 });
    fail = false;
    await vi.advanceTimersByTimeAsync(10000);
    expect(e.last().kind).toBe('synced');
    expect(e.last().retryInMs).toBeUndefined();
  });

  it('treats E_INTERNAL as a retryable error', async () => {
    let n = 0;
    const e = engineSetup((c) =>
      records(c) ? (n++ === 0 ? apiError(500, 'E_INTERNAL') : json(200, page())) : undefined,
    );
    await e.engine.requestSync('launch');
    expect(e.last()).toMatchObject({ kind: 'error', errorKind: 'server' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(e.last().kind).toBe('synced');
  });

  it('flags E_CLOCK_SKEW and keeps retrying', async () => {
    const e = engineSetup((c) =>
      records(c)
        ? apiError(400, 'E_CLOCK_SKEW', { serverTime: '2026-11-12T00:00:00.000Z' })
        : undefined,
    );
    await e.engine.requestSync('launch');
    expect(e.last()).toMatchObject({ kind: 'error', errorKind: 'clockSkew' });
    expect(e.last().retryInMs).toBe(5000);
  });

  it('stops on E_DEVICE_REVOKED and calls the hook once', async () => {
    const e = engineSetup((c) => (records(c) ? apiError(401, 'E_DEVICE_REVOKED') : undefined));
    await e.engine.requestSync('launch');
    expect(e.hooks.revoked).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await e.engine.requestSync('manual');
    expect(e.calls).toHaveLength(1);
  });

  it('stops on E_ACCOUNT_DELETED', async () => {
    const e = engineSetup((c) => (records(c) ? apiError(410, 'E_ACCOUNT_DELETED') : undefined));
    await e.engine.requestSync('launch');
    expect(e.hooks.deleted).toBe(1);
    await e.engine.requestSync('manual');
    expect(e.calls).toHaveLength(1);
  });

  it('halts with the rollback state on E_ROLLBACK_DETECTED until the user accepts', async () => {
    const e = engineSetup(ok);
    e.core.applyPulledImpl = async () => {
      throw new VaultCoreError('E_ROLLBACK_DETECTED');
    };
    await e.engine.requestSync('launch');
    expect(e.last().kind).toBe('rollback');
    await e.engine.requestSync('manual');
    expect(e.calls).toHaveLength(1);
    e.core.applyPulledImpl = null;
    await e.engine.acceptRollback();
    expect(e.core.accepted).toBe(1);
    expect(e.last().kind).toBe('synced');
  });

  it('stays quiet on E_LOCKED and surfaces the master-password need', async () => {
    const e = engineSetup(ok);
    e.core.applyPulledImpl = async () => {
      throw new VaultCoreError('E_LOCKED');
    };
    await e.engine.requestSync('launch');
    expect(e.last().kind).toBe('synced');
    expect(e.last().retryInMs).toBeUndefined();

    e.core.applyPulledImpl = async () => ({ conflicts: 0, needsMasterPassword: true });
    await e.engine.requestSync('manual');
    expect(e.last()).toMatchObject({ kind: 'synced', needsMasterPassword: true });
  });

  it('honours Retry-After for rate limiting', async () => {
    const e = engineSetup((c) =>
      records(c) ? apiError(429, 'E_RATE_LIMITED', { retryAfterSec: 60 }) : undefined,
    );
    await e.engine.requestSync('launch');
    expect(e.last()).toMatchObject({ kind: 'error', errorKind: 'rateLimited', retryInMs: 60000 });
  });
});
