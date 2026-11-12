// Design tokens as CSS variables (same visual language as the mobile app).
import { cssText, staticCssVariables, toCssVariables } from '@localvault/design-tokens';

const decl = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([k, v]) => `${k}:${v};`)
    .join('');

/** For extension pages (:root, light by default, dark via prefers-color-scheme). */
export const pageThemeCss: string = cssText;

/** For the closed Shadow DOM of the content script (:host instead of :root). */
export const hostThemeCss: string = [
  `:host{all:initial;${decl({ ...staticCssVariables(), ...toCssVariables('light') })}color-scheme:light dark;}`,
  `@media (prefers-color-scheme: dark){:host{${decl(toCssVariables('dark'))}}}`,
].join('\n');
