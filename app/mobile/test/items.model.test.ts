import type { ItemSummary, VaultNotice } from '@localvault/core';
import { describe, expect, it } from 'vitest';
import { canDisable, clampLength } from '../src/features/generator/options';
import { formSchema, toItemInput, validateForm } from '../src/features/items/formSchema';
import {
  buildSections,
  copiedMessage,
  flattenSections,
  isHighlighted,
  noticeMessage,
  sortItems,
  toOpenableUrl,
  trashDaysLeft,
  trashLabel,
} from '../src/features/items/model';
import { trashedOnly } from '../src/features/trash/model';

const item = (over: Partial<ItemSummary> & { id: string; title: string }): ItemSummary => ({
  username: '',
  hosts: [],
  favorite: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: null,
  isConflictCopy: false,
  trashedAt: null,
  ...over,
});

describe('list model', () => {
  const items = [
    item({ id: 'a', title: 'GitHub', username: 'alice', hosts: ['github.com'], favorite: true }),
    item({ id: 'b', title: 'みずほ', updatedAt: '2026-03-01T00:00:00.000Z' }),
    item({ id: 'c', title: 'Netflix', lastUsedAt: '2026-05-01T00:00:00.000Z' }),
    item({ id: 'd', title: 'trashed', trashedAt: '2026-04-01T00:00:00.000Z' }),
  ];

  it('puts favourites first and hides trashed items', () => {
    const s = buildSections(items, { query: '', sort: 'recent' });
    expect(s.map((x) => x.key)).toEqual(['favorites', 'all']);
    expect(s[0]?.items.map((i) => i.id)).toEqual(['a']);
    expect(s[1]?.items.map((i) => i.id)).toEqual(['c', 'b']); // lastUsedAt, then updatedAt
  });

  it('sorts by name', () => {
    expect(sortItems(items.slice(0, 3), 'name').map((i) => i.title)[0]).toBe('GitHub');
  });

  it('searches with FR-22 normalisation (full-width, case) across title, username and hosts', () => {
    expect(buildSections(items, { query: 'ＧＩＴｈｕｂ', sort: 'name' })[0]?.items[0]?.id).toBe(
      'a',
    );
    expect(buildSections(items, { query: 'ALICE', sort: 'name' })).toHaveLength(1);
    expect(buildSections(items, { query: 'github.com', sort: 'name' })).toHaveLength(1);
    expect(buildSections(items, { query: 'zzz', sort: 'name' })).toEqual([]);
  });

  it('flattens with headers only when needed', () => {
    const noFav = buildSections(items.slice(1, 3), { query: '', sort: 'name' });
    expect(flattenSections(noFav).every((r) => r.type === 'item')).toBe(true);
    const withFav = flattenSections(buildSections(items, { query: '', sort: 'name' }));
    expect(withFav.filter((r) => r.type === 'header')).toHaveLength(2);
  });

  it('highlights the password button only for the copied item within 10 s', () => {
    const hl = { id: 'a', until: 10_000 };
    expect(isHighlighted(hl, 'a', 9_999)).toBe(true);
    expect(isHighlighted(hl, 'a', 10_000)).toBe(false);
    expect(isHighlighted(hl, 'b', 0)).toBe(false);
    expect(isHighlighted(null, 'a', 0)).toBe(false);
  });
});

describe('notices, copy toast, trash, export reminder', () => {
  it('maps every notice kind to a message', () => {
    const ns: VaultNotice[] = [
      { kind: 'server-edit-won', id: 'x' },
      { kind: 'restored-as-new', id: 'x', originalId: 'y' },
      { kind: 'dropped-local-edits', count: 3 },
    ];
    const msgs = ns.map(noticeMessage);
    expect(new Set(msgs).size).toBe(3);
    expect(msgs[2]).toContain('3');
  });

  it('copy toast shows the remaining seconds, or none when never cleared', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(copiedMessage('2026-01-01T00:01:00Z', now)).toBe('コピーしました（60 秒後に消去）');
    expect(copiedMessage(null, now)).toBe('コピーしました');
  });

  it('counts the 30-day trash window', () => {
    const t0 = '2026-01-01T00:00:00Z';
    const day = 86_400_000;
    expect(trashDaysLeft(t0, Date.parse(t0))).toBe(30);
    expect(trashDaysLeft(t0, Date.parse(t0) + 29.5 * day)).toBe(1);
    expect(trashDaysLeft(t0, Date.parse(t0) + 40 * day)).toBe(0);
    expect(trashLabel(t0, Date.parse(t0) + 40 * day)).toBe('今日まで');
    expect(trashLabel(t0, Date.parse(t0))).toBe('あと 30 日');
  });

  it('orders trashed items oldest first', () => {
    const r = trashedOnly([
      item({ id: '1', title: 'a', trashedAt: '2026-02-01T00:00:00Z' }),
      item({ id: '2', title: 'b', trashedAt: '2026-01-01T00:00:00Z' }),
      item({ id: '3', title: 'c' }),
    ]);
    expect(r.map((i) => i.id)).toEqual(['2', '1']);
  });

  it('opens only http(s) URLs', () => {
    expect(toOpenableUrl('example.com/login')).toBe('https://example.com/login');
    expect(toOpenableUrl('javascript:alert(1)')).toBeNull();
    expect(toOpenableUrl('  ')).toBeNull();
    expect(toOpenableUrl('http://localhost:8787')).toBe('http://localhost:8787/');
  });
});

describe('item form', () => {
  const base = { title: 'x', username: '', password: '', urls: [], notes: '', favorite: false };
  it('requires a title and enforces protocol limits', () => {
    expect(formSchema.safeParse({ ...base, title: '  ' }).success).toBe(false);
    expect(formSchema.safeParse({ ...base, title: 'a'.repeat(101) }).success).toBe(false);
    expect(formSchema.safeParse({ ...base, password: 'a'.repeat(1025) }).success).toBe(false);
    expect(formSchema.safeParse({ ...base, notes: 'a'.repeat(10_001) }).success).toBe(false);
    const urls = Array.from({ length: 21 }, () => ({ url: 'a.com', match: 'domain' as const }));
    expect(formSchema.safeParse({ ...base, urls }).success).toBe(false);
  });
  it('rejects non-http URLs but allows empty rows', () => {
    const bad = validateForm({ ...base, urls: [{ url: 'ftp://x', match: 'host' }] });
    expect(bad.errors['urls.0.url']).toBeDefined();
    expect(validateForm({ ...base, urls: [{ url: '', match: 'host' }] }).errors).toEqual({});
  });
  it('drops empty URLs and omits an empty password (unchanged)', () => {
    const input = toItemInput(
      {
        ...base,
        urls: [
          { url: ' a.com ', match: 'host' },
          { url: '', match: 'domain' },
        ],
      },
      'id1',
    );
    expect(input.urls).toEqual([{ url: 'a.com', match: 'host' }]);
    expect('password' in input).toBe(false);
    expect(input.id).toBe('id1');
    expect(toItemInput({ ...base, password: 'pw' }).password).toBe('pw');
  });
});

describe('generator options', () => {
  const o = {
    length: 20,
    upper: true,
    lower: false,
    digits: false,
    symbols: false,
    excludeAmbiguous: false,
  };
  it('keeps at least one class and clamps length to 8..64', () => {
    expect(canDisable(o, 'upper')).toBe(false);
    expect(canDisable({ ...o, lower: true }, 'upper')).toBe(true);
    expect(clampLength(3)).toBe(8);
    expect(clampLength(99)).toBe(64);
    expect(clampLength(20.4)).toBe(20);
  });
});
