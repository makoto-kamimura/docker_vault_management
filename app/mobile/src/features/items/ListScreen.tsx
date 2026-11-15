import { FlashList } from '@shopify/flash-list';
import { ArrowUpDown, Lock, Plus, Search, Trash2, Vault } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { RefreshControl, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Banner,
  BottomSheet,
  Button,
  EmptyState,
  IconButton,
  SegmentedControl,
  Skeleton,
  SyncStatusPill,
  Text,
  TextField,
} from '../../components';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { useSyncStore } from '../../state/syncStore';
import { makeStyles, useTheme } from '../../theme';
import { HomeBanners } from '../approvals/HomeBanners';
import { useSession } from '../session/SessionProvider';
import { ItemRow } from './ItemRow';
import { isHighlighted } from './model';
import { useBanners } from './useBanners';
import { useItemList } from './useItemList';

const useStyles = makeStyles((th) => ({
  root: { flex: 1, backgroundColor: th.color.bg },
  head: {
    paddingHorizontal: th.layout.gutter,
    gap: th.space[3],
    paddingBottom: th.space[2],
  },
  // Icons sit on their own row above the large title: five 44pt targets next to a 34pt title do
  // not fit a 375–393pt wide iPhone (the right-hand icons were clipped).
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginRight: -th.space[2],
  },
  pad: { paddingHorizontal: th.layout.gutter },
  section: { paddingTop: th.space[4], paddingBottom: th.space[1] },
  sheetGap: { gap: th.space[3] },
}));

export function ListScreen() {
  const { core, engine } = useSession();
  const s = useStyles();
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const status = useSyncStore((x) => x.status);
  const list = useItemList();
  const banners = useBanners();
  const [detail, setDetail] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sortSheet, setSortSheet] = useState(false);

  const open = useCallback((id: string) => nav.push(`/item/${id}`), []);

  const header = (
    <View style={{ gap: th.space[3] }}>
      <View style={s.pad}>
        <SyncStatusPill status={status} onPress={() => setDetail(true)} />
      </View>
      {banners.rollback && (
        <View style={s.pad}>
          <Banner
            kind="danger"
            message={t('items.banner.rollback')}
            actionLabel={t('items.banner.rollbackExport')}
            onAction={() => nav.push('/settings/backup')}
          >
            <Button
              variant="danger"
              label={t('sync.acceptServer')}
              onPress={() => void engine.acceptRollback()}
            />
          </Banner>
        </View>
      )}
      {banners.needsMaster && (
        <View style={s.pad}>
          <Banner kind="warning" message={t('items.banner.needsMaster')} />
        </View>
      )}
      <View style={[s.pad, { gap: th.space[3] }]}>
        <HomeBanners />
      </View>
      {showSearch && (
        <View style={s.pad}>
          <TextField
            testID="list-search"
            label={t('items.search')}
            placeholder={t('items.searchPlaceholder')}
            value={list.query}
            onChangeText={list.setQuery}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
        </View>
      )}
    </View>
  );

  let body: React.ReactNode;
  if (list.loading) {
    body = (
      <View style={[s.pad, { gap: th.space[3], paddingTop: th.space[4] }]}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={68} radius={th.radius.lg} />
        ))}
      </View>
    );
  } else if (list.failed) {
    body = (
      <EmptyState
        icon={Vault}
        title={t('items.loadFailed')}
        actionLabel={t('common.retry')}
        onAction={() => void list.reload()}
      />
    );
  } else if (!list.hasAny) {
    body = (
      <EmptyState
        icon={Vault}
        title={t('items.empty.title')}
        message={t('items.empty.body')}
        actionLabel={t('items.empty.add')}
        onAction={() => nav.push('/item/new')}
      />
    );
  } else if (list.rows.length === 0) {
    body = (
      <EmptyState
        icon={Search}
        title={t('items.noResults.title')}
        message={t('items.noResults.body')}
      />
    );
  } else {
    body = (
      <FlashList
        data={list.rows}
        keyExtractor={(r) => r.key}
        getItemType={(r) => r.type}
        extraData={`${list.highlight?.id}-${list.now}`}
        contentContainerStyle={{ paddingHorizontal: th.layout.gutter, paddingBottom: 96 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={list.refreshing}
            onRefresh={() => void list.refresh()}
            tintColor={th.color.accent}
          />
        }
        renderItem={({ item: r }) =>
          r.type === 'header' ? (
            <View style={s.section}>
              <Text
                variant="footnote"
                weight="semibold"
                tone="secondary"
                accessibilityRole="header"
              >
                {r.section === 'favorites' ? t('items.section.favorites') : t('items.section.all')}
              </Text>
            </View>
          ) : (
            <ItemRow
              item={r.item}
              highlighted={isHighlighted(list.highlight, r.item.id, list.now)}
              onOpen={open}
              onCopy={list.copy}
              onFavorite={list.toggleFavorite}
              onTrash={list.trash}
            />
          )
        }
        ListHeaderComponent={null}
      />
    );
  }

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
      <View style={s.head}>
        <View style={s.tools}>
          <IconButton
            testID="list-search-toggle"
            icon={Search}
            label={t('items.search')}
            onPress={() => {
              if (showSearch) list.setQuery('');
              setShowSearch((v) => !v);
            }}
          />
          <IconButton
            icon={ArrowUpDown}
            label={t('items.sort')}
            onPress={() => setSortSheet(true)}
          />
          <IconButton
            testID="home-trash"
            icon={Trash2}
            label={t('items.trash')}
            onPress={() => nav.push('/trash')}
          />
          <IconButton
            testID="home-lock"
            icon={Lock}
            label={t('items.lock')}
            onPress={() => void core.lock()}
          />
          <IconButton
            testID="home-add"
            icon={Plus}
            tone="accent"
            label={t('items.add')}
            onPress={() => nav.push('/item/new')}
          />
        </View>
        <Text variant="largeTitle" accessibilityRole="header">
          {t('items.title')}
        </Text>
      </View>
      {header}
      <View style={{ flex: 1 }}>{body}</View>

      <BottomSheet visible={sortSheet} onClose={() => setSortSheet(false)} title={t('items.sort')}>
        <SegmentedControl
          label={t('items.sort')}
          value={list.sort}
          onChange={(v) => {
            list.setSort(v);
            setSortSheet(false);
          }}
          options={[
            { value: 'recent', label: t('items.sort.recent') },
            { value: 'name', label: t('items.sort.name') },
          ]}
        />
      </BottomSheet>

      <BottomSheet visible={detail} onClose={() => setDetail(false)} title={t('sync.detailTitle')}>
        <View style={s.sheetGap}>
          <Text variant="body" tone="secondary">
            {status.kind === 'synced' || status.kind === 'syncing'
              ? t(`sync.${status.kind}`)
              : t(detailKey)}
          </Text>
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
