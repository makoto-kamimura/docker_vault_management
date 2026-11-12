import { attemptsBeforeThrottle, VaultCoreError } from '@localvault/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { useLockStore } from '../../state/lockStore';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';

export type BioKind = 'faceId' | 'touchId' | 'biometric';

export function formatThrottle(sec: number): string {
  const s = Math.max(1, Math.ceil(sec));
  if (s < 60) return t('unlock.throttled', { sec: s });
  return t('unlock.throttledMin', { min: Math.floor(s / 60), sec: s % 60 });
}

export function useUnlock() {
  const { core } = useSession();
  const setLockState = useLockStore((s) => s.setLockState);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bioKind, setBioKind] = useState<BioKind | null>(null);
  const [bioInvalidated, setBioInvalidated] = useState(false);
  const [throttleSec, setThrottleSec] = useState(0);
  const started = useRef(false);

  const refreshThrottle = useCallback(async () => {
    const st = await core.getThrottleState();
    setThrottleSec(st.retryAfterSec);
    return st;
  }, [core]);

  // Tick the wait-time down locally; VaultCore is the source of truth and is re-read at zero.
  const throttled = throttleSec > 0;
  useEffect(() => {
    if (!throttled) return;
    const id = setInterval(() => {
      setThrottleSec((s) => {
        if (s <= 1) {
          setError(null);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [throttled]);

  const done = useCallback(async () => {
    haptics.success();
    setLockState(await core.getLockState());
  }, [core, setLockState]);

  const tryBiometrics = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await core.unlockWithBiometrics();
      await done();
    } catch (e) {
      if (e instanceof VaultCoreError) {
        if (e.code === 'E_BIOMETRY_INVALIDATED') setBioInvalidated(true);
        else if (e.code === 'E_AUTH_FAILED') setError(t('unlock.bioFailed'));
        // E_AUTH_CANCELED / E_BIOMETRY_UNAVAILABLE: just show the password field.
      }
    } finally {
      setBusy(false);
    }
  }, [core, done]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const [avail, st] = await Promise.all([core.getBiometricAvailability(), refreshThrottle()]);
      if (avail.available && avail.kind !== 'none') {
        setBioKind(avail.kind);
        // Spec §14: start biometrics as soon as the screen appears.
        void tryBiometrics();
      }
      void st;
    })().catch(() => undefined);
  }, [core, refreshThrottle, tryBiometrics]);

  const submit = useCallback(async () => {
    if (password === '' || throttleSec > 0) return;
    setBusy(true);
    setError(null);
    try {
      await core.unlockWithPassword(password);
      setPassword('');
      await done();
    } catch (e) {
      haptics.error();
      if (e instanceof VaultCoreError && e.code === 'E_THROTTLED') {
        setThrottleSec(e.details?.retryAfterSec ?? 30);
        setError(null);
      } else if (e instanceof VaultCoreError && e.code === 'E_WRONG_PASSWORD') {
        const st = await refreshThrottle().catch(() => null);
        const left = st ? attemptsBeforeThrottle(st.failedCount) : null;
        setError(
          left !== null && left > 0
            ? `${t('unlock.wrong')} ${t('unlock.attemptsLeft', { n: left })}`
            : t('unlock.wrong'),
        );
      } else if (e instanceof VaultCoreError && e.code === 'E_BIOMETRY_INVALIDATED') {
        setBioInvalidated(true);
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  }, [core, password, throttleSec, done, refreshThrottle]);

  return {
    password,
    setPassword,
    busy,
    error,
    bioKind,
    bioInvalidated,
    throttleSec,
    submit,
    tryBiometrics,
  };
}
