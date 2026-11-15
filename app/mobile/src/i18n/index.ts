import { ja, type MessageKey } from './ja';

export type { MessageKey } from './ja';

export type MessageParams = Record<string, string | number>;

/** Look up a Japanese message and substitute `{name}` placeholders. */
export function t(key: MessageKey, params?: MessageParams): string {
  const template: string = ja[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/** Seconds -> "m分s秒" style helpers used by countdowns. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
