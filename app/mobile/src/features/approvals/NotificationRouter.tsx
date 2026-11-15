import * as Notifications from 'expo-notifications';
import { useEffect, useRef } from 'react';
import { nav } from '../../lib/nav';
import { useLockStore } from '../../state/lockStore';
import { routeForNotification } from './notificationRoute';
import { usePendingRoute } from './pendingRoute';

// Foreground arrivals are shown quietly; the pending-approvals poll covers the rest.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/**
 * Mounted at the root: handles notification taps (also the cold-start one) and replays routes that
 * had to wait for unlock. `/approve/...` is let through while locked by the route guard.
 */
export function NotificationRouter() {
  const lockState = useLockStore((s) => s.lockState);
  const last = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  const pending = usePendingRoute((s) => s.route);
  const setPending = usePendingRoute((s) => s.set);

  useEffect(() => {
    if (!last || lockState === 'unknown' || lockState === 'uninitialized') return;
    const id = last.notification.request.identifier;
    if (handled.current === id) return;
    handled.current = id;
    const route = routeForNotification(last.notification.request);
    if (route === null) return;
    if (lockState === 'locked' && !route.startsWith('/approve/')) setPending(route);
    else nav.push(route);
  }, [last, lockState, setPending]);

  useEffect(() => {
    if (lockState === 'unlocked' && pending !== null) {
      setPending(null);
      nav.push(pending);
    }
  }, [lockState, pending, setPending]);

  return null;
}
