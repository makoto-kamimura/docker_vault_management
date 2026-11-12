// Pure list logic (no React Native imports): search, sort, sections, notices, trash arithmetic.
import { type ItemSummary, matchesQuery, type VaultNotice } from '@localvault/core';
import { TTL_SEC } from '@localvault/protocol';
import { t } from '../../i18n';

export type SortMode = 'recent' | 'name';

export type ListSection = { key: 'favorites' | 'all'; items: ItemSummary[] };

const collator = new Intl.Collator('ja');

export function sortItems(items: readonly ItemSummary[], mode: SortMode): ItemSummary[] {
  const out = [...items];
  if (mode === 'name') {
    out.sort((a, b) => collator.compare(a.title, b.title) || a.id.localeCompare(b.id));
  } else {
    const stamp = (i: ItemSummary) => i.lastUsedAt ?? i.updatedAt;
    out.sort((a, b) => stamp(b).localeCompare(stamp(a)) || a.id.localeCompare(b.id));
  }
  return out;
}

/** FR-22 search on title / username / hosts, then 「お気に入り」 first. Trashed items never appear. */
export function buildSections(
  items: readonly ItemSummary[],
  opts: { query: string; sort: SortMode },
): ListSection[] {
  const visible = items.filter(
    (i) => i.trashedAt === null && matchesQuery(opts.query, [i.title, i.username, ...i.hosts]),
  );
  const sorted = sortItems(visible, opts.sort);
  const favorites = sorted.filter((i) => i.favorite);
  const rest = sorted.filter((i) => !i.favorite);
  const out: ListSection[] = [];
  if (favorites.length > 0) out.push({ key: 'favorites', items: favorites });
  if (rest.length > 0) out.push({ key: 'all', items: rest });
  return out;
}

export type FlatRow =
  | { type: 'header'; key: string; section: ListSection['key'] }
  | { type: 'item'; key: string; item: ItemSummary };

/** Flattens sections for FlashList. A single unnamed section needs no header unless favourites exist. */
export function flattenSections(sections: readonly ListSection[]): FlatRow[] {
  const showHeaders = sections.length > 1 || sections[0]?.key === 'favorites';
  const rows: FlatRow[] = [];
  for (const s of sections) {
    if (showHeaders) rows.push({ type: 'header', key: `h-${s.key}`, section: s.key });
    for (const item of s.items) rows.push({ type: 'item', key: item.id, item });
  }
  return rows;
}

/** FR-34: after copying the username the password button is highlighted for 10 s. */
export const HIGHLIGHT_MS = 10_000;

export function isHighlighted(
  hl: { id: string; until: number } | null,
  id: string,
  now: number,
): boolean {
  return hl !== null && hl.id === id && now < hl.until;
}

export function noticeMessage(n: VaultNotice): string {
  switch (n.kind) {
    case 'server-edit-won':
      return t('items.notice.serverEditWon');
    case 'restored-as-new':
      return t('items.notice.restoredAsNew');
    case 'dropped-local-edits':
      return t('items.notice.droppedLocal', { count: n.count });
  }
}

export function copiedMessage(clearsAt: string | null, now: number): string {
  if (clearsAt === null) return t('items.copiedNoClear');
  const sec = Math.max(1, Math.round((Date.parse(clearsAt) - now) / 1000));
  return t('items.copied', { sec });
}

/** Whole days left before the 30-day trash expiry (0 = expires today). */
export function trashDaysLeft(trashedAt: string, now: number): number {
  const expires = Date.parse(trashedAt) + TTL_SEC.trash * 1000;
  return Math.max(0, Math.ceil((expires - now) / 86_400_000));
}

export function trashLabel(trashedAt: string, now: number): string {
  const days = trashDaysLeft(trashedAt, now);
  return days === 0 ? t('trash.today') : t('trash.daysLeft', { days });
}

/** FR-26: only http(s) links are opened; a bare host gets https://. */
export function toOpenableUrl(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
