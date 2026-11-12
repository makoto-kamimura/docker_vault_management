import { useRouter, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { nav } from '../../lib/nav';
import { useLockStore } from '../../state/lockStore';
import { useSetupDraft } from '../../state/setupDraft';
import { resolveGuard } from './guard';

/** Redirects according to `resolveGuard` whenever lock state, device standing or route changes. */
export function RouteGuard() {
  const segments = useSegments();
  const router = useRouter();
  const lockState = useLockStore((s) => s.lockState);
  const standing = useLockStore((s) => s.standing);
  const setupInProgress = useSetupDraft((s) => s.inProgress);
  const key = segments.join('/');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `segments`
  useEffect(() => {
    const target = resolveGuard({ lockState, standing, segments, setupInProgress });
    if (target !== null) nav.replace(target);
  }, [lockState, standing, key, setupInProgress, router]);

  return null;
}
