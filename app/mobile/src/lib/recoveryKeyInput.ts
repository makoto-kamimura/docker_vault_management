// Recovery key typing helpers (spec §5.5). Display: LV2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.
// Input: case-insensitive, hyphens/spaces ignored, I/L read as 1, O read as 0.
import { RECOVERY_KEY_REGEX } from '@localvault/protocol';

const BODY_CHARS = 28;
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]$/;

/** Normalised data characters (without the LV2 prefix), at most 28. Invalid characters are dropped. */
export function normalizeRecoveryKeyChars(raw: string): string {
  let s = raw.normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith('LV2')) s = s.slice(3);
  let out = '';
  for (const ch of s) {
    const c = ch === 'I' || ch === 'L' ? '1' : ch === 'O' ? '0' : ch;
    if (CROCKFORD.test(c)) out += c;
    if (out.length === BODY_CHARS) break;
  }
  return out;
}

/** Live-format what the user typed into `LV2-XXXX-...`. Returns '' for empty input. */
export function formatRecoveryKeyInput(raw: string): string {
  const body = normalizeRecoveryKeyChars(raw);
  if (body === '') return '';
  const groups = body.match(/.{1,4}/g) ?? [];
  return `LV2-${groups.join('-')}`;
}

export function isRecoveryKeyComplete(raw: string): boolean {
  return normalizeRecoveryKeyChars(raw).length === BODY_CHARS;
}

/** True only for the canonical display form (as produced by VaultCore). */
export function isCanonicalRecoveryKey(text: string): boolean {
  return RECOVERY_KEY_REGEX.test(text);
}

/** Last N data characters of a canonical key, for the "did you write it down" check (FR-03). */
export function recoveryKeyTail(key: string, n = 4): string {
  return normalizeRecoveryKeyChars(key).slice(-n);
}

/** Compare what the user typed for the tail check. */
export function normalizeTailInput(raw: string): string {
  return raw
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}
