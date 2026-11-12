import { describe, expect, it } from 'vitest';
import { buildKitHtml, escapeHtml } from '../src/features/setup/kitHtml';
import { t } from '../src/i18n';
import { estimateStrength } from '../src/lib/passwordStrength';
import { createQrMatrix } from '../src/lib/qr';

describe('password strength', () => {
  it('enforces the 10-char minimum and ranks passwords', () => {
    expect(estimateStrength('').level).toBe(0);
    expect(estimateStrength('short1A!').meetsMinimum).toBe(false);
    expect(estimateStrength('password1234').level).toBeLessThanOrEqual(1);
    expect(estimateStrength('correct horse battery staple 42!').level).toBeGreaterThanOrEqual(3);
  });
});

describe('i18n', () => {
  it('interpolates', () => {
    expect(t('unlock.throttled', { sec: 12 })).toContain('12');
    expect(t('a11y.progress', { current: 1, total: 3 })).toBe('3 段階中 1 段階目');
  });
});

describe('emergency kit', () => {
  it('escapes html and embeds a local QR svg', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    const html = buildKitHtml({
      serverUrl: 'https://vault.example.com',
      accountName: 'alice',
      recoveryKey: 'LV2-0000-0000-0000-0000-0000-0000-0000',
      createdAt: new Date(2026, 10, 12),
    });
    expect(html).toContain('<svg');
    expect(html).toContain('LV2-0000-0000');
    expect(html).not.toMatch(/https?:\/\/(?!vault\.example\.com|www\.w3\.org)/);
    expect(createQrMatrix('lvkit:v1?x').size).toBeGreaterThan(20);
  });
});
