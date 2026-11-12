import {
  defaultProvider,
  formatRecoveryKey,
  generateRecoveryKeyBytes,
  parseRecoveryKey,
} from '@localvault/core';
import { describe, expect, it } from 'vitest';
import { constantTimeEqual } from '../src/lib/constantTime';
import {
  formatRecoveryKeyInput,
  isCanonicalRecoveryKey,
  isRecoveryKeyComplete,
  normalizeTailInput,
  recoveryKeyTail,
} from '../src/lib/recoveryKeyInput';

describe('recovery key input formatting', () => {
  it('groups by four with the LV2 prefix', () => {
    expect(formatRecoveryKeyInput('')).toBe('');
    expect(formatRecoveryKeyInput('abcd')).toBe('LV2-ABCD');
    expect(formatRecoveryKeyInput('abcdefghj')).toBe('LV2-ABCD-EFGH-J');
  });
  it('reads I/L as 1 and O as 0, ignores hyphens, spaces and junk', () => {
    expect(formatRecoveryKeyInput('lv2-il o u!')).toBe('LV2-110');
    expect(formatRecoveryKeyInput('LV2 - 0O0O')).toBe('LV2-0000');
  });
  it('caps at 28 data characters', () => {
    const f = formatRecoveryKeyInput('0'.repeat(40));
    expect(f).toBe(`LV2-${Array(7).fill('0000').join('-')}`);
    expect(isRecoveryKeyComplete(f)).toBe(true);
    expect(isRecoveryKeyComplete('LV2-0000')).toBe(false);
  });
  it('round-trips a generated key and detects typos via the check characters', async () => {
    const p = defaultProvider();
    const key = await formatRecoveryKey(p, await generateRecoveryKeyBytes(p));
    expect(isCanonicalRecoveryKey(key)).toBe(true);
    expect(formatRecoveryKeyInput(key.toLowerCase().replace(/-/g, ' '))).toBe(key);
    await expect(parseRecoveryKey(p, formatRecoveryKeyInput(key))).resolves.toBeInstanceOf(
      Uint8Array,
    );
    const last = key.slice(-1);
    const typo = key.slice(0, -1) + (last === '0' ? '1' : '0');
    await expect(parseRecoveryKey(p, typo)).rejects.toMatchObject({
      code: 'E_INVALID_RECOVERY_KEY',
    });
  });
  it('tail check normalises like key entry', () => {
    expect(recoveryKeyTail('LV2-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGH')).toBe('GGGH');
    expect(normalizeTailInput(' ggg-h')).toBe('GGGH');
    expect(constantTimeEqual('GGGH', normalizeTailInput('gggh'))).toBe(true);
    expect(constantTimeEqual('GGGH', 'GGGJ')).toBe(false);
    expect(constantTimeEqual('GGG', 'GGGH')).toBe(false);
  });
});
