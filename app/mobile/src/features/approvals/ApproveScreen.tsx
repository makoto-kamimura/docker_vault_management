import { useLocalSearchParams } from 'expo-router';
import { CircleCheck, Hourglass, Monitor, ShieldAlert } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Countdown,
  DigitCodeInput,
  EmptyState,
  Screen,
  Skeleton,
  Text,
} from '../../components';
import { t } from '../../i18n';
import { formatClock } from '../../lib/format';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { makeStyles, useTheme } from '../../theme';
import { useSession } from '../session/SessionProvider';
import { describeActionError, isRetryable } from '../settings/errors';
import { useAction } from '../settings/useAction';
import {
  type ApprovalDeps,
  approveUnlockRequest,
  denyUnlockRequest,
  type LoadedRequest,
  loadUnlockRequest,
} from './flows';

const useStyles = makeStyles((th) => ({
  hero: { alignItems: 'center', gap: th.space[3], paddingVertical: th.space[4] },
  badge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: th.color.accentSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
}));

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; retry: boolean }
  | { kind: 'loaded'; data: LoadedRequest }
  | { kind: 'done'; how: 'approved' | 'denied' };

export function ApproveScreen() {
  const { requestId } = useLocalSearchParams<{ requestId: string }>();
  const { core, api, engine } = useSession();
  const s = useStyles();
  const th = useTheme();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [confirmUnknown, setConfirmUnknown] = useState(false);
  const act = useAction();
  const deps = useRef<ApprovalDeps>({
    core,
    api,
    syncFirst: () => engine.requestSync('manual'),
  });

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const data = await loadUnlockRequest(deps.current, String(requestId));
      setPhase({ kind: 'loaded', data });
    } catch (e) {
      setPhase({
        kind: 'error',
        message: describeActionError(e) ?? t('error.unknown'),
        retry: isRetryable(e),
      });
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The typed code never outlives the screen.
  useEffect(() => () => setCode(''), []);

  const leave = () => nav.replace('/');
  const ready = phase.kind === 'loaded' && phase.data.status === 'ready' ? phase.data : null;

  const approve = async () => {
    if (!ready) return;
    const outcome = await act.run(() => approveUnlockRequest(deps.current, ready.request, code));
    if (!outcome) return;
    if (outcome.status === 'approved') {
      haptics.success();
      setPhase({ kind: 'done', how: 'approved' });
    } else if (outcome.status === 'mismatch') {
      haptics.error();
      setCode('');
      setCodeError(t('approve.mismatch', { n: outcome.attemptsLeft }));
    } else {
      haptics.error();
      setCode('');
      setPhase({ kind: 'done', how: 'denied' });
    }
  };

  const deny = async () => {
    if (!ready) return;
    const ok = await act.run(async () => {
      await denyUnlockRequest(deps.current, ready.request.requestId);
      return true;
    });
    if (ok) setPhase({ kind: 'done', how: 'denied' });
  };

  const notMine = async () => {
    if (!ready) return;
    setConfirmUnknown(false);
    const ok = await act.run(async () => {
      await denyUnlockRequest(deps.current, ready.request.requestId);
      return true;
    });
    if (ok) nav.replace(`/devices/${ready.request.deviceId}?revoke=1`);
  };

  let body: React.ReactNode;
  if (phase.kind === 'loading') {
    body = (
      <View style={{ gap: 16 }} accessibilityLabel={t('common.loading')}>
        <Skeleton height={96} radius={24} />
        <Skeleton height={64} radius={16} />
      </View>
    );
  } else if (phase.kind === 'error') {
    body = (
      <EmptyState
        icon={ShieldAlert}
        title={t('approve.loadFailed')}
        message={phase.message}
        actionLabel={phase.retry ? t('common.retry') : t('common.close')}
        onAction={phase.retry ? load : leave}
      />
    );
  } else if (phase.kind === 'done') {
    body = (
      <EmptyState
        icon={CircleCheck}
        title={t(phase.how === 'approved' ? 'approve.doneApproved' : 'approve.doneDenied')}
        message={t(
          phase.how === 'approved' ? 'approve.doneApprovedBody' : 'approve.doneDeniedBody',
        )}
        actionLabel={t('common.close')}
        onAction={leave}
      />
    );
  } else if (phase.data.status === 'expired') {
    body = (
      <EmptyState
        icon={Hourglass}
        title={t('approve.expired')}
        message={t('approve.expiredBody')}
        actionLabel={t('common.close')}
        onAction={leave}
      />
    );
  } else if (phase.data.status === 'gone') {
    body = (
      <EmptyState
        icon={CircleCheck}
        title={t('approve.gone')}
        message={t('approve.goneBody')}
        actionLabel={t('common.close')}
        onAction={leave}
      />
    );
  } else if (phase.data.status === 'invalid') {
    body = (
      <EmptyState
        icon={ShieldAlert}
        title={t('approve.invalid')}
        message={t(`approve.invalid.${phase.data.reason}`)}
        actionLabel={t('common.close')}
        onAction={leave}
      />
    );
  } else if (ready) {
    const expiresMs = Date.parse(ready.request.expiresAt);
    body = (
      <>
        <View style={s.hero}>
          <View style={s.badge}>
            <Monitor size={34} color={th.color.accent} strokeWidth={1.75} />
          </View>
          <Text variant="title2" align="center" accessibilityRole="header">
            {t('approve.title', { name: ready.deviceName })}
          </Text>
        </View>
        <Card>
          <View style={s.meta}>
            <Text variant="footnote" tone="secondary">
              {t('approve.requestedAt', { time: formatClock(ready.request.payload.issuedAt) })}
            </Text>
            <View style={{ alignItems: 'flex-end' }}>
              <Text variant="caption" tone="tertiary">
                {t('approve.remaining')}
              </Text>
              <Countdown
                targetMs={expiresMs}
                variant="callout"
                tone="accent"
                onElapsed={() => setPhase({ kind: 'loaded', data: { status: 'expired' } })}
              />
            </View>
          </View>
        </Card>
        <DigitCodeInput
          label={t('approve.codeLabel')}
          value={code}
          onChange={(v) => {
            setCode(v);
            setCodeError(null);
          }}
          length={2}
          error={codeError}
          autoFocus
        />
        {act.clockSkew && <Banner kind="warning" message={t('error.clockSkew')} />}
        {act.error !== null && !act.clockSkew && <Banner kind="danger" message={act.error} />}
      </>
    );
  }

  return (
    <Screen
      title={ready ? undefined : t('approve.screenTitle')}
      footer={
        ready ? (
          <>
            <Button
              testID="approve-confirm"
              label={t('approve.approve')}
              disabled={code.length !== 2}
              loading={act.busy}
              onPress={approve}
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Button
                  testID="approve-deny"
                  variant="secondary"
                  label={t('approve.deny')}
                  disabled={act.busy}
                  onPress={deny}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  testID="approve-unknown"
                  variant="danger"
                  label={t('approve.notMine')}
                  disabled={act.busy}
                  onPress={() => setConfirmUnknown(true)}
                />
              </View>
            </View>
          </>
        ) : undefined
      }
    >
      {body}
      <ConfirmDialog
        visible={confirmUnknown}
        title={t('approve.notMineTitle')}
        message={t('approve.notMineBody')}
        confirmLabel={t('approve.notMineConfirm')}
        destructive
        onConfirm={notMine}
        onCancel={() => setConfirmUnknown(false)}
      />
    </Screen>
  );
}
