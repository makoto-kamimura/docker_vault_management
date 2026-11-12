import { describe, expect, test } from 'vitest';
import {
  AMBIGUOUS_CHARS,
  attemptsBeforeThrottle,
  conflictCopyTitle,
  DEFAULT_GENERATOR_OPTIONS,
  generatePassword,
  matchesQuery,
  resolveConflict,
  selectedAlphabets,
  throttleState,
  throttleWaitSec,
} from '../src';
import { DEVICE, loginRecord, providers, REC } from './helpers';

const NEW_ID = '55555555-5555-4555-8555-555555555555';
const now = new Date('2026-11-12T10:00:00Z');
const base = { id: REC, now, deviceId: DEVICE, newId: () => NEW_ID };

describe('conflict (7.4)', () => {
  test('identical -> server', () => {
    expect(resolveConflict({ ...base, local: loginRecord(), server: loginRecord() })).toEqual({
      kind: 'use-server',
      notify: false,
    });
  });
  test('both edited -> server + copy', () => {
    const o = resolveConflict({
      ...base,
      local: loginRecord({ password: 'a', title: 'T' }),
      server: loginRecord({ password: 'b', title: 'T' }),
    });
    expect(o.kind).toBe('use-server-and-copy');
    if (o.kind === 'use-server-and-copy') {
      expect(o.copy.id).toBe(NEW_ID);
      expect(o.copy.plain.kind === 'login' && o.copy.plain.data.title).toBe(
        'T（競合コピー 2026-11-12）',
      );
      expect(o.copy.plain.kind === 'login' && o.copy.plain.data.conflictOf).toBe(REC);
    }
  });
  test('server deleted + local edit -> restore as new; local deleted + server edit -> server', () => {
    const a = resolveConflict({ ...base, local: loginRecord(), server: null });
    expect(a).toMatchObject({ kind: 'restore-as-new', notify: true });
    expect(resolveConflict({ ...base, local: null, server: loginRecord() })).toEqual({
      kind: 'use-server',
      notify: true,
    });
    expect(resolveConflict({ ...base, local: null, server: null })).toEqual({
      kind: 'use-server',
      notify: false,
    });
  });
  test('title truncation keeps 100 limit', () => {
    expect(conflictCopyTitle('あ'.repeat(100), now).length).toBeLessThanOrEqual(100);
  });
  const dev = (over: Record<string, unknown>, updatedAt: string) => ({
    kind: 'device' as const,
    data: {
      deviceId: DEVICE,
      name: 'n',
      type: 'extension' as const,
      platform: 'chrome' as const,
      signPub: 'x',
      adminPub: null,
      addedAt: '2026-01-01T00:00:00.000Z',
      addedBy: DEVICE,
      addedVia: 'pairing' as const,
      revokedAt: null,
      ...over,
    },
    updatedAt,
    updatedBy: DEVICE,
  });
  test('device: newer wins, revokedAt sticky', () => {
    const older = '2026-01-01T00:00:00.000Z';
    const newer = '2026-02-01T00:00:00.000Z';
    expect(
      resolveConflict({
        ...base,
        local: dev({ name: 'new' }, newer),
        server: dev({ name: 'old' }, older),
      }),
    ).toMatchObject({ kind: 'push' });
    expect(
      resolveConflict({
        ...base,
        local: dev({ name: 'old' }, older),
        server: dev({ name: 'new' }, newer),
      }),
    ).toEqual({ kind: 'use-server', notify: false });
    // server revoked, local (newer) renamed -> merged push keeps revokedAt
    const r = resolveConflict({
      ...base,
      local: dev({ name: 'renamed' }, newer),
      server: dev({ revokedAt: '2026-01-15T00:00:00.000Z' }, older),
    });
    expect(r.kind === 'push' && r.record.kind === 'device' && r.record.data.revokedAt).toBe(
      '2026-01-15T00:00:00.000Z',
    );
    // local revoked (older), server newer rename -> revocation survives
    const r2 = resolveConflict({
      ...base,
      local: dev({ revokedAt: '2026-01-20T00:00:00.000Z' }, older),
      server: dev({ name: 'srv' }, newer),
    });
    expect(r2.kind === 'push' && r2.record.kind === 'device' && r2.record.data.revokedAt).toBe(
      '2026-01-20T00:00:00.000Z',
    );
  });
  test('meta: newer wins', () => {
    const m = (updatedAt: string) => ({
      kind: 'meta' as const,
      data: {
        recoveryKey: 'LV2-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA',
        pcSessionMaxSec: 3600 as const,
        createdAt: updatedAt,
      },
      updatedAt,
      updatedBy: DEVICE,
    });
    expect(
      resolveConflict({
        ...base,
        local: m('2026-02-01T00:00:00.000Z'),
        server: m('2026-01-01T00:00:00.000Z'),
      }).kind,
    ).toBe('push');
    expect(
      resolveConflict({
        ...base,
        local: m('2026-01-01T00:00:00.000Z'),
        server: m('2026-02-01T00:00:00.000Z'),
      }).kind,
    ).toBe('use-server');
  });
});

describe('throttle (FR-12)', () => {
  test('schedule', () => {
    expect([0, 1, 4].map(throttleWaitSec)).toEqual([0, 0, 0]);
    expect([5, 6, 7, 8, 9, 10, 11, 100].map(throttleWaitSec)).toEqual([
      30, 60, 120, 240, 480, 900, 900, 900,
    ]);
    expect(attemptsBeforeThrottle(2)).toBe(3);
    expect(throttleState({ failedCount: 5, lastFailureAtMs: 1000, nowMs: 11_000 })).toEqual({
      failedCount: 5,
      retryAfterSec: 20,
    });
    expect(
      throttleState({ failedCount: 5, lastFailureAtMs: 1000, nowMs: 99_000 }).retryAfterSec,
    ).toBe(0);
  });
});

describe('search (FR-22)', () => {
  test('normalisation', () => {
    expect(matchesQuery('ＥＸＡＭ', ['My Example'])).toBe(true);
    expect(matchesQuery('example 日本', ['Example', 'ﾆﾎﾝ 日本語'])).toBe(true);
    expect(matchesQuery('zzz', ['Example'])).toBe(false);
    expect(matchesQuery('  ', ['x'])).toBe(true);
  });
});

describe.each(providers)('generator %s', (_n, p) => {
  test('length, class guarantee, ambiguity, errors', async () => {
    for (let i = 0; i < 100; i++) {
      const s = await generatePassword(p, {
        ...DEFAULT_GENERATOR_OPTIONS,
        length: 8 + (i % 57),
        excludeAmbiguous: i % 2 === 0,
      });
      expect(s.length).toBe(8 + (i % 57));
      expect(s).toMatch(/[A-Z]/);
      expect(s).toMatch(/[a-z]/);
      expect(s).toMatch(/[0-9]/);
      expect(s).toMatch(/[^A-Za-z0-9]/);
      if (i % 2 === 0) for (const c of AMBIGUOUS_CHARS) expect(s).not.toContain(c);
    }
    const digits = await generatePassword(p, {
      length: 64,
      upper: false,
      lower: false,
      digits: true,
      symbols: false,
      excludeAmbiguous: false,
    });
    expect(digits).toMatch(/^[0-9]{64}$/);
    await expect(
      generatePassword(p, { ...DEFAULT_GENERATOR_OPTIONS, length: 7 }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    await expect(
      generatePassword(p, {
        length: 20,
        upper: false,
        lower: false,
        digits: false,
        symbols: false,
        excludeAmbiguous: false,
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    expect(
      selectedAlphabets({ ...DEFAULT_GENERATOR_OPTIONS, excludeAmbiguous: true }).join(''),
    ).not.toContain('l');
  });
  test('distribution is roughly uniform', async () => {
    const counts = new Map<string, number>();
    const opts = {
      length: 64,
      upper: false,
      lower: false,
      digits: true,
      symbols: false,
      excludeAmbiguous: false,
    };
    for (let i = 0; i < 100; i++)
      for (const c of await generatePassword(p, opts)) counts.set(c, (counts.get(c) ?? 0) + 1);
    // 6400 samples over 10 digits: expect ~640 each
    for (const d of '0123456789') expect(counts.get(d) ?? 0).toBeGreaterThan(500);
    for (const d of '0123456789') expect(counts.get(d) ?? 0).toBeLessThan(780);
  });
});
