import { RATE_LIMITS, type RateLimit, type RateLimitKey } from '@localvault/protocol';

export type HitResult = { ok: true } | { ok: false; retryAfterSec: number };

/** In-memory sliding-window log (single instance, spec §13.8). */
export class RateLimiter {
  private readonly buckets = new Map<string, { windowMs: number; hits: number[] }>();
  private lastSweep = 0;

  /** Records one hit unless the window is full. `nowMs` comes from the injected clock. */
  hit(key: string, max: number, windowSec: number, nowMs: number): HitResult {
    this.sweep(nowMs);
    const windowMs = windowSec * 1000;
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { windowMs, hits: [] };
      this.buckets.set(key, bucket);
    }
    const cutoff = nowMs - windowMs;
    while (bucket.hits.length > 0 && (bucket.hits[0] as number) <= cutoff) bucket.hits.shift();
    if (bucket.hits.length >= max) {
      const oldest = bucket.hits[0] as number;
      return {
        ok: false,
        retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)),
      };
    }
    bucket.hits.push(nowMs);
    return { ok: true };
  }

  /** Drop buckets whose newest hit has left its window (at most once a minute). */
  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweep < 60_000) return;
    this.lastSweep = nowMs;
    for (const [key, b] of this.buckets) {
      const newest = b.hits[b.hits.length - 1];
      if (newest === undefined || newest <= nowMs - b.windowMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** Values a limit can be keyed by. `undefined` means "not available at this stage". */
export type LimitSubjects = Partial<Record<RateLimitKey, string | undefined>>;

/** The limits of the protocol table that apply to a route (plus the global per-token one). */
export function limitsFor(routeName: string): readonly RateLimit[] {
  return RATE_LIMITS.filter((l) => l.route === routeName || l.route === 'global');
}
