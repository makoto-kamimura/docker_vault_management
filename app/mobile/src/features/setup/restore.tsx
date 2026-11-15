import { defaultProvider, parseRecoveryKey } from '@localvault/core';
import { normalizeAccountName } from '@localvault/protocol';
import { QrCode as QrIcon } from 'lucide-react-native';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { checkServerUrl } from '../../api';
import {
  BottomSheet,
  Button,
  PasswordField,
  QrScanner,
  RecoveryKeyInput,
  Screen,
  Text,
  TextField,
  useToast,
} from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { isRecoveryKeyComplete } from '../../lib/recoveryKeyInput';
import { useSetupDraft } from '../../state/setupDraft';
import { describeRestoreError } from '../errors/messages';
import { LongTaskNotice } from '../session/LongTaskNotice';
import { useSession } from '../session/SessionProvider';
import { accountNameError } from './create';
import { FlowInputError, parseKitScan, type RestoreProgress, restoreAccountFlow } from './flows';

type Form = { serverUrl: string; accountName: string; password: string; recoveryKey: string };

const STEPS: RestoreProgress[] = ['verify', 'keys', 'sync'];

export function RestoreScreen() {
  const { core, makeApi, engine } = useSession();
  const draft = useSetupDraft();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<RestoreProgress>('verify');
  const [scanning, setScanning] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const { control, handleSubmit, setValue } = useForm<Form>({
    defaultValues: {
      serverUrl: draft.serverUrl,
      accountName: draft.accountName,
      password: '',
      recoveryKey: '',
    },
  });

  const submit = handleSubmit(async (v) => {
    setKeyError(null);
    const url = checkServerUrl(v.serverUrl);
    if (!url.ok) {
      toast.error(t('setup.server.error.invalid'));
      return;
    }
    setBusy(true);
    draft.setInProgress(true);
    try {
      await restoreAccountFlow({
        core,
        makeApi,
        serverUrl: url.origin,
        accountName: v.accountName,
        masterPassword: v.password,
        recoveryKey: v.recoveryKey,
        onProgress: setStep,
      });
      const name = normalizeAccountName(v.accountName);
      if (name.ok) draft.setAccountName(name.name);
      haptics.success();
      void engine.requestSync('launch');
      nav.replace('/setup/biometrics');
    } catch (e) {
      draft.setInProgress(false);
      haptics.error();
      if (
        e &&
        typeof e === 'object' &&
        'code' in e &&
        (e as { code: string }).code === 'E_INVALID_RECOVERY_KEY'
      ) {
        setKeyError(t('error.invalidRecoveryKey'));
      } else if (e instanceof FlowInputError) {
        toast.error(t('setup.create.error.accountChars'));
      } else {
        toast.error(describeRestoreError(e));
      }
    } finally {
      setBusy(false);
    }
  });

  const onScan = (data: string) => {
    try {
      const kit = parseKitScan(data);
      setValue('serverUrl', kit.serverUrl);
      setValue('accountName', kit.accountName);
      setValue('recoveryKey', kit.recoveryKey);
      setScanning(false);
    } catch {
      toast.error(t('setup.restore.scanBad'));
    }
  };

  return (
    <Screen
      title={t('setup.restore.title')}
      subtitle={t('setup.restore.lead')}
      onBack={busy ? undefined : nav.back}
      footer={
        <Button
          testID="restore-submit"
          label={busy ? t('setup.restore.submitting') : t('setup.restore.submit')}
          loading={busy}
          onPress={submit}
        />
      }
    >
      <LongTaskNotice
        active={busy}
        steps={[
          t('setup.restore.step.verify'),
          t('setup.restore.step.keys'),
          t('setup.restore.step.sync'),
        ]}
        current={STEPS.indexOf(step)}
      />
      <Button
        testID="restore-scan"
        variant="secondary"
        icon={QrIcon}
        label={t('setup.restore.scan')}
        onPress={() => setScanning(true)}
        disabled={busy}
      />
      <Controller
        control={control}
        name="serverUrl"
        rules={{ validate: (x) => checkServerUrl(x).ok || t('setup.server.error.invalid') }}
        render={({ field, fieldState }) => (
          <TextField
            label={t('setup.server.urlLabel')}
            value={field.value}
            onChangeText={field.onChange}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('setup.server.urlPlaceholder')}
            error={fieldState.error?.message}
          />
        )}
      />
      <Controller
        control={control}
        name="accountName"
        rules={{ validate: accountNameError }}
        render={({ field, fieldState }) => (
          <TextField
            label={t('setup.create.accountName')}
            value={field.value}
            onChangeText={field.onChange}
            autoCapitalize="none"
            autoCorrect={false}
            error={fieldState.error?.message}
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        rules={{ validate: (x) => x.length > 0 || t('setup.create.error.passwordShort') }}
        render={({ field, fieldState }) => (
          <PasswordField
            label={t('setup.create.password')}
            value={field.value}
            onChangeText={field.onChange}
            error={fieldState.error?.message}
          />
        )}
      />
      <Controller
        control={control}
        name="recoveryKey"
        rules={{
          validate: async (x) => {
            if (!isRecoveryKeyComplete(x)) return t('error.invalidRecoveryKey');
            try {
              await parseRecoveryKey(defaultProvider(), x);
              return true;
            } catch {
              return t('error.invalidRecoveryKey');
            }
          },
        }}
        render={({ field, fieldState }) => (
          <RecoveryKeyInput
            label={t('setup.restore.recoveryKey')}
            hint={t('setup.restore.recoveryKeyHint')}
            value={field.value}
            onChange={(x) => {
              setKeyError(null);
              field.onChange(x);
            }}
            error={keyError ?? fieldState.error?.message}
          />
        )}
      />
      <BottomSheet
        visible={scanning}
        onClose={() => setScanning(false)}
        title={t('setup.restore.scanTitle')}
      >
        <QrScanner onScan={onScan} active={scanning} />
        <Text variant="footnote" tone="tertiary" align="center">
          {t('qr.hint')}
        </Text>
      </BottomSheet>
    </Screen>
  );
}
