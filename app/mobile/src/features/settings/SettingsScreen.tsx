import type { Settings } from '@localvault/core';
import { useFocusEffect } from 'expo-router';
import {
  Archive,
  Clipboard,
  Clock,
  Fingerprint,
  Globe,
  HelpCircle,
  History,
  LifeBuoy,
  LogOut,
  Monitor,
  Scale,
  Server,
  ShieldCheck,
  Smartphone,
  Upload,
  UserRound,
} from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { Badge, Banner, ListRow, Screen, Section, SwitchRow, Text } from '../../components';
import { t } from '../../i18n';
import { formatDate } from '../../lib/format';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSyncStore } from '../../state/syncStore';
import { useSession } from '../session/SessionProvider';
import { patchSettings, reenrollBiometrics, setBiometrics } from './flows';
import { OptionSheet } from './OptionSheet';
import { AUTO_LOCK_OPTIONS, CLIPBOARD_OPTIONS, labelFor, PC_SESSION_OPTIONS } from './options';
import { useAction } from './useAction';

type Loaded = {
  settings: Settings;
  bio: { available: boolean; kind: string };
  autofill: { supported: boolean; enabled: boolean };
  lastExportAt: string | null;
  serverUrl: string;
  version: string | null;
  rc: 'on' | 'off' | 'frozen' | 'unknown';
};

type Picker = 'autoLock' | 'clipboard' | 'pcSession' | null;

export function SettingsScreen() {
  const { core, api } = useSession();
  const [data, setData] = useState<Loaded | null>(null);
  const [picker, setPicker] = useState<Picker>(null);
  const [bioInvalid, setBioInvalid] = useState(false);
  const sync = useSyncStore((s) => s.status);
  const act = useAction();
  const android = Platform.OS === 'android';

  const load = useCallback(() => {
    (async () => {
      const [settings, bio, autofill, backup, account] = await Promise.all([
        core.getSettings(),
        core.getBiometricAvailability(),
        core.getAutofillStatus().catch(() => ({ supported: false, enabled: false })),
        core.getBackupInfo().catch(() => ({ lastExportAt: null })),
        core.getAccountInfo(),
      ]);
      const [health, rc] = await Promise.all([
        api
          .call('health')
          .then((h) => h.version)
          .catch(() => null),
        api
          .call('getRecoveryCode')
          .then((r) =>
            r.enabled ? (r.frozen ? ('frozen' as const) : ('on' as const)) : ('off' as const),
          )
          .catch(() => 'unknown' as const),
      ]);
      setData({
        settings,
        bio,
        autofill,
        lastExportAt: backup.lastExportAt,
        serverUrl: account.serverUrl,
        version: health,
        rc,
      });
    })().catch(() => undefined);
  }, [core, api]);
  useFocusEffect(load);

  if (!data) {
    return (
      <Screen title={t('set.title')} onBack={nav.back}>
        {null}
      </Screen>
    );
  }

  const update = (patch: Partial<Settings>) =>
    act.run(async () => {
      const next = await patchSettings(core, patch);
      setData((d) => (d ? { ...d, settings: next } : d));
      haptics.select();
    });

  const toggleBio = (on: boolean) =>
    act.run(async () => {
      const r = await setBiometrics(core, on);
      if (r.ok) {
        setData((d) => (d ? { ...d, settings: { ...d.settings, biometricsEnabled: on } } : d));
        setBioInvalid(false);
      } else if (r.reason === 'invalidated') {
        setData((d) => (d ? { ...d, settings: { ...d.settings, biometricsEnabled: false } } : d));
        setBioInvalid(true);
        haptics.warning();
      }
    });

  const reenroll = () =>
    act.run(async () => {
      const r = await reenrollBiometrics(core);
      setBioInvalid(!r.ok && r.reason === 'invalidated');
      setData((d) => (d ? { ...d, settings: { ...d.settings, biometricsEnabled: r.ok } } : d));
      if (r.ok) haptics.success();
    });

  const enableAutofill = () =>
    act.run(async () => {
      const ok = await core.requestEnableAutofill();
      setData((d) => (d ? { ...d, autofill: { ...d.autofill, enabled: ok } } : d));
    });

  const s = data.settings;
  const bioLabel =
    data.bio.kind === 'faceId'
      ? t('setup.bio.kind.faceId')
      : data.bio.kind === 'touchId'
        ? t('setup.bio.kind.touchId')
        : t('setup.bio.kind.biometric');
  const syncText =
    sync.kind === 'synced' ||
    sync.kind === 'syncing' ||
    sync.kind === 'offline' ||
    sync.kind === 'error' ||
    sync.kind === 'rollback'
      ? t(`sync.${sync.kind}`)
      : '';
  const rcText = {
    on: t('set.rc.on'),
    off: t('set.rc.off'),
    frozen: t('set.rc.frozen'),
    unknown: '',
  }[data.rc];

  return (
    <Screen title={t('set.title')} onBack={nav.back} testID="settings-screen">
      {act.error !== null && <Banner kind="danger" message={act.error} />}
      {bioInvalid && (
        <Banner
          kind="warning"
          title={t('set.bio.invalidTitle')}
          message={t('set.bio.invalidBody')}
          actionLabel={t('set.bio.reenroll')}
          onAction={reenroll}
        />
      )}

      <Section title={t('set.sec.security')}>
        <ListRow
          testID="set-autolock"
          icon={Clock}
          title={t('set.autoLock')}
          subtitle={t(labelFor(AUTO_LOCK_OPTIONS, s.autoLockSec) ?? 'set.autoLock.60')}
          onPress={() => setPicker('autoLock')}
        />
        <ListRow
          testID="set-clipboard"
          icon={Clipboard}
          title={t('set.clipboard')}
          subtitle={t(labelFor(CLIPBOARD_OPTIONS, s.clipboardClearSec) ?? 'set.clip.never')}
          onPress={() => setPicker('clipboard')}
        />
        {data.bio.available && (
          <SwitchRow
            testID="set-bio"
            title={t('set.bio', { kind: bioLabel })}
            subtitle={t('set.bio.hint')}
            value={data.settings.biometricsEnabled}
            onValueChange={toggleBio}
          />
        )}
        <SwitchRow
          testID="set-showuser"
          title={t('set.showUsername')}
          subtitle={t('set.showUsername.hint')}
          value={s.showUsernameBeforeAuth}
          onValueChange={(v) => update({ showUsernameBeforeAuth: v })}
        />
      </Section>

      <Section
        title={t('set.sec.autofill')}
        footer={android ? t('set.autofill.androidChrome') : undefined}
      >
        <ListRow
          icon={Fingerprint}
          title={t('set.autofill')}
          subtitle={
            !data.autofill.supported
              ? t('setup.autofill.status.unsupported')
              : data.autofill.enabled
                ? t('setup.autofill.status.on')
                : t('setup.autofill.status.off')
          }
          chevron={false}
          trailing={
            data.autofill.enabled ? <Badge label={t('setup.autofill.status.on')} /> : undefined
          }
        />
        {data.autofill.supported && !data.autofill.enabled && (
          <ListRow
            testID="set-autofill-enable"
            icon={ShieldCheck}
            title={t('setup.autofill.enable')}
            onPress={enableAutofill}
          />
        )}
        {android && (
          <ListRow
            testID="set-trusted"
            icon={Globe}
            title={t('set.trusted')}
            onPress={() => nav.push('/settings/trusted-browsers')}
          />
        )}
      </Section>

      <Section title={t('set.sec.pc')}>
        <ListRow
          testID="set-pcsession"
          icon={Monitor}
          title={t('set.pcSession')}
          subtitle={t(labelFor(PC_SESSION_OPTIONS, s.pcSessionMaxSec) ?? 'set.pcSession.3600')}
          onPress={() => setPicker('pcSession')}
        />
        <ListRow
          testID="set-devices"
          icon={Smartphone}
          title={t('set.devices')}
          onPress={() => nav.push('/devices')}
        />
        <ListRow
          testID="set-securitylog"
          icon={History}
          title={t('set.securityLog')}
          onPress={() => nav.push('/settings/security-log')}
        />
      </Section>

      <Section title={t('set.sec.account')}>
        <ListRow
          testID="set-account"
          icon={UserRound}
          title={t('set.account')}
          onPress={() => nav.push('/settings/account')}
        />
        <ListRow
          testID="set-rc"
          icon={LifeBuoy}
          title={t('set.recoveryCode')}
          subtitle={rcText || undefined}
          onPress={() => nav.push('/settings/recovery-code')}
        />
      </Section>

      <Section title={t('set.sec.data')}>
        <ListRow
          testID="set-backup"
          icon={Archive}
          title={t('set.backup')}
          subtitle={
            data.lastExportAt
              ? t('set.backup.last', { date: formatDate(data.lastExportAt) })
              : t('set.backup.never')
          }
          onPress={() => nav.push('/settings/backup')}
        />
        <ListRow
          testID="set-csv"
          icon={Upload}
          title={t('set.csv')}
          onPress={() => nav.push('/settings/backup/csv')}
        />
      </Section>

      <Section title={t('set.sec.server')}>
        <ListRow
          testID="set-server"
          icon={Server}
          title={t('set.server')}
          subtitle={`${data.serverUrl}${data.version ? ` ・ v${data.version}` : ''}${syncText ? ` ・ ${syncText}` : ''}`}
          onPress={() => nav.push('/settings/server')}
        />
      </Section>

      <Section title={t('set.sec.about')}>
        <ListRow
          testID="set-help"
          icon={HelpCircle}
          title={t('set.help')}
          onPress={() => nav.push('/settings/help')}
        />
        <ListRow
          testID="set-licenses"
          icon={Scale}
          title={t('set.licenses')}
          onPress={() => nav.push('/settings/licenses')}
        />
        <ListRow
          testID="set-signout"
          icon={LogOut}
          destructive
          title={t('set.signOut')}
          onPress={() => nav.push('/settings/account?signout=1')}
        />
      </Section>

      <Text variant="caption" tone="tertiary" align="center">
        {t('set.footer')}
      </Text>

      <OptionSheet
        visible={picker === 'autoLock'}
        title="set.autoLock"
        options={AUTO_LOCK_OPTIONS}
        value={s.autoLockSec}
        onSelect={(v) => update({ autoLockSec: v })}
        onClose={() => setPicker(null)}
      />
      <OptionSheet
        visible={picker === 'clipboard'}
        title="set.clipboard"
        options={CLIPBOARD_OPTIONS}
        value={s.clipboardClearSec}
        onSelect={(v) => update({ clipboardClearSec: v })}
        onClose={() => setPicker(null)}
      />
      <OptionSheet
        visible={picker === 'pcSession'}
        title="set.pcSession"
        options={PC_SESSION_OPTIONS}
        value={s.pcSessionMaxSec}
        onSelect={(v) => update({ pcSessionMaxSec: v })}
        onClose={() => setPicker(null)}
      />
    </Screen>
  );
}
