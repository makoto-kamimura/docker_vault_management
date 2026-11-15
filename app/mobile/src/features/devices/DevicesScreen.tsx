import { useFocusEffect } from 'expo-router';
import { Monitor, Plus, WifiOff } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  EmptyState,
  ListRow,
  Screen,
  Section,
  Skeleton,
} from '../../components';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { useSession } from '../session/SessionProvider';
import { describeActionError } from '../settings/errors';
import { deviceIcon, deviceSubtitle } from './deviceUi';
import { type DeviceLists, loadDevices } from './flows';

export function DevicesScreen() {
  const { core, api } = useSession();
  const [lists, setLists] = useState<DeviceLists | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    loadDevices(core, api)
      .then(setLists)
      .catch((e) => setError(describeActionError(e) ?? t('error.unknown')));
  }, [core, api]);
  useFocusEffect(load);

  const row = (d: DeviceLists['active'][number]) => {
    const Icon = deviceIcon(d);
    return (
      <ListRow
        key={d.deviceId}
        testID={`device-${d.deviceId}`}
        title={d.name}
        subtitle={deviceSubtitle(d)}
        leading={<Avatar title={d.name.slice(0, 1)} />}
        icon={Icon}
        trailing={
          d.isThisDevice ? (
            <Badge label={t('dev.thisDevice')} />
          ) : d.revokedAt ? (
            <Badge label={t('dev.revoked')} tone="neutral" />
          ) : undefined
        }
        onPress={() => nav.push(`/devices/${d.deviceId}`)}
      />
    );
  };

  return (
    <Screen
      title={t('dev.title')}
      onBack={nav.back}
      footer={
        <Button
          testID="devices-add-pc"
          icon={Plus}
          label={t('dev.addPc')}
          onPress={() => nav.push('/devices/pair')}
        />
      }
    >
      {error !== null && (
        <EmptyState
          icon={WifiOff}
          title={t('dev.loadFailed')}
          message={error}
          actionLabel={t('common.retry')}
          onAction={load}
        />
      )}
      {lists === null && error === null && <Skeleton height={180} radius={20} />}
      {lists && !lists.serverReachable && <Banner kind="info" message={t('dev.offline')} />}
      {lists && lists.active.length === 0 && (
        <EmptyState icon={Monitor} title={t('dev.empty')} message={t('dev.emptyBody')} />
      )}
      {lists && lists.active.length > 0 && (
        <Section title={t('dev.sectionActive')}>{lists.active.map(row)}</Section>
      )}
      {lists && lists.revoked.length > 0 && (
        <Section title={t('dev.sectionRevoked')}>{lists.revoked.map(row)}</Section>
      )}
    </Screen>
  );
}
