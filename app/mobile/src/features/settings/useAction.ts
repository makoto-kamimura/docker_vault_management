import { useCallback, useRef, useState } from 'react';
import { haptics } from '../../lib/haptics';
import { describeActionError, isClockSkew, isRetryable } from './errors';

/** Busy/error wrapper for one-shot async actions on a screen. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryable, setRetryable] = useState(false);
  const [clockSkew, setClockSkew] = useState(false);
  const mounted = useRef(true);

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setRetryable(false);
    setClockSkew(false);
    try {
      const r = await fn();
      return r;
    } catch (e) {
      const msg = describeActionError(e);
      if (msg !== null) {
        haptics.error();
        setError(msg);
        setRetryable(isRetryable(e));
        setClockSkew(isClockSkew(e));
      }
      return undefined;
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { busy, error, retryable, clockSkew, run, clear, setError };
}
