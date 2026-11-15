import { useLocalSearchParams } from 'expo-router';
import { CircleCheck, Hourglass, ShieldAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  Countdown,
  EmptyState,
  Screen,
  Skeleton,
  Text,
} from '../../components';
import { t } from '../../i18n';
import { formatDateTime, formatSpan } from '../../lib/format';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { makeStyles } from '../../theme';
import { useSession } from '../session/SessionProvider';
import { describeActionError, isRetryable } from '../settings/errors';
import { useAction } from '../settings/useAction';
import { approveClaimNow, type ClaimView, cancelClaim, loadClaim } from './claimFlows';

const useStyles = makeStyles((th) => ({
  counter: { alignItems: 'center', gap: th.space[2], paddingVertical: th.space[3] },
}));

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; retry: boolean }
  | { kind: 'view'; view: ClaimView }
  | { kind: 'done'; how: 'canceled' | 'approved' };

export function RecoveryClaimScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { core, api } = useSession();
  const s = useStyles();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmNow, setConfirmNow] = useState(false);
  const act = useAction();

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      setPhase({ kind: 'view', view: await loadClaim(api, String(id)) });
    } catch (e) {
      setPhase({
        kind: 'error',
        message: describeActionError(e) ?? t('error.unknown'),
        retry: isRetryable(e),
      });
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const leave = () => nav.replace('/');
  const open = phase.kind === 'view' && phase.view.status === 'open' ? phase.view : null;

  const cancel = async () => {
    setConfirmCancel(false);
    const ok = await act.run(async () => {
      await cancelClaim(core, api, String(id));
      return true;
    });
    if (ok) {
      haptics.success();
      setPhase({ kind: 'done', how: 'canceled' });
    }
  };
  const approveNow = async () => {
    setConfirmNow(false);
    const ok = await act.run(async () => {
      await approveClaimNow(core, api, String(id));
      return true;
    });
    if (ok) {
      haptics.success();
      setPhase({ kind: 'done', how: 'approved' });
    }
  };

  let body: React.ReactNode;
  if (phase.kind === 'loading') {
    body = <Skeleton height={160} radius={24} />;
  } else if (phase.kind === 'error') {
    body = (
      <EmptyState
        icon={ShieldAlert}
        title={t('claim.loadFailed')}
        message={phase.message}
        actionLabel={phase.retry ? t('common.retry') : t('common.close')}
        onAction={phase.retry ? load : leave}
      />
    );
  } else if (phase.kind === 'done') {
    body = (
      <EmptyState
        icon={CircleCheck}
        title={t(phase.how === 'canceled' ? 'claim.doneCanceled' : 'claim.doneApproved')}
        message={t(phase.how === 'canceled' ? 'claim.doneCanceledBody' : 'claim.doneApprovedBody')}
        actionLabel={phase.how === 'canceled' ? t('claim.goRecoveryCode') : t('common.close')}
        onAction={() =>
          phase.how === 'canceled' ? nav.replace('/settings/recovery-code') : leave()
        }
      />
    );
  } else if (open) {
    const availableMs = Date.parse(open.availableAt);
    body = (
      <>
        <Banner
          kind="warning"
          title={t('claim.bannerTitle')}
          message={t('claim.body', {
            started: formatDateTime(open.createdAt),
            remaining: formatSpan((availableMs - Date.now()) / 1000),
          })}
        />
        <Card>
          <View style={s.counter}>
            <Hourglass size={28} color="#888" />
            <Text variant="footnote" tone="secondary">
              {t('claim.remaining')}
            </Text>
            <Countdown targetMs={availableMs} variant="largeTitle" onElapsed={load} />
          </View>
        </Card>
        <Text variant="footnote" tone="secondary">
          {t('claim.hint')}
        </Text>
        {act.clockSkew && <Banner kind="warning" message={t('error.clockSkew')} />}
        {act.error !== null && !act.clockSkew && <Banner kind="danger" message={act.error} />}
      </>
    );
  } else {
    body = (
      <EmptyState
        icon={CircleCheck}
        title={t('claim.closed')}
        message={t('claim.closedBody')}
        actionLabel={t('common.close')}
        onAction={leave}
      />
    );
  }

  return (
    <Screen
      title={t('claim.title')}
      footer={
        open ? (
          <>
            <Button
              testID="claim-cancel"
              variant="danger"
              label={t('claim.cancel')}
              disabled={act.busy}
              onPress={() => setConfirmCancel(true)}
            />
            <Button
              testID="claim-now"
              variant="secondary"
              label={t('claim.approveNow')}
              disabled={act.busy}
              onPress={() => setConfirmNow(true)}
            />
          </>
        ) : undefined
      }
    >
      {body}
      <ConfirmDialog
        visible={confirmCancel}
        title={t('claim.cancelTitle')}
        message={t('claim.cancelBody')}
        confirmLabel={t('claim.cancelConfirm')}
        destructive
        loading={act.busy}
        onConfirm={cancel}
        onCancel={() => setConfirmCancel(false)}
      />
      <ConfirmDialog
        visible={confirmNow}
        title={t('claim.nowTitle')}
        message={t('claim.nowBody')}
        confirmLabel={t('claim.nowConfirm')}
        loading={act.busy}
        onConfirm={approveNow}
        onCancel={() => setConfirmNow(false)}
      />
    </Screen>
  );
}
