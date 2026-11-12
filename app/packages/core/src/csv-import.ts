// CSV import from other password managers — F1 (FR-54). Pure parsing and mapping; the decision
// what to do with duplicates and the encryption belong to the caller (VaultCore).
import { FIELD, type UrlEntry } from '@localvault/protocol';
import { VaultCoreError } from './errors';
import { hostOfStoredUrl } from './matcher/match';
import type { PublicSuffixList } from './matcher/psl';
import { normalizeForSearch } from './search';

// ---------------------------------------------------------------- RFC 4180 parser

/**
 * Parses CSV text into rows of fields. Handles a leading BOM, CRLF / LF / CR line ends, quoted
 * fields with embedded commas, newlines and doubled quotes. Completely blank lines are dropped.
 * Throws `E_IMPORT_FORMAT` for an unterminated quote or stray characters after a closing quote.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // A blank line parses as a single empty field; skip it.
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text.charAt(i);
    if (c === '"' && field === '') {
      i++;
      for (;;) {
        if (i >= n) throw new VaultCoreError('E_IMPORT_FORMAT', 'unterminated quoted field');
        const q = text.charAt(i);
        if (q === '"') {
          if (text.charAt(i + 1) === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += q;
        i++;
      }
      const after = text.charAt(i);
      if (i < n && after !== ',' && after !== '\n' && after !== '\r') {
        throw new VaultCoreError('E_IMPORT_FORMAT', 'unexpected character after closing quote');
      }
    } else if (c === ',') {
      endField();
      i++;
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && text.charAt(i + 1) === '\n') i++;
      endRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

// ---------------------------------------------------------------- format detection

export type CsvFormat = 'chrome' | 'safari' | 'bitwarden' | '1password';

/**
 * Detection looks at the header row only:
 *  - Bitwarden: has `login_uri` and `login_password`
 *  - Chrome / Edge: `name,url,username,password[,note]`
 *  - Safari / iCloud vs 1Password (both `Title,…,Username,Password,Notes,…`): 1Password writes the
 *    column as `Url`, Safari as `URL`; failing that, 1Password-only columns decide.
 */
export function detectCsvFormat(header: readonly string[]): CsvFormat | null {
  const h = header.map((c) => c.trim());
  const lower = new Set(h.map((c) => c.toLowerCase()));
  const has = (...cols: string[]) => cols.every((c) => lower.has(c));

  if (has('login_uri', 'login_password')) return 'bitwarden';
  if (has('title', 'url', 'username', 'password')) {
    if (h.includes('Url')) return '1password';
    if (h.includes('URL')) return 'safari';
    return lower.has('archived') || lower.has('tags') || lower.has('type') ? '1password' : 'safari';
  }
  if (has('name', 'url', 'username', 'password')) return 'chrome';
  return null;
}

// ---------------------------------------------------------------- mapping

export type CsvLoginDraft = {
  title: string;
  username: string;
  password: string;
  urls: UrlEntry[];
  notes: string;
  favorite: boolean;
};

export type CsvSkipReason = 'no_password' | 'not_login' | 'field_too_long';

export type CsvImportResult = {
  format: CsvFormat;
  drafts: CsvLoginDraft[];
  /** `row` is the 1-based line number counting the header as row 1. */
  skipped: { row: number; reason: CsvSkipReason }[];
};

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

type Columns = {
  [K in 'title' | 'url' | 'username' | 'password' | 'notes' | 'favorite' | 'type']?: number;
};

function columnsFor(format: CsvFormat, header: readonly string[]): Columns {
  const idx = new Map(header.map((c, i) => [c.trim().toLowerCase(), i] as const));
  const pick = (...names: string[]) => {
    for (const nm of names) {
      const i = idx.get(nm);
      if (i !== undefined) return i;
    }
    return undefined;
  };
  switch (format) {
    case 'chrome':
      return {
        title: pick('name'),
        url: pick('url'),
        username: pick('username'),
        password: pick('password'),
        notes: pick('note', 'notes'),
      };
    case 'bitwarden':
      return {
        title: pick('name'),
        url: pick('login_uri'),
        username: pick('login_username'),
        password: pick('login_password'),
        notes: pick('notes'),
        favorite: pick('favorite'),
        type: pick('type'),
      };
    case 'safari':
      return {
        title: pick('title'),
        url: pick('url'),
        username: pick('username'),
        password: pick('password'),
        notes: pick('notes'),
      };
    case '1password':
      return {
        title: pick('title'),
        url: pick('url'),
        username: pick('username'),
        password: pick('password'),
        notes: pick('notes'),
        favorite: pick('favorite'),
        type: pick('type'),
      };
  }
}

function toUrlEntries(raw: string): UrlEntry[] {
  const out: UrlEntry[] = [];
  for (const part of raw.split(/\s+/)) {
    if (part === '') continue;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(part) ? part : `https://${part}`;
    if (!/^https?:\/\//i.test(url) || hostOfStoredUrl(url) === null) continue; // android://, otpauth:, junk
    if (out.some((e) => e.url === url)) continue;
    out.push({ url, match: 'domain' });
  }
  return out.slice(0, FIELD.urlsMax);
}

function clipTitle(title: string): string {
  let kept = '';
  for (const ch of title) {
    if (kept.length + ch.length > FIELD.titleMax) break;
    kept += ch;
  }
  return kept;
}

/** Fallback title for rows without a name: the host, else the user name. */
const UNTITLED = '（無題）';

export function parseCsvImport(text: string): CsvImportResult {
  const rows = parseCsv(text);
  const header = rows[0];
  if (header === undefined) throw new VaultCoreError('E_IMPORT_FORMAT', 'empty file');
  const format = detectCsvFormat(header);
  if (format === null) throw new VaultCoreError('E_IMPORT_FORMAT', 'unknown CSV header');
  const cols = columnsFor(format, header);

  const drafts: CsvLoginDraft[] = [];
  const skipped: CsvImportResult['skipped'] = [];
  rows.slice(1).forEach((r, k) => {
    const rowNo = k + 2;
    const get = (i: number | undefined) => (i === undefined ? '' : (r[i] ?? ''));

    // Bitwarden / 1Password exports can contain notes, cards and identities.
    const type = get(cols.type).trim().toLowerCase();
    if (cols.type !== undefined && type !== '' && type !== 'login') {
      skipped.push({ row: rowNo, reason: 'not_login' });
      return;
    }
    const password = get(cols.password);
    if (password === '') {
      skipped.push({ row: rowNo, reason: 'no_password' });
      return;
    }
    const username = get(cols.username);
    const notes = get(cols.notes);
    if (
      password.length > FIELD.passwordMax ||
      username.length > FIELD.usernameMax ||
      notes.length > FIELD.notesMax
    ) {
      skipped.push({ row: rowNo, reason: 'field_too_long' });
      return;
    }
    const urls = toUrlEntries(get(cols.url));
    const host = urls[0] ? hostOfStoredUrl(urls[0].url) : null;
    const title = clipTitle(get(cols.title).trim() || host || username || UNTITLED);
    drafts.push({
      title,
      username,
      password,
      urls,
      notes,
      favorite: TRUE_VALUES.has(get(cols.favorite).trim().toLowerCase()),
    });
  });
  return { format, drafts, skipped };
}

// ---------------------------------------------------------------- duplicates

export type ExistingLogin = { username: string; urls: readonly UrlEntry[] };

function domainKeys(psl: PublicSuffixList, urls: readonly UrlEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const u of urls) {
    const host = hostOfStoredUrl(u.url);
    if (host !== null) keys.add(psl.registrableDomain(host) ?? host);
  }
  return keys;
}

/**
 * Indexes of `drafts` that duplicate an existing login: same registrable domain (or same exact
 * host for IPs / unknown suffixes) and the same user name (NFKC, case-insensitive).
 */
export function findDuplicateDrafts(
  psl: PublicSuffixList,
  drafts: readonly CsvLoginDraft[],
  existing: readonly ExistingLogin[],
): number[] {
  const known = existing.map((e) => ({
    username: normalizeForSearch(e.username),
    domains: domainKeys(psl, e.urls),
  }));
  const result: number[] = [];
  drafts.forEach((d, i) => {
    const username = normalizeForSearch(d.username);
    const domains = domainKeys(psl, d.urls);
    const dup = known.some(
      (k) => k.username === username && [...domains].some((x) => k.domains.has(x)),
    );
    if (dup) result.push(i);
  });
  return result;
}
