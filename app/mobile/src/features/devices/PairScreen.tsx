import { VaultCoreError } from '@localvault/core';
import { CircleCheck, ShieldAlert } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  QrScanner,
  Screen,
  Text,
  TextField,
} from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSession } from '../session/SessionProvider';
import { describeActionError } from '../settings/errors';
import { useAction } from '../settings/useAction';
import { confirmPairing, type PairPreview, preparePairing, validDeviceName } from './flows';

type Step =
  | { kind: 'scan' }
  | { kind: 'confirm'; preview: PairPreview }
  | { kind: 'alarm'; reason: 'fingerprint' | 'server' }
  | { kind: 'done'; name: string };

export function PairScreen() {
  const { core, api, engine } = useSession();
  const [step, setStep] = useState<Step>({ kind: 'scan' });
  const [name, setName] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const act = useAction();
  const scanning = useRef(false);

  const onScan = async (data: string) => {
    if (scanning.current) return;
    scanning.current = true;
    setScanError(null);
    try {
      const preview = await preparePairing(core, api, data);
      haptics.success();
      setName(preview.defaultName);
      setStep({ kind: 'confirm', preview });
    } catch (e) {
      haptics.error();
      if (e instanceof VaultCoreError && e.code === 'E_SERVER_MISMATCH') {
        setStep({ kind: 'alarm', reason: 'server' });
      } else if (e instanceof VaultCoreError && e.code === 'E_FINGERPRINT_MISMATCH') {
        setStep({ kind: 'alarm', reason: 'fingerprint' });
      } else if (e instanceof VaultCoreError && e.code === 'E_INVALID_INPUT') {
        setScanError(t('pair.notPairQr'));
      } else {
        setScanError(describeActionError(e) ?? t('error.unknown'));
      }
    } finally {
      // Allow another scan after a short pause so the same frame is not re-processed.
      setTimeout(() => {
        scanning.current = false;
      }, 1500);
    }
  };

  const approve = async (preview: PairPreview) => {
    const result = await act.run(async () => {
      try {
        await confirmPairing(
          { core, api, syncAfter: () => engine.requestSync('manual') },
          preview,
          name,
        );
        return 'ok' as const;
      } catch (e) {
        if (e instanceof VaultCoreError && e.code === 'E_FINGERPRINT_MISMATCH')
          return 'fingerprint';
        if (e instanceof VaultCoreError && e.code === 'E_SERVER_MISMATCH') return 'server';
        throw e;
      }
    });
    if (result === 'ok') {
      haptics.success();
      setStep({ kind: 'done', name: name.trim() });
    } else if (result) {
      haptics.error();
      setStep({ kind: 'alarm', reason: result });
    }
  };

  if (step.kind === 'alarm') {
    return (
      <Screen
        title={t('pair.alarmTitle')}
        footer={<Button variant="danger" label={t('common.close')} onPress={nav.back} />}
      >
        <EmptyState
          icon={ShieldAlert}
          title={t(step.reason === 'fingerprint' ? 'pair.fingerprintTitle' : 'pair.serverTitle')}
          message={t(step.reason === 'fingerprint' ? 'pair.fingerprintBody' : 'pair.serverBody')}
        />
        <Banner kind="danger" message={t('pair.alarmAdvice')} />
      </Screen>
    );
  }

  if (step.kind === 'done') {
    return (
      <Screen
        footer={
          <Button
            testID="pair-done"
            label={t('common.done')}
            onPress={() => nav.replace('/devices')}
          />
        }
      >
        <EmptyState
          icon={CircleCheck}
          title={t('pair.doneTitle')}
          message={t('pair.doneBody', { name: step.name })}
        />
      </Screen>
    );
  }

  if (step.kind === 'confirm') {
    const { preview } = step;
    return (
      <Screen
        title={t('pair.confirmTitle')}
        subtitle={t('pair.confirmLead')}
        onBack={() => setStep({ kind: 'scan' })}
        footer={
          <Button
            testID="pair-approve"
            label={t('pair.approve')}
            loading={act.busy}
            disabled={!validDeviceName(name)}
            onPress={() => approve(preview)}
          />
        }
      >
        <Card>
          <View style={{ gap: 4 }}>
            <Text variant="footnote" tone="secondary">
              {t('pair.browser')}
            </Text>
            <Text variant="callout">{preview.pairing.platform}</Text>
          </View>
        </Card>
        <TextField
          testID="pair-name"
          label={t('pair.nameLabel')}
          hint={t('pair.nameHint')}
          value={name}
          onChangeText={(v) => setName(v.slice(0, 64))}
          maxLength={64}
        />
        {act.clockSkew && <Banner kind="warning" message={t('error.clockSkew')} />}
        {act.error !== null && !act.clockSkew && <Banner kind="danger" message={act.error} />}
      </Screen>
    );
  }

  return (
    <Screen title={t('pair.title')} subtitle={t('pair.lead')} onBack={nav.back}>
      <QrScanner onScan={onScan} />
      {scanError !== null && <Banner kind="danger" message={scanError} />}
      <Text variant="footnote" tone="tertiary">
        {t('pair.hint')}
      </Text>
    </Screen>
  );
}
