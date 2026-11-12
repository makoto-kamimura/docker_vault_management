import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { CircleCheck, ShieldAlert } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Badge,
  Banner,
  BottomSheet,
  Button,
  Card,
  EmptyState,
  PasswordField,
  Screen,
  Section,
  Skeleton,
  SwitchRow,
  Text,
  TextField,
  useToast,
} from '../../components';
import { t } from '../../i18n';
import { getFlagStore } from '../../lib/flagStore';
import { formatDateTime } from '../../lib/format';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSession } from '../session/SessionProvider';
import { useAction } from '../settings/useAction';
import { deviceSubtitle } from './deviceUi';
import {
  type DeviceRow,
  loadDevices,
  RevokeFlowError,
  type RotationProgress,
  revokeDeviceFlow,
  validDeviceName,
} from './flows';
import { RotationProgressView } from './RotationProgressView';

type Done = { rotated: boolean; rcWasEnabled: boolean; extension: boolean };

export function DeviceDetailScreen() {
  const { id, revoke } = useLocalSearchParams<{ id: string; revoke?: string }>();
  const { core, api, engine } = useSession();
  const toast = useToast();
  const [device, setDevice] = useState<DeviceRow | null | undefined>(undefined);
  const [name, setName] = useState('');
  const [sheet, setSheet] = useState(false);
  const [rotate, setRotate] = useState(true);
  const [password, setPassword] = useState('');
  const [progress, setProgress] = useState<RotationProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [partial, setPartial] = useState(false);
  const rename = useAction();
  const act = useAction();

  const load = useCallback(() => {
    loadDevices(core, api)
      .then((l) => {
        const d = [...l.active, ...l.revoked].find((x) => x.deviceId === id) ?? null;
        setDevice(d);
        if (d) setName((prev) => (prev === '' ? d.name : prev));
      })
      .catch(() => setDevice(null));
  }, [core, api, id]);
  useFocusEffect(load);

  // "身に覚えがない": open straight into the revoke sheet.
  useEffect(() => {
    if (revoke === '1' && device && !device.isThisDevice && device.revokedAt === null)
      setSheet(true);
  }, [revoke, device]);

  // The master password never outlives the sheet.
  useEffect(() => {
    if (!sheet) setPassword('');
  }, [sheet]);

  const saveName = async () => {
    const ok = await rename.run(async () => {
      await core.renameDevice(String(id), name.trim());
      engine.notifySyncNeeded();
      return true;
    });
    if (ok) {
      haptics.success();
      toast.success(t('dev.renamed'));
      load();
    }
  };

  const startRevoke = async () => {
    setSheet(false);
    setRunning(true);
    setProgress(null);
    setPartial(false);
    const pw = rotate ? password : undefined;
    setPassword('');
    const result = await act.run(() =>
      revokeDeviceFlow(
        {
          core,
          api,
          store: getFlagStore(),
          syncAfter: () => engine.requestSync('manual'),
          onProgress: setProgress,
        },
        { deviceId: String(id), rotateKey: rotate, masterPassword: pw },
      ).catch((e) => {
        if (e instanceof RevokeFlowError) {
          if (e.revoked) setPartial(true);
          throw e.cause;
        }
        throw e;
      }),
    );
    setRunning(false);
    if (result) {
      haptics.success();
      setDone({ ...result, extension: device?.type === 'extension' });
      load();
    }
  };

  if (running) {
    return (
      <Screen scroll={false} title={t('dev.revokeRunning')}>
        <RotationProgressView progress={rotate ? progress : { phase: 'revoke' }} />
      </Screen>
    );
  }

  if (done) {
    return (
      <Screen
        footer={
          <>
            {done.rcWasEnabled && done.rotated && (
              <Button
                testID="revoke-reissue-rc"
                label={t('dev.reissueRc')}
                onPress={() => nav.replace('/settings/recovery-code')}
              />
            )}
            <Button
              variant={done.rcWasEnabled && done.rotated ? 'ghost' : 'primary'}
              label={t('common.done')}
              onPress={() => nav.replace('/devices')}
            />
          </>
        }
      >
        <EmptyState
          icon={CircleCheck}
          title={t('dev.revokedTitle')}
          message={t(done.rotated ? 'dev.revokedRotated' : 'dev.revokedPlain')}
        />
        {done.rotated && done.extension && (
          <Banner kind="warning" message={t('dev.afterWarning')} />
        )}
        {done.rcWasEnabled && done.rotated && (
          <Banner kind="info" message={t('dev.rcInvalidated')} />
        )}
      </Screen>
    );
  }

  if (device === undefined) {
    return (
      <Screen title={t('dev.detailTitle')} onBack={nav.back}>
        <Skeleton height={140} radius={20} />
      </Screen>
    );
  }
  if (device === null) {
    return (
      <Screen title={t('dev.detailTitle')} onBack={nav.back}>
        <EmptyState
          icon={ShieldAlert}
          title={t('dev.notFound')}
          actionLabel={t('common.back')}
          onAction={nav.back}
        />
      </Screen>
    );
  }

  const canRevoke = !device.isThisDevice && device.revokedAt === null;
  const canSubmit = !rotate || password !== '';

  return (
    <Screen
      title={device.name}
      subtitle={deviceSubtitle(device)}
      onBack={nav.back}
      headerRight={
        device.isThisDevice ? (
          <Badge label={t('dev.thisDevice')} />
        ) : device.revokedAt ? (
          <Badge label={t('dev.revoked')} tone="neutral" />
        ) : undefined
      }
    >
      {act.error !== null && (
        <Banner
          kind="danger"
          message={act.error}
          title={partial ? t('dev.partialTitle') : undefined}
        />
      )}
      {partial && <Banner kind="warning" message={t('dev.partialBody')} />}
      {act.clockSkew && <Banner kind="warning" message={t('error.clockSkew')} />}
      <Section title={t('dev.nameSection')}>
        <View style={{ padding: 16, gap: 12 }}>
          <TextField
            testID="device-name"
            label={t('dev.nameLabel')}
            value={name}
            onChangeText={(v) => setName(v.slice(0, 64))}
            maxLength={64}
            hint={t('dev.nameHint')}
          />
          {rename.error !== null && <Banner kind="danger" message={rename.error} />}
          <Button
            testID="device-rename"
            variant="secondary"
            label={t('dev.rename')}
            loading={rename.busy}
            disabled={!validDeviceName(name) || name.trim() === device.name}
            onPress={saveName}
          />
        </View>
      </Section>
      {device.isThisDevice && (
        <Card tone="subtle">
          <Text variant="footnote" tone="secondary">
            {t('dev.thisDeviceNote')}
          </Text>
        </Card>
      )}
      {canRevoke && (
        <Button
          testID="device-revoke"
          variant="danger"
          label={t('dev.revoke')}
          onPress={() => setSheet(true)}
        />
      )}
      <BottomSheet visible={sheet} onClose={() => setSheet(false)} title={t('dev.revokeTitle')}>
        <Text variant="body" tone="secondary">
          {t('dev.revokeLead', { name: device.name })}
        </Text>
        <SwitchRow
          testID="revoke-rotate"
          title={t('dev.rotateToggle')}
          subtitle={t('dev.rotateHint')}
          value={rotate}
          onValueChange={setRotate}
        />
        {rotate && (
          <>
            <PasswordField
              testID="revoke-password"
              label={t('dev.passwordLabel')}
              hint={t('dev.passwordHint')}
              value={password}
              onChangeText={setPassword}
              autoComplete="off"
            />
            <Banner kind="warning" message={t('dev.afterWarning')} />
          </>
        )}
        {device.lastSeenAt && (
          <Text variant="caption" tone="tertiary">
            {t('dev.lastSeen', { date: formatDateTime(device.lastSeenAt) })}
          </Text>
        )}
        <Button
          testID="revoke-confirm"
          variant="danger"
          label={t('dev.revokeConfirm')}
          disabled={!canSubmit}
          onPress={startRevoke}
        />
        <Button variant="ghost" label={t('common.cancel')} onPress={() => setSheet(false)} />
      </BottomSheet>
    </Screen>
  );
}
