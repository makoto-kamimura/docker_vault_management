import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Banner, Button, PasswordField, Screen, StrengthMeter, useToast } from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { estimateStrength } from '../../lib/passwordStrength';
import { useSetupDraft } from '../../state/setupDraft';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';
import { setNewPasswordAfterRecoveryFlow } from './flows';

export function NewPasswordScreen() {
  const { core, makeApi } = useSession();
  const draft = useSetupDraft();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { control, handleSubmit, watch } = useForm<{ password: string; confirm: string }>({
    defaultValues: { password: '', confirm: '' },
  });
  const password = watch('password');

  const submit = handleSubmit(async (v) => {
    setBusy(true);
    try {
      const info = await core.getAccountInfo();
      const { recoveryKey } = await setNewPasswordAfterRecoveryFlow({
        core,
        makeApi,
        serverUrl: info.serverUrl,
        newPassword: v.password,
      });
      draft.setServer(info.serverUrl, 'open');
      draft.setAccountName(info.accountName);
      draft.setRecoveryKey(recoveryKey);
      haptics.success();
      nav.replace('/setup/recovery-kit');
    } catch (e) {
      haptics.error();
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <Screen
      title={t('setup.newPassword.title')}
      subtitle={t('setup.newPassword.lead')}
      footer={
        <Button
          label={busy ? t('setup.newPassword.submitting') : t('setup.newPassword.submit')}
          loading={busy}
          onPress={submit}
        />
      }
    >
      <Controller
        control={control}
        name="password"
        rules={{
          validate: (x) =>
            estimateStrength(x).meetsMinimum || t('setup.create.error.passwordShort'),
        }}
        render={({ field, fieldState }) => (
          <PasswordField
            label={t('setup.create.password')}
            hint={t('setup.create.passwordHint')}
            value={field.value}
            onChangeText={field.onChange}
            error={fieldState.error?.message}
            meter={<StrengthMeter password={password} />}
          />
        )}
      />
      <Controller
        control={control}
        name="confirm"
        rules={{ validate: (x) => x === password || t('setup.create.error.mismatch') }}
        render={({ field, fieldState }) => (
          <PasswordField
            label={t('setup.create.confirm')}
            value={field.value}
            onChangeText={field.onChange}
            error={fieldState.error?.message}
          />
        )}
      />
      <Banner kind="info" message={t('setup.newPassword.next')} />
    </Screen>
  );
}
