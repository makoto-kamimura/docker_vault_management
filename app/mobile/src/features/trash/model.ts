import type { ItemSummary } from '@localvault/core';

/** Trashed items, soonest-to-expire first. */
export function trashedOnly(items: readonly ItemSummary[]): ItemSummary[] {
  return items
    .filter((i) => i.trashedAt !== null)
    .sort((a, b) => (a.trashedAt as string).localeCompare(b.trashedAt as string));
}
