import {
  fontFamily,
  fontSize,
  lineHeight,
  motion,
  radius,
  space,
  type Theme,
  type ThemeName,
  themes,
} from './tokens';

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Theme-independent variables (spacing, radii, type, motion). */
export function staticCssVariables(): Record<string, string> {
  const v: Record<string, string> = {};
  for (const [k, n] of Object.entries(space)) v[`--lv-space-${k}`] = `${n}px`;
  for (const [k, n] of Object.entries(radius)) v[`--lv-radius-${k}`] = `${n}px`;
  for (const [k, n] of Object.entries(fontSize)) v[`--lv-font-size-${kebab(k)}`] = `${n}px`;
  for (const [k, n] of Object.entries(lineHeight)) v[`--lv-line-height-${kebab(k)}`] = `${n}px`;
  for (const [k, n] of Object.entries(fontFamily)) {
    if (k !== 'native') v[`--lv-font-${k}`] = n;
  }
  for (const [k, n] of Object.entries(motion.duration)) v[`--lv-duration-${k}`] = `${n}ms`;
  for (const [k, n] of Object.entries(motion.easingCss)) v[`--lv-easing-${k}`] = n;
  return v;
}

/** `--lv-color-*` and `--lv-shadow-*` custom properties for one theme. */
export function toCssVariables(theme: Theme | ThemeName): Record<string, string> {
  const t = typeof theme === 'string' ? themes[theme] : theme;
  const v: Record<string, string> = {};
  for (const [k, c] of Object.entries(t.color)) v[`--lv-color-${kebab(k)}`] = c;
  for (const [k, e] of Object.entries(t.elevation)) v[`--lv-shadow-${k}`] = e.boxShadow;
  return v;
}

function block(selector: string, vars: Record<string, string>, extra = ''): string {
  const body = Object.entries(vars)
    .map(([k, val]) => `  ${k}: ${val};`)
    .join('\n');
  return `${selector} {\n${extra}${body}\n}`;
}

/**
 * Complete stylesheet: light by default, dark under `prefers-color-scheme: dark`, and an explicit
 * override through `data-theme="light|dark"` on the root element.
 */
export const cssText: string = [
  block(
    ':root',
    { ...staticCssVariables(), ...toCssVariables('light') },
    '  color-scheme: light dark;\n',
  ),
  `@media (prefers-color-scheme: dark) {\n${block(
    ':root:not([data-theme="light"])',
    toCssVariables('dark'),
    '  color-scheme: dark;\n',
  )
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')}\n}`,
  block(':root[data-theme="dark"]', toCssVariables('dark'), '  color-scheme: dark;\n'),
  block(':root[data-theme="light"]', toCssVariables('light'), '  color-scheme: light;\n'),
].join('\n\n');
