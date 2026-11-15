// Candidate matching — spec §9.1 (also §9.3/§9.4: the caller passes the requesting frame's own URL).
import type { UrlEntry } from '@localvault/protocol';
import { isIpHost, type PublicSuffixList } from './psl';
import { toAsciiHost } from './punycode';

export type ParsedUrl = { scheme: string; host: string };

const URL_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i;

/** Scheme (lower-case) and normalised host of a URL; the port, path and credentials are dropped. */
export function parseUrl(input: string): ParsedUrl | null {
  const m = URL_RE.exec(input.trim());
  if (m === null) return null;
  const scheme = (m[1] as string).toLowerCase();
  let authority = m[2] as string;
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);

  let hostPart: string;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    const port = authority.slice(end + 1);
    if (port !== '' && !/^:\d*$/.test(port)) return null;
    // IPv6 literal: keep as typed (lower-case) in brackets; it only ever matches exactly.
    return { scheme, host: authority.slice(0, end + 1).toLowerCase() };
  }
  const colon = authority.lastIndexOf(':');
  if (colon >= 0) {
    if (!/^\d*$/.test(authority.slice(colon + 1))) return null;
    hostPart = authority.slice(0, colon);
  } else {
    hostPart = authority;
  }
  const host = toAsciiHost(hostPart);
  return host === null ? null : { scheme, host };
}

/** Host of a stored URL entry; a missing scheme is read as https (users type "example.com"). */
export function hostOfStoredUrl(url: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url : `https://${url.trim()}`;
  return parseUrl(withScheme)?.host ?? null;
}

export type MatchRequest = { url: string } | { scheme: string; host: string };

export type MatchEntry = {
  id: string;
  urls: readonly UrlEntry[];
  /** ISO 8601; ties inside one rank are ordered by most recent use. */
  lastUsedAt?: string | null;
  /** Trashed entries never match (§9.1 step 7). */
  trashedAt?: string | null;
};

export type MatchRank = 'host' | 'domain';

export type Candidate = {
  id: string;
  rank: MatchRank;
  /** Index into the entry's `urls` that produced the best match. */
  urlIndex: number;
  /** Normalised host of the request (for labelling iframe forms, §9.4). */
  requestHost: string;
};

function resolveRequest(request: MatchRequest): ParsedUrl | null {
  if ('url' in request) return parseUrl(request.url);
  const host = request.host.startsWith('[')
    ? request.host.toLowerCase()
    : toAsciiHost(request.host);
  return host === null ? null : { scheme: request.scheme.toLowerCase(), host };
}

/**
 * Ranked candidates for a request. Only `https` requests produce candidates (step 2); exact host
 * matches come first, then registrable-domain matches, then most recently used.
 */
export function matchItems(
  psl: PublicSuffixList,
  request: MatchRequest,
  entries: readonly MatchEntry[],
): Candidate[] {
  const req = resolveRequest(request);
  if (req === null || req.scheme !== 'https') return [];
  const reqDomain = isIpHost(req.host) ? null : psl.registrableDomain(req.host);

  const found: { c: Candidate; lastUsed: string; order: number }[] = [];
  entries.forEach((entry, order) => {
    if (entry.trashedAt) return;
    let best: Candidate | null = null;
    entry.urls.forEach((u, urlIndex) => {
      const host = hostOfStoredUrl(u.url);
      if (host === null) return;
      let rank: MatchRank | null = null;
      if (host === req.host) {
        rank = 'host';
      } else if (
        u.match === 'domain' &&
        reqDomain !== null &&
        psl.registrableDomain(host) === reqDomain
      ) {
        rank = 'domain';
      }
      if (rank === null) return;
      if (best === null || (rank === 'host' && best.rank === 'domain')) {
        best = { id: entry.id, rank, urlIndex, requestHost: req.host };
      }
    });
    if (best !== null) found.push({ c: best, lastUsed: entry.lastUsedAt ?? '', order });
  });

  found.sort((a, b) => {
    if (a.c.rank !== b.c.rank) return a.c.rank === 'host' ? -1 : 1;
    if (a.lastUsed !== b.lastUsed) return a.lastUsed < b.lastUsed ? 1 : -1;
    return a.order - b.order;
  });
  return found.map((f) => f.c);
}
