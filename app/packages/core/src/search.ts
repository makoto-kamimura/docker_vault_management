// List search — FR-22: case-insensitive, full-width / half-width insensitive partial match.

/** NFKC folds full-width forms to half-width; then lower-case. */
export function normalizeForSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/**
 * Every whitespace-separated token of `query` must appear in at least one haystack (title,
 * username, hosts, ...). An empty query matches everything.
 */
export function matchesQuery(query: string, haystacks: readonly string[]): boolean {
  const tokens = normalizeForSearch(query)
    .split(/\s+/)
    .filter((t) => t !== '');
  if (tokens.length === 0) return true;
  const normalized = haystacks.map(normalizeForSearch);
  return tokens.every((t) => normalized.some((h) => h.includes(t)));
}
