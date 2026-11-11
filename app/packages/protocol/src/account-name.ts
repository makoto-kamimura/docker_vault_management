import { FIELD } from './limits';

const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export type AccountNameResult =
  | { ok: true; name: string }
  | { ok: false; reason: AccountNameError };
export type AccountNameError = 'too_short' | 'too_long' | 'bad_chars' | 'bad_edge';

/** Strict check (FR-02): 3-32 chars of [a-z0-9._-], must start and end with [a-z0-9]. */
export function validateAccountName(name: string): AccountNameResult {
  if (name.length < FIELD.accountNameMin) return { ok: false, reason: 'too_short' };
  if (name.length > FIELD.accountNameMax) return { ok: false, reason: 'too_long' };
  if (!/^[a-z0-9._-]+$/.test(name)) return { ok: false, reason: 'bad_chars' };
  if (!NAME_RE.test(name)) return { ok: false, reason: 'bad_edge' };
  return { ok: true, name };
}

/**
 * Normalise user input (NFKC, lower-case; whitespace is NOT trimmed) and validate.
 * Used for login / prelogin lookups and when creating accounts, so "Alice" and "alice" are the same.
 */
export function normalizeAccountName(input: string): AccountNameResult {
  return validateAccountName(input.normalize('NFKC').toLowerCase());
}

export function isValidAccountName(name: string): boolean {
  return validateAccountName(name).ok;
}
