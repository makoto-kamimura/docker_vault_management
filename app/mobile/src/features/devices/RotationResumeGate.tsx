import { useEffect, useState } from 'react';
import { Banner, BottomSheet, Button, Text } from '../../components';
import { t } from '../../i18n';
import { getFlagStore } from '../../lib/flagStore';
import { haptics } from '../../lib/haptics';
import { useLockStore } from '../../state/lockStore';
import { useSession } from '../session/SessionProvider';
import { useAction } from '../settings/useAction';
import {
  abortRotationFlow,
  pendingRotation,
  type RotationProgress,
  resumeRotationFlow,
} from './flows';
import { RotationProgressView } from './RotationProgressView';

/** On app start (unlocked): a rotation that was started but never confirmed -> resume or abort. */
export function RotationResumeGate() {
  const { core, api, engine } = useSession();
  const lockState = useLockStore((s) => s.lockState);
  const [pending, setPending] = useState<{ rotationId: string | null } | null>(null);
  const [progress, setProgress] = useState<RotationProgress | null>(null);
  const [running, setRunning] = useState(false);
  const act = useAction();

  useEffect(() => {
    if (lockState !== 'unlocked') return;
    let alive = true;
    pendingRotation(core, getFlagStore())
      .then((p) => alive && setPending(p))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [core, lockState]);

  if (pending === null) return null;
  const deps = {
    core,
    api,
    store: getFlagStore(),
    syncAfter: () => engine.requestSync('manual'),
    onProgress: setProgress,
  };

  const resume = async () => {
    if (pending.rotationId === null) return abort();
    setRunning(true);
    const ok = await act.run(async () => {
      await resumeRotationFlow(deps, pending.rotationId as string);
      return true;
    });
    setRunning(false);
    if (ok) {
      haptics.success();
      setPending(null);
    }
  };
  const abort = async () => {
    setRunning(true);
    await act.run(() => abortRotationFlow(deps, pending.rotationId));
    setRunning(false);
    setPending(null);
  };

  return (
    <BottomSheet visible onClose={() => undefined} title={t('rot.resumeTitle')}>
      {running ? (
        <RotationProgressView progress={progress} />
      ) : (
        <>
          <Text variant="body" tone="secondary">
            {t('rot.resumeBody')}
          </Text>
          {act.error !== null && <Banner kind="danger" message={act.error} />}
          <Button testID="rotation-resume" label={t('rot.resume')} onPress={resume} />
          <Button testID="rotation-abort" variant="danger" label={t('rot.abort')} onPress={abort} />
        </>
      )}
    </BottomSheet>
  );
}
