import type { ItemSummary } from '@localvault/core';
import { Lock, Vault } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Avatar,
  Banner,
  BottomSheet,
  Button,
  EmptyState,
  IconButton,
  ListRow,
  Section,
  SyncStatusPill,
  Text,
} from '../../components';
import { t } from '../../i18n';
import { useSyncStore } from '../../state/syncStore';
import { makeStyles, useTheme } from '../../theme';
import { useSession } from '../session/SessionProvider';

const useStyles = makeStyles((th) => ({
  root: { flex: 1, backgroundColor: th.color.bg },
  content: { paddingHorizontal: th.layout.gutter, gap: th.space[4], paddingBottom: th.space[8] },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
}));

/**
 * Placeholder list screen so the setup / unlock flow can be walked end to end.
 * The next wave replaces this with the real list (search, favourites, copy buttons).
 */
export function HomeScreen() {
  const { core, engine } = useSession();
  const s = useStyles();
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const status = useSyncStore((x) => x.status);
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState(false);

  const load = useCallback(
    () =>
      core
        .listItems()
        .then(setItems)
        .catch(() => undefined),
    [core],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    await engine.requestSync('manual');
    await load();
    setRefreshing(false);
  };

  const detailKey = (
    {
      offline: 'sync.detail.offline',
      error: status.errorKind === 'clockSkew' ? 'sync.detail.clockSkew' : 'sync.detail.error',
      rollback: 'sync.detail.rollback',
      synced: 'sync.detail.error',
      syncing: 'sync.detail.error',
    } as const
  )[status.kind];

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={th.color.accent} />
        }
      >
        <View style={s.head}>
          <Text variant="largeTitle" accessibilityRole="header">
            {t('home.title')}
          </Text>
          <IconButton
            testID="home-lock"
            icon={Lock}
            label={t('a11y.lockNow')}
            onPress={() => void core.lock()}
          />
        </View>
        <SyncStatusPill status={status} onPress={() => setDetail(true)} />
        {status.needsMasterPassword && (
          <Banner kind="warning" message={t('sync.detail.needsMasterPassword')} />
        )}
        {items.length === 0 ? (
          <EmptyState icon={Vault} title={t('home.empty.title')} message={t('home.empty.body')} />
        ) : (
          <Section>
            {items.map((i) => (
              <ListRow
                key={i.id}
                title={i.title}
                subtitle={i.username}
                leading={<Avatar title={i.title} />}
              />
            ))}
          </Section>
        )}
      </ScrollView>
      <BottomSheet visible={detail} onClose={() => setDetail(false)} title={t('sync.detailTitle')}>
        <Text variant="body" tone="secondary">
          {status.kind === 'synced' || status.kind === 'syncing'
            ? t(`sync.${status.kind}`)
            : t(detailKey)}
        </Text>
        <View style={{ gap: 8 }}>
          {status.kind === 'rollback' && (
            <Button
              variant="danger"
              label={t('sync.acceptServer')}
              onPress={() => {
                setDetail(false);
                void engine.acceptRollback();
              }}
            />
          )}
          {status.kind !== 'rollback' && (
            <Button
              variant="secondary"
              label={t('sync.retryNow')}
              onPress={() => {
                setDetail(false);
                void engine.requestSync('manual');
              }}
            />
          )}
          <Button variant="ghost" label={t('common.close')} onPress={() => setDetail(false)} />
        </View>
      </BottomSheet>
    </View>
  );
}
