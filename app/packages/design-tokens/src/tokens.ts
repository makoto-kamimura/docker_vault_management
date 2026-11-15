// うちカギ design tokens. Calm, minimal, system fonts. Washi-like warm neutrals, one 藍 (ai, Japanese
// indigo) accent, and 真鍮 (brass) as a sparing highlight (the key; favourites).
// Sizes are dp / px numbers. Colours are #RRGGBB (overlay is #RRGGBBAA, supported by RN and CSS).

export type ThemeName = 'light' | 'dark';

export type ColorTokens = {
  bg: string;
  bgElevated: string;
  bgSunken: string;
  surface: string;
  border: string;
  borderStrong: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentPressed: string;
  accentSubtle: string;
  onAccent: string;
  /** 真鍮 (brass). Icons and small marks only (>= 3:1), never body text. */
  highlight: string;
  success: string;
  warning: string;
  danger: string;
  dangerSubtle: string;
  overlay: string;
  focusRing: string;
};

export const color: Record<ThemeName, ColorTokens> = {
  light: {
    bg: '#F8F7F3',
    bgElevated: '#FFFFFF',
    bgSunken: '#EFEDE7',
    surface: '#FFFFFF',
    border: '#E2DFD7',
    borderStrong: '#8A877F',
    text: '#1A1B20',
    textSecondary: '#4C4B47',
    textTertiary: '#67655F',
    accent: '#1F4A86',
    accentPressed: '#173A6B',
    accentSubtle: '#E7EDF5',
    onAccent: '#FFFFFF',
    highlight: '#946A1E',
    success: '#1B7A49',
    warning: '#9A5B00',
    danger: '#C42B3A',
    dangerSubtle: '#FDECEE',
    overlay: '#14151A66',
    focusRing: '#1F4A86',
  },
  dark: {
    bg: '#111214',
    bgElevated: '#18191C',
    bgSunken: '#0B0B0D',
    surface: '#1D1E22',
    border: '#2D2E33',
    borderStrong: '#6C6C72',
    text: '#F2F1EC',
    textSecondary: '#BBB9B1',
    textTertiary: '#96948C',
    accent: '#8DB2EA',
    accentPressed: '#A9C5F0',
    accentSubtle: '#1A2639',
    onAccent: '#0E1A2C',
    highlight: '#D9AE5F',
    success: '#4CC38A',
    warning: '#F0B454',
    danger: '#FF6B7A',
    dangerSubtle: '#3A1820',
    overlay: '#000000B3',
    focusRing: '#A9C5F0',
  },
};

/** 4-pt scale. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
} as const;

export const radius = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  full: 9999,
} as const;

/** dp; the apps scale these with the OS font scale (Dynamic Type / fontScale). */
export const fontSize = {
  caption: 12,
  footnote: 13,
  body: 16,
  callout: 17,
  title3: 20,
  title2: 24,
  title1: 28,
  largeTitle: 34,
} as const;

export const lineHeight = {
  caption: 16,
  footnote: 18,
  body: 24,
  callout: 24,
  title3: 26,
  title2: 30,
  title1: 34,
  largeTitle: 41,
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const fontFamily = {
  /** React Native: the platform system font. */
  native: 'System',
  /** Extension / web. */
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export type ElevationToken = {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  /** Android elevation */
  elevation: number;
  /** CSS equivalent */
  boxShadow: string;
};

export const elevation: Record<'none' | 'sm' | 'md' | 'lg', ElevationToken> = {
  none: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
    boxShadow: 'none',
  },
  sm: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 2,
    elevation: 1,
    boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
  },
  md: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
    boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
  },
  lg: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.12,
    shadowRadius: 28,
    elevation: 8,
    boxShadow: '0 12px 28px rgba(0,0,0,0.12)',
  },
};

export const motion = {
  duration: { instant: 0, fast: 120, base: 200, slow: 320 },
  /** cubic-bezier control points [x1, y1, x2, y2] */
  easing: {
    standard: [0.2, 0, 0, 1],
    decelerate: [0, 0, 0, 1],
    accelerate: [0.3, 0, 1, 1],
  },
  /** CSS strings for the same curves. */
  easingCss: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  },
} as const;

/** Minimum touch target (spec §14: 44pt). */
export const minTouchTarget = 44;
export const hitSlop = { top: 8, bottom: 8, left: 8, right: 8 } as const;

export const layout = {
  /** Screen horizontal gutter. */
  gutter: space[4],
  /** Max content width for the extension popup / wide screens. */
  maxContentWidth: 640,
  popupWidth: 360,
} as const;

// ------------------------------------------------------------------ brand (うちカギ)

/**
 * Fixed brand colours for the mark and the app icon (not themed: the mark looks the same in light
 * and dark). brass on ai is >= 4.5:1.
 */
export const brand = {
  /** 藍 */
  ai: '#1F4A86',
  /** 真鍮 */
  brass: '#E2BC6E',
} as const;

/**
 * The mark on a 1024 grid: a key whose bow is a house (うち + カギ). Shared by the RN BrandMark
 * component and app/mobile/scripts/generate-icons.py (keep the numbers in sync).
 */
export const brandMark = {
  viewBox: 1024,
  /** Tile corner radius when drawn as a tile (iOS masks the real icon itself). */
  tileRadius: 224,
  bow: [512, 212, 748, 420, 690, 420, 690, 630, 334, 630, 334, 420, 276, 420],
  keyholeCircle: { cx: 512, cy: 490, r: 46 },
  keyholeStem: [490, 520, 534, 520, 548, 590, 476, 590],
  /** x, y, width, height */
  bars: [
    [484, 628, 56, 222],
    [538, 740, 78, 42],
    [538, 800, 58, 42],
  ],
} as const;

// ------------------------------------------------------------------ avatars (FR-24)

export type AvatarColor = { index: number; background: string; foreground: string };

/**
 * 8 hues. Each has >= 4.5:1 contrast with white text and >= 3:1 against both theme backgrounds,
 * so one colour works unchanged in light and dark themes.
 */
export const avatarPalette: readonly string[] = [
  '#2563EB', // blue
  '#0E7490', // cyan
  '#047857', // emerald
  '#B45309', // amber
  '#C2410C', // orange
  '#D1264F', // rose
  '#7C3AED', // violet
  '#C026D3', // magenta
];
export const avatarForeground = '#FFFFFF';

/** FNV-1a 32-bit over UTF-16 code units of the NFKC, trimmed, lower-cased title. */
function hashTitle(title: string): number {
  const s = title.normalize('NFKC').trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic colour for the letter avatar of an item; same title gives the same colour everywhere. */
export function avatarColorFor(title: string): AvatarColor {
  const index = hashTitle(title) % avatarPalette.length;
  return { index, background: avatarPalette[index] as string, foreground: avatarForeground };
}

/** First character (code point) of the title, upper-cased; "?" for an empty title. */
export function avatarLetterFor(title: string): string {
  const first = Array.from(title.trim())[0];
  return first === undefined ? '?' : first.toUpperCase();
}

// ------------------------------------------------------------------ theme

export type Theme = {
  name: ThemeName;
  color: ColorTokens;
  space: typeof space;
  radius: typeof radius;
  fontSize: typeof fontSize;
  lineHeight: typeof lineHeight;
  fontWeight: typeof fontWeight;
  fontFamily: typeof fontFamily;
  elevation: typeof elevation;
  motion: typeof motion;
  minTouchTarget: number;
  hitSlop: typeof hitSlop;
  layout: typeof layout;
};

export function getTheme(name: ThemeName): Theme {
  return {
    name,
    color: color[name],
    space,
    radius,
    fontSize,
    lineHeight,
    fontWeight,
    fontFamily,
    elevation,
    motion,
    minTouchTarget,
    hitSlop,
    layout,
  };
}

export const themes: Record<ThemeName, Theme> = {
  light: getTheme('light'),
  dark: getTheme('dark'),
};
