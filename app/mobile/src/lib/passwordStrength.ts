// Lightweight, offline master-password strength estimate (FR-02 meter). Not a security gate:
// the only hard rule is the 10-character minimum.
import { FIELD } from '@localvault/protocol';

export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export type Strength = {
  level: StrengthLevel;
  /** 0..1 */
  ratio: number;
  meetsMinimum: boolean;
};

const COMMON = [
  'password',
  'passw0rd',
  'qwerty',
  '123456',
  '12345678',
  'letmein',
  'iloveyou',
  'admin',
  'welcome',
  'abc123',
  'monkey',
  'dragon',
  'master',
  'login',
];

function poolSize(pw: string): number {
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  return pool;
}

export function estimateStrength(pw: string): Strength {
  const meetsMinimum = Array.from(pw).length >= FIELD.masterPasswordMin;
  if (pw.length === 0) return { level: 0, ratio: 0, meetsMinimum };
  const lower = pw.toLowerCase();
  const chars = Array.from(pw);
  const unique = new Set(chars).size;
  let bits =
    chars.length * Math.log2(Math.max(2, poolSize(pw))) * Math.min(1, unique / chars.length + 0.25);
  if (COMMON.some((c) => lower.includes(c))) bits = Math.min(bits, 28);
  if (/^(.)\1+$/.test(pw)) bits = Math.min(bits, 10);
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv)/.test(lower)) {
    bits -= 12;
  }
  bits = Math.max(0, bits);
  let level: StrengthLevel = 1;
  if (bits >= 100) level = 4;
  else if (bits >= 72) level = 3;
  else if (bits >= 48) level = 2;
  if (!meetsMinimum) level = Math.min(level, 1) as StrengthLevel;
  return { level, ratio: Math.min(1, bits / 100), meetsMinimum };
}
