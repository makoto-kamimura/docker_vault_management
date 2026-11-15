/** Elapsed seconds as `m:ss` (e.g. 65 -> "1:05"). */
export function formatElapsed(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
