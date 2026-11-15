/** ISO 8601 UTC at second precision, no fractional part (signed strings, spec 8.4). */
export function isoSeconds(ms: number): string {
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
}
