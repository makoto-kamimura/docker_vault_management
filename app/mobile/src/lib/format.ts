// Japanese date/time helpers for settings, devices and the security log. Pure (inject `nowMs`).
const pad = (n: number) => String(n).padStart(2, '0');

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatDateTime(iso: string): string {
  return `${formatDate(iso)} ${formatClock(iso)}`;
}

export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const diffSec = Math.round((nowMs - Date.parse(iso)) / 1000);
  if (diffSec < 45) return 'たった今';
  if (diffSec < 3600) return `${Math.max(1, Math.round(diffSec / 60))}分前`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}時間前`;
  if (diffSec < 86400 * 7) return `${Math.round(diffSec / 86400)}日前`;
  return formatDate(iso);
}

/** "2 日 4 時間" style remaining-time phrase for waiting periods (>= 1 minute granularity). */
export function formatSpan(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}日${h}時間` : `${d}日`;
  if (h > 0) return m > 0 ? `${h}時間${m}分` : `${h}時間`;
  return `${Math.max(1, m)}分`;
}
