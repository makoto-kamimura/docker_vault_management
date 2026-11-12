// Master-password attempt throttle — FR-12.
// 5 consecutive failures -> wait 30 s; every further failure doubles the wait, capped at 15 min.

export const THROTTLE_FREE_ATTEMPTS = 5;
export const THROTTLE_BASE_SEC = 30;
export const THROTTLE_MAX_SEC = 15 * 60;

/** Wait imposed after `failedCount` consecutive failures (0 while attempts remain). */
export function throttleWaitSec(failedCount: number): number {
  if (!Number.isInteger(failedCount) || failedCount < THROTTLE_FREE_ATTEMPTS) return 0;
  const doublings = failedCount - THROTTLE_FREE_ATTEMPTS;
  // 30 * 2^5 = 960 > 900 already, so cap the exponent to avoid float overflow for huge counts.
  return Math.min(THROTTLE_BASE_SEC * 2 ** Math.min(doublings, 10), THROTTLE_MAX_SEC);
}

/** Attempts left before the first wait starts (0 once throttling has begun). */
export function attemptsBeforeThrottle(failedCount: number): number {
  return Math.max(0, THROTTLE_FREE_ATTEMPTS - failedCount);
}

/** `{ failedCount, retryAfterSec }` for display: remaining seconds of the current wait. */
export function throttleState(input: {
  failedCount: number;
  /** Epoch ms of the last failure, or null if none. */
  lastFailureAtMs: number | null;
  nowMs: number;
}): { failedCount: number; retryAfterSec: number } {
  const wait = throttleWaitSec(input.failedCount);
  if (wait === 0 || input.lastFailureAtMs === null)
    return { failedCount: input.failedCount, retryAfterSec: 0 };
  const remainingMs = input.lastFailureAtMs + wait * 1000 - input.nowMs;
  return {
    failedCount: input.failedCount,
    retryAfterSec: Math.max(0, Math.ceil(remainingMs / 1000)),
  };
}
