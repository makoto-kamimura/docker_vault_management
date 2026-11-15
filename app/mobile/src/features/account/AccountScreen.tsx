import { useLocalSearchParams } from 'expo-router';
import {
  FileKey,
  KeyRound,
  LifeBuoy,
  LogOut,
  RotateCw,
  ShieldQuestion,
  Trash2,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
  Banner,
  Button,
  ListRow,
  PasswordField,
  RecoveryKeyInput,
  Screen,
  Section,
  StrengthMeter,
  Text,
  TextField,
  useToast,
} from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { estimateStrength } from '../../lib/passwordStrength';
import { isRecoveryKeyComplete } from '../../lib/recoveryKeyInput';
import { isLastApprover } from '../devices/flows';
import { useSession } from '../session/SessionProvider';
import { useAction } from '../settings/useAction';
import {
  accountNameMatches,
  changeMasterPasswordFlow,
  deleteAccountFlow,
  loadEmergencyKit,
  regenerateRecoveryKeyFlow,
  resetMasterPasswordFlow,
  signOutFlow,
} from './flows';
import { type KitData, KitView } from './KitView';

type Mode = 'menu' | 'password' | 'regenerate' | 'forgot' | 'kit' | 'signout' | 'delete';

export function AccountScreen() {
  const { signout } = useLocalSearchParams<{ signout?: string }>();
  const { core, api } = useSession();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(signout === '1' ? 'signout' : 'menu');
  const [kit, setKit] = useState<(KitData & { title: string }) | null>(null);
  const [accountName, setAccountName] = useState('');
  const [lastApprover, setLastApprover] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [typedName, setTypedName] = useState('');
  const act = useAction();

  useEffect(() => {
    core
      .getAccountInfo()
      .then((i) => setAccountName(i.accountName))
      .catch(() => undefined);
    core
      .listDevices()
      .then((d) => setLastApprover(isLastApprover(d)))
      .catch(() => undefined);
  }, [core]);

  const reset = (to: Mode) => {
    // Secrets never outlive the form they were typed in.
    setCurrent('');
    setNext('');
    setAgain('');
    setRecoveryKey('');
    setTypedName('');
    act.clear();
    setMode(to);
  };

  const strong = estimateStrength(next).meetsMinimum;
  const same = next !== '' && next === again;

  const changePassword = async () => {
    const ok = await act.run(async () => {
      await changeMasterPasswordFlow({ core, api }, current, next);
      return true;
    });
    if (ok) {
      haptics.success();
      toast.success(t('acct.passwordChanged'));
      reset('menu');
    }
  };

  const regenerate = async () => {
    const key = await act.run(() => regenerateRecoveryKeyFlow({ core, api }, current));
    if (key) {
      const info = await core.getAccountInfo();
      setKit({
        serverUrl: info.serverUrl,
        accountName: info.accountName,
        recoveryKey: key,
        title: t('acct.newKitTitle'),
      });
      reset('kit');
    }
  };

  const recreateKit = async () => {
    const data = await act.run(() => loadEmergencyKit(core));
    if (data) {
      setKit({ ...data, title: t('acct.kitTitle') });
      setMode('kit');
    }
  };

  const forgot = async () => {
    const ok = await act.run(async () => {
      await resetMasterPasswordFlow({ core, api }, recoveryKey, next);
      return true;
    });
    if (ok) {
      haptics.success();
      toast.success(t('acct.passwordChanged'));
      reset('menu');
    }
  };

  const signOut = async () => {
    // The lock state change to "uninitialized" sends the user to /setup.
    await act.run(() => signOutFlow({ core, api }));
  };

  const deleteAccount = async () => {
    const ok = await act.run(async () => {
      await deleteAccountFlow({ core, api }, current);
      return true;
    });
    if (ok) haptics.success();
  };

  if (mode === 'kit' && kit) {
    return (
      <KitView
        kit={kit}
        title={kit.title}
        onDone={() => {
          setKit(null);
          reset('menu');
        }}
      />
    );
  }

  const errors = (
    <>
      {act.clockSkew && <Banner kind="warning" message={t('error.clockSkew')} />}
      {act.error !== null && !act.clockSkew && <Banner kind="danger" message={act.error} />}
    </>
  );

  if (mode === 'password') {
    return (
      <Screen
        title={t('acct.changePassword')}
        onBack={() => reset('menu')}
        footer={
          <Button
            testID="acct-pw-submit"
            label={t('acct.changePassword')}
            loading={act.busy}
            disabled={current === '' || !strong || !same}
            onPress={changePassword}
          />
        }
      >
        <PasswordField
          testID="acct-pw-current"
          label={t('acct.currentPassword')}
          value={current}
          onChangeText={setCurrent}
        />
        <PasswordField
          testID="acct-pw-new"
          label={t('acct.newPassword')}
          value={next}
          onChangeText={setNext}
          meter={<StrengthMeter password={next} />}
          error={next !== '' && !strong ? t('setup.create.error.passwordShort') : null}
        />
        <PasswordField
          testID="acct-pw-again"
          label={t('acct.repeatPassword')}
          value={again}
          onChangeText={setAgain}
          error={again !== '' && !same ? t('setup.create.error.mismatch') : null}
        />
        <Banner kind="info" message={t('acct.passwordNote')} />
        {errors}
      </Screen>
    );
  }

  if (mode === 'regenerate') {
    return (
      <Screen
        title={t('acct.regenerate')}
        subtitle={t('acct.regenerateLead')}
        onBack={() => reset('menu')}
        footer={
          <Button
            testID="acct-regen-submit"
            variant="danger"
            label={t('acct.regenerate')}
            loading={act.busy}
            disabled={current === ''}
            onPress={regenerate}
          />
        }
      >
        <Banner kind="warning" message={t('acct.regenerateWarn')} />
        <PasswordField
          testID="acct-regen-pw"
          label={t('acct.currentPassword')}
          value={current}
          onChangeText={setCurrent}
        />
        {errors}
      </Screen>
    );
  }

  if (mode === 'forgot') {
    return (
      <Screen
        title={t('acct.forgot')}
        subtitle={t('acct.forgotLead')}
        onBack={() => reset('menu')}
        footer={
          <Button
            testID="acct-forgot-submit"
            label={t('acct.forgotSubmit')}
            loading={act.busy}
            disabled={!isRecoveryKeyComplete(recoveryKey) || !strong || !same}
            onPress={forgot}
          />
        }
      >
        <RecoveryKeyInput
          label={t('setup.restore.recoveryKey')}
          value={recoveryKey}
          onChange={setRecoveryKey}
        />
        <PasswordField
          label={t('acct.newPassword')}
          value={next}
          onChangeText={setNext}
          meter={<StrengthMeter password={next} />}
        />
        <PasswordField
          label={t('acct.repeatPassword')}
          value={again}
          onChangeText={setAgain}
          error={again !== '' && !same ? t('setup.create.error.mismatch') : null}
        />
        {errors}
      </Screen>
    );
  }

  if (mode === 'signout') {
    return (
      <Screen
        title={t('acct.signOut')}
        subtitle={t('acct.signOutLead')}
        onBack={() => reset('menu')}
        footer={
          <Button
            testID="acct-signout-confirm"
            variant="danger"
            label={t('acct.signOutConfirm')}
            loading={act.busy}
            onPress={signOut}
          />
        }
      >
        {lastApprover && (
          <Banner
            kind="warning"
            title={t('acct.lastApproverTitle')}
            message={t('acct.lastApproverBody')}
          />
        )}
        <Banner kind="info" message={t('acct.signOutNote')} />
        {errors}
      </Screen>
    );
  }

  if (mode === 'delete') {
    const nameOk = accountNameMatches(typedName, accountName);
    return (
      <Screen
        title={t('acct.delete')}
        subtitle={t('acct.deleteLead')}
        onBack={() => reset('menu')}
        footer={
          <Button
            testID="acct-delete-confirm"
            variant="danger"
            label={t('acct.deleteConfirm')}
            loading={act.busy}
            disabled={!nameOk || current === ''}
            onPress={deleteAccount}
          />
        }
      >
        <Banner kind="danger" message={t('acct.deleteWarn')} />
        <TextField
          testID="acct-delete-name"
          label={t('acct.deleteNameLabel', { name: accountName })}
          value={typedName}
          onChangeText={setTypedName}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <PasswordField
          testID="acct-delete-pw"
          label={t('acct.currentPassword')}
          value={current}
          onChangeText={setCurrent}
        />
        {errors}
      </Screen>
    );
  }

  return (
    <Screen
      title={t('acct.title')}
      subtitle={accountName ? t('acct.signedInAs', { name: accountName }) : undefined}
      onBack={nav.back}
    >
      {errors}
      <Section title={t('acct.secKeys')}>
        <ListRow
          testID="acct-change-pw"
          icon={KeyRound}
          title={t('acct.changePassword')}
          onPress={() => reset('password')}
        />
        <ListRow
          testID="acct-regen"
          icon={RotateCw}
          title={t('acct.regenerate')}
          onPress={() => reset('regenerate')}
        />
        <ListRow
          testID="acct-kit"
          icon={FileKey}
          title={t('acct.kit')}
          subtitle={t('acct.kitHint')}
          onPress={recreateKit}
        />
        <ListRow
          testID="acct-forgot"
          icon={ShieldQuestion}
          title={t('acct.forgot')}
          onPress={() => reset('forgot')}
        />
      </Section>
      <Section>
        <ListRow
          icon={LifeBuoy}
          title={t('set.recoveryCode')}
          onPress={() => nav.push('/settings/recovery-code')}
        />
      </Section>
      <Section title={t('acct.secDanger')}>
        <ListRow
          testID="acct-signout"
          icon={LogOut}
          destructive
          title={t('acct.signOut')}
          onPress={() => reset('signout')}
        />
        <ListRow
          testID="acct-delete"
          icon={Trash2}
          destructive
          title={t('acct.delete')}
          onPress={() => reset('delete')}
        />
      </Section>
      <Text variant="footnote" tone="tertiary">
        {t('acct.footer')}
      </Text>
    </Screen>
  );
}
