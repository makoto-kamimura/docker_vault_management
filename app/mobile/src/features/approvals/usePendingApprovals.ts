import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useApprovalsStore } from '../../state/approvalsStore';
import { useLockStore } from '../../state/lockStore';
import { useSession } from '../session/SessionProvider';
import { countPending } from './flows';
import { usePendingTarget } from './pendingRoute';

export const PENDING_POLL_MS = 30_000;

/**
 * Polls pending unlock requests and recovery claims while the app is foregrounded and unlocked,
 * and publishes the total to `useApprovalsStore` (list banner). Failures keep the old count.
 */
export function usePendingApprovals(intervalMs: number = PENDING_POLL_MS): void {
  const { api } = useSession();
  const lockState = useLockStore((s) => s.lockState);
  const setCount = useApprovalsStore((s) => s.setPendingCount);
  const setTarget = usePendingTarget((s) => s.set);

  useEffect(() => {
    if (lockState !== 'unlocked') {
      setCount(0);
      setTarget(null);
      return;
    }
    let timer: ReturnType<typeof setInterval> | null = null;
    let alive = true;
    const poll = () =>
      countPending(api)
        .then((c) => {
          if (!alive) return;
          setCount(c.unlock + c.claims);
          setTarget(c.firstRoute);
        })
        .catch(() => undefined);
    const start = () => {
      if (timer !== null) return;
      void poll();
      timer = setInterval(poll, intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
    return () => {
      alive = false;
      stop();
      sub.remove();
    };
  }, [api, lockState, setCount, setTarget, intervalMs]);
}
