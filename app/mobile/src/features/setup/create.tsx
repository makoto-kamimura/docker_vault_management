import { normalizeAccountName } from '@localvault/protocol';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Button,
  PasswordField,
  Screen,
  StrengthMeter,
  TextField,
  useToast,
} from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { estimateStrength } from '../../lib/passwordStrength';
import { useSetupDraft } from '../../state/setupDraft';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';
import { createAccountFlow } from './flows';

type Form = { invite: string; accountName: string; password: string; confirm: string };

export function accountNameError(input: string): string | true {
  const r = normalizeAccountName(input);
  if (r.ok) return true;
  return {
    too_short: t('setup.create.error.accountTooShort'),
    too_long: t('setup.create.error.accountTooLong'),
    bad_chars: t('setup.create.error.accountChars'),
    bad_edge: t('setup.create.error.accountEdge'),
  }[r.reason];
}

export function CreateScreen() {
  const { core, makeApi } = useSession();
  const draft = useSetupDraft();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const needsInvite = draft.registrationMode !== 'open';
  const { control, handleSubmit, watch } = useForm<Form>({
    defaultValues: { invite: '', accountName: draft.accountName, password: '', confirm: '' },
    mode: 'onSubmit',
  });
  const password = watch('password');

  const submit = handleSubmit(async (v) => {
    setBusy(true);
    draft.setInProgress(true);
    try {
      const name = normalizeAccountName(v.accountName);
      const { recoveryKey } = await createAccountFlow({
        core,
        makeApi,
        serverUrl: draft.serverUrl,
        accountName: v.accountName,
        masterPassword: v.password,
        inviteCode: v.invite,
      });
      if (name.ok) draft.setAccountName(name.name);
      draft.setRecoveryKey(recoveryKey);
      haptics.success();
      nav.replace('/setup/recovery-kit');
    } catch (e) {
      draft.setInProgress(false);
      haptics.error();
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  });

  return (
    <Screen
      title={t('setup.create.title')}
      subtitle={t('setup.create.lead')}
      onBack={nav.back}
      footer={
        <Button
          testID="create-submit"
          label={busy ? t('setup.create.submitting') : t('setup.create.submit')}
          loading={busy}
          onPress={submit}
        />
      }
    >
      {needsInvite && (
        <Controller
          control={control}
          name="invite"
          rules={{ validate: (v) => v.trim() !== '' || t('setup.create.error.inviteRequired') }}
          render={({ field, fieldState }) => (
            <TextField
              testID="create-invite"
              label={t('setup.create.invite')}
              value={field.value}
              onChangeText={field.onChange}
              autoCapitalize="none"
              autoCorrect={false}
              error={fieldState.error?.message}
            />
          )}
        />
      )}
      <Controller
        control={control}
        name="accountName"
        rules={{ validate: accountNameError }}
        render={({ field, fieldState }) => (
          <TextField
            testID="create-account"
            label={t('setup.create.accountName')}
            hint={t('setup.create.accountNameHint')}
            value={field.value}
            onChangeText={field.onChange}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textContentType="username"
            error={fieldState.error?.message}
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        rules={{
          validate: (v) =>
            estimateStrength(v).meetsMinimum || t('setup.create.error.passwordShort'),
        }}
        render={({ field, fieldState }) => (
          <PasswordField
            testID="create-password"
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
        rules={{ validate: (v) => v === password || t('setup.create.error.mismatch') }}
        render={({ field, fieldState }) => (
          <PasswordField
            testID="create-confirm"
            label={t('setup.create.confirm')}
            value={field.value}
            onChangeText={field.onChange}
            error={fieldState.error?.message}
          />
        )}
      />
    </Screen>
  );
}
