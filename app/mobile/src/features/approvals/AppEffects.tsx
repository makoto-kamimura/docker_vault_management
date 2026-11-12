import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { useLockStore } from '../../state/lockStore';
import { RotationResumeGate } from '../devices/RotationResumeGate';
import { useSession } from '../session/SessionProvider';
import { registerPushToken } from './pushToken';
import { usePendingApprovals } from './usePendingApprovals';

/** Mounted once inside the unlocked app group: polling, push token registration, rotation resume. */
export function AppEffects() {
  const { api } = useSession();
  const lockState = useLockStore((s) => s.lockState);
  usePendingApprovals();

  useEffect(() => {
    if (lockState !== 'unlocked') return;
    // Only when the user already allowed notifications (setup step); failures are not fatal.
    Notifications.getPermissionsAsync()
      .then((p) => (p.granted ? registerPushToken(api) : undefined))
      .catch(() => undefined);
  }, [api, lockState]);

  return <RotationResumeGate />;
}
