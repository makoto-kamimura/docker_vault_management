import { Hourglass } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, ConfirmDialog, Countdown, Screen, Text } from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSetupDraft } from '../../state/setupDraft';
import { makeStyles, useTheme } from '../../theme';
import { describeClaimError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';
import { pollClaimFlow } from './flows';

const POLL_MS = 15_000;

const useStyles = makeStyles((th) => ({
  card: {
    alignItems: 'center',
    gap: th.space[3],
    padding: th.space[6],
    borderRadius: th.radius.xl,
    backgroundColor: th.color.surface,
    borderWidth: 1,
    borderColor: th.color.border,
  },
}));

export function RestoreWaitScreen() {
  const { core, makeApi, engine } = useSession();
  const s = useStyles();
  const th = useTheme();
  const draft = useSetupDraft();
  const [availableAtMs, setAvailableAtMs] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const completing = useRef(false);

  // Resumable: the pending claim lives in VaultCore, not in this screen.
  useEffect(() => {
    let alive = true;
    core.getPendingRecoveryClaim().then((c) => {
      if (!alive) return;
      if (c === null) nav.replace('/setup');
      else setAvailableAtMs(Date.parse(c.availableAt));
    });
    return () => {
      alive = false;
    };
  }, [core]);

  const check = useCallback(async () => {
    if (completing.current) return;
    setChecking(true);
    try {
      const r = await pollClaimFlow({ core, makeApi });
      if (r.status === 'completed') {
        completing.current = true;
        draft.setInProgress(true);
        haptics.success();
        void engine.requestSync('launch');
        nav.replace('/setup/new-password');
      } else if (r.availableAt) {
        setAvailableAtMs(Date.parse(r.availableAt));
      }
      setFailure(null);
    } catch (e) {
      setFailure(describeClaimError(e));
    } finally {
      setChecking(false);
    }
  }, [core, makeApi, engine, draft]);

  useEffect(() => {
    // "自分で使った" on another phone can finish the wait early: poll while the screen is open.
    const id = setInterval(() => void check(), POLL_MS);
    return () => clearInterval(id);
  }, [check]);

  const abort = async () => {
    await core.abandonRecoveryClaim().catch(() => undefined);
    nav.replace('/setup');
  };

  return (
    <Screen
      title={t('setup.wait.title')}
      subtitle={t('setup.wait.lead')}
      footer={
        <Button
          label={t('setup.wait.abort')}
          variant="danger"
          onPress={() => setConfirmAbort(true)}
        />
      }
    >
      <View style={s.card}>
        <Hourglass size={32} color={th.color.accent} strokeWidth={1.75} />
        <Text variant="footnote" tone="secondary">
          {t('setup.wait.remaining')}
        </Text>
        {availableAtMs !== null && (
          <Countdown targetMs={availableAtMs} variant="largeTitle" onElapsed={check} />
        )}
        {checking && (
          <Text variant="footnote" tone="tertiary">
            {t('setup.wait.checking')}
          </Text>
        )}
      </View>
      <Banner kind="info" message={t('setup.wait.hint')} />
      {failure !== null && <Banner kind="danger" message={failure} />}
      <ConfirmDialog
        visible={confirmAbort}
        title={t('setup.wait.abortConfirmTitle')}
        message={t('setup.wait.abortConfirmBody')}
        confirmLabel={t('setup.wait.abort')}
        destructive
        onConfirm={abort}
        onCancel={() => setConfirmAbort(false)}
      />
    </Screen>
  );
}
