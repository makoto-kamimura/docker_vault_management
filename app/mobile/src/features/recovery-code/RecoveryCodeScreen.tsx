import type { RecoveryWaitSec } from '@localvault/core';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import {
  Banner,
  Button,
  Card,
  ConfirmDialog,
  ConsentRow,
  ListRow,
  Screen,
  Section,
  Skeleton,
  Text,
} from '../../components';
import { t } from '../../i18n';
import { FLAGS, getFlagStore } from '../../lib/flagStore';
import { formatDate } from '../../lib/format';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSession } from '../session/SessionProvider';
import { OptionSheet } from '../settings/OptionSheet';
import { labelFor, RC_WAIT_OPTIONS } from '../settings/options';
import { useAction } from '../settings/useAction';
import {
  disableRecoveryCodeFlow,
  getRcStatus,
  issueRecoveryCodeFlow,
  type RcStatus,
  setWaitFlow,
} from './flows';
import { sheetHolder } from './sheetHolder';

export function RecoveryCodeScreen() {
  const { core, api } = useSession();
  const [status, setStatus] = useState<RcStatus | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [consent, setConsent] = useState(false);
  const [wait, setWait] = useState<RecoveryWaitSec>(172800);
  const [picker, setPicker] = useState(false);
  const [confirm, setConfirm] = useState<'disable' | 'reissue' | null>(null);
  const [loadError, setLoadError] = useState(false);
  const act = useAction();

  const load = useCallback(() => {
    setLoadError(false);
    getRcStatus(api)
      .then((s) => {
        setStatus(s);
        if (s.enabled) setWait(s.waitSec);
      })
      .catch(() => setLoadError(true));
    getFlagStore()
      .get<boolean>(FLAGS.rcSheetUnconfirmed)
      .then((v) => setUnconfirmed(v === true))
      .catch(() => undefined);
  }, [api]);
  useFocusEffect(load);

  const issue = async () => {
    setConfirm(null);
    const sheet = await act.run(() => issueRecoveryCodeFlow({ core, api }, getFlagStore(), wait));
    if (!sheet) return;
    const info = await core.getAccountInfo();
    sheetHolder.put({
      sheet,
      waitSec: wait,
      serverUrl: info.serverUrl,
      accountName: info.accountName,
    });
    haptics.success();
    setConsent(false);
    nav.push('/settings/recovery-code/sheet');
  };

  const changeWait = async (v: RecoveryWaitSec) => {
    setWait(v);
    if (status?.enabled) {
      const ok = await act.run(async () => {
        await setWaitFlow({ core, api }, v);
        return true;
      });
      if (ok) load();
    }
  };

  const disable = async () => {
    setConfirm(null);
    const ok = await act.run(async () => {
      await disableRecoveryCodeFlow({ core, api }, getFlagStore());
      return true;
    });
    if (ok) {
      haptics.success();
      load();
    }
  };

  const errors = (
    <>
      {act.clockSkew && <Banner kind="warning" message={t('error.clockSkew')} />}
      {act.error !== null && !act.clockSkew && <Banner kind="danger" message={act.error} />}
    </>
  );

  return (
    <Screen title={t('rc.title')} subtitle={t('rc.lead')} onBack={nav.back}>
      {loadError && (
        <Banner
          kind="danger"
          message={t('rc.loadFailed')}
          actionLabel={t('common.retry')}
          onAction={load}
        />
      )}
      {status === null && !loadError && <Skeleton height={160} radius={20} />}
      {errors}

      {status?.enabled === false && (
        <>
          <Banner kind="warning" title={t('rc.warnTitle')} message={t('rc.warnBody')} />
          <Section title={t('rc.waitSection')} footer={t('rc.waitHint')}>
            <ListRow
              testID="rc-wait"
              title={t('rc.wait')}
              subtitle={t(labelFor(RC_WAIT_OPTIONS, wait) ?? 'rc.wait.48')}
              onPress={() => setPicker(true)}
            />
          </Section>
          <Section>
            <ConsentRow
              testID="rc-consent"
              title={t('rc.consent')}
              value={consent}
              onValueChange={setConsent}
            />
          </Section>
          <Button
            testID="rc-enable"
            label={t('rc.enable')}
            loading={act.busy}
            disabled={!consent}
            onPress={issue}
          />
        </>
      )}

      {status?.enabled === true && (
        <>
          {status.frozen && (
            <Banner kind="danger" title={t('rc.frozenTitle')} message={t('rc.frozenBody')} />
          )}
          {unconfirmed && <Banner kind="warning" message={t('rc.unconfirmed')} />}
          <Card>
            <View style={{ gap: 6 }}>
              <Text variant="callout" weight="semibold">
                {t('rc.statusOn')}
              </Text>
              <Text variant="footnote" tone="secondary">
                {t('rc.issuedOn', { date: formatDate(status.createdAt) })}
              </Text>
              <Text variant="footnote" tone="secondary">
                {unconfirmed ? t('rc.sheetNotConfirmed') : t('rc.sheetConfirmed')}
              </Text>
            </View>
          </Card>
          <Section title={t('rc.waitSection')} footer={t('rc.waitHint')}>
            <ListRow
              testID="rc-wait"
              title={t('rc.wait')}
              subtitle={t(labelFor(RC_WAIT_OPTIONS, wait) ?? 'rc.wait.48')}
              onPress={() => setPicker(true)}
            />
          </Section>
          <Button
            testID="rc-reissue"
            variant="secondary"
            label={t('rc.reissue')}
            disabled={act.busy}
            onPress={() => setConfirm('reissue')}
          />
          <Button
            testID="rc-disable"
            variant="danger"
            label={t('rc.disable')}
            disabled={act.busy}
            onPress={() => setConfirm('disable')}
          />
        </>
      )}

      <OptionSheet
        visible={picker}
        title="rc.wait"
        options={RC_WAIT_OPTIONS}
        value={wait}
        onSelect={changeWait}
        onClose={() => setPicker(false)}
      />
      <ConfirmDialog
        visible={confirm === 'disable'}
        title={t('rc.disableTitle')}
        message={t('rc.disableBody')}
        confirmLabel={t('rc.disable')}
        destructive
        onConfirm={disable}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        visible={confirm === 'reissue'}
        title={t('rc.reissueTitle')}
        message={t('rc.reissueBody')}
        confirmLabel={t('rc.reissue')}
        onConfirm={issue}
        onCancel={() => setConfirm(null)}
      />
    </Screen>
  );
}
