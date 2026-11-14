import { describe, expect, it } from 'vitest';
import {
  avatarColorFor,
  avatarForeground,
  avatarLetterFor,
  avatarPalette,
  color,
  cssText,
  minTouchTarget,
  type ThemeName,
  toCssVariables,
} from '../src/index';

function lum(hex: string): number {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const themes: ThemeName[] = ['light', 'dark'];

describe.each(themes)('contrast (%s)', (name) => {
  const c = color[name];
  const grounds = ['bg', 'bgElevated', 'surface', 'bgSunken'] as const;

  it('body text >= 4.5 on every ground', () => {
    for (const g of grounds) {
      for (const t of ['text', 'textSecondary', 'textTertiary'] as const) {
        expect(contrast(c[t], c[g]), `${t} on ${g}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('accent / status colours usable as text >= 4.5 on bg, elevated and surface', () => {
    for (const g of ['bg', 'bgElevated', 'surface'] as const) {
      for (const t of ['accent', 'success', 'warning', 'danger'] as const) {
        expect(contrast(c[t], c[g]), `${t} on ${g}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  it('text on tinted backgrounds >= 4.5', () => {
    expect(contrast(c.accent, c.accentSubtle)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.danger, c.dangerSubtle)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.text, c.accentSubtle)).toBeGreaterThanOrEqual(4.5);
  });
  it('onAccent on accent and accentPressed >= 4.5', () => {
    expect(contrast(c.onAccent, c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onAccent, c.accentPressed)).toBeGreaterThanOrEqual(4.5);
  });
  it('icons / focus ring / strong borders >= 3 on bg', () => {
    expect(contrast(c.focusRing, c.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(c.borderStrong, c.bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(c.borderStrong, c.surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(c.accent, c.bg)).toBeGreaterThanOrEqual(3);
    for (const g of ['bg', 'bgElevated', 'surface'] as const)
      expect(contrast(c.highlight, c[g]), `highlight on ${g}`).toBeGreaterThanOrEqual(3);
  });
  it('hex formats', () => {
    for (const [k, v] of Object.entries(c))
      expect(v, k).toMatch(k === 'overlay' ? /^#[0-9A-F]{8}$/ : /^#[0-9A-F]{6}$/);
  });
});

describe('avatars', () => {
  it('8 hues, white text >= 4.5, and >= 3 against both backgrounds', () => {
    expect(avatarPalette).toHaveLength(8);
    for (const hue of avatarPalette) {
      expect(contrast(avatarForeground, hue), hue).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hue, color.light.bg), `${hue} light`).toBeGreaterThanOrEqual(3);
      expect(contrast(hue, color.dark.bg), `${hue} dark`).toBeGreaterThanOrEqual(3);
    }
  });
  it('is deterministic and spreads over the palette', () => {
    expect(avatarColorFor('GitHub')).toEqual(avatarColorFor('  github '));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(avatarColorFor(`site-${i}`).index);
    expect(seen.size).toBe(8);
  });
  it('letters', () => {
    expect(avatarLetterFor('example')).toBe('E');
    expect(avatarLetterFor('  銀行')).toBe('銀');
    expect(avatarLetterFor('😀 fun')).toBe('😀');
    expect(avatarLetterFor('')).toBe('?');
  });
});

describe('css', () => {
  it('emits --lv-* variables', () => {
    const v = toCssVariables('dark');
    expect(v['--lv-color-bg-elevated']).toBe(color.dark.bgElevated);
    expect(v['--lv-color-on-accent']).toBe(color.dark.onAccent);
    expect(Object.keys(v).every((k) => k.startsWith('--lv-'))).toBe(true);
  });
  it('cssText handles prefers-color-scheme and data-theme', () => {
    expect(cssText).toContain('@media (prefers-color-scheme: dark)');
    expect(cssText).toContain(':root[data-theme="dark"]');
    expect(cssText).toContain(`--lv-color-bg: ${color.light.bg};`);
    expect(cssText).toContain(`--lv-color-bg: ${color.dark.bg};`);
    expect(cssText).toContain('--lv-space-4: 16px;');
  });
  it('touch target', () => expect(minTouchTarget).toBe(44));
});
