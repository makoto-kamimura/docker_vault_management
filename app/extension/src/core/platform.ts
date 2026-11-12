import type { Platform } from './types';

/** Browser and OS from the user agent, for the default device name "Chrome（Windows）" (8.3). */
export function detectPlatform(userAgent: string, brave: boolean): Platform {
  const browser = brave ? 'brave' : /\bEdg\//.test(userAgent) ? 'edge' : 'chrome';
  const os = /Windows/.test(userAgent)
    ? 'Windows'
    : /Mac OS X|Macintosh/.test(userAgent)
      ? 'macOS'
      : /CrOS/.test(userAgent)
        ? 'ChromeOS'
        : /Linux/.test(userAgent)
          ? 'Linux'
          : 'PC';
  return { browser, os };
}

export function defaultDeviceName(p: Platform): string {
  const b = p.browser === 'chrome' ? 'Chrome' : p.browser === 'edge' ? 'Edge' : 'Brave';
  return `${b}（${p.os}）`;
}
