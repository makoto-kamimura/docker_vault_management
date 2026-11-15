import type { AuditEvent } from '@localvault/protocol';
import { ChevronLeft, History, ShieldAlert } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, EmptyState, IconButton, Skeleton, Text } from '../../components';
import { t } from '../../i18n';
import { relativeTime } from '../../lib/format';
import { nav } from '../../lib/nav';
import { makeStyles, useTheme } from '../../theme';
import { useSession } from '../session/SessionProvider';
import { describeActionError } from '../settings/errors';
import { deviceNameMap, KIND_LABEL, loadAuditPage, severity } from './flows';

const useStyles = makeStyles((th) => ({
  root: { flex: 1, backgroundColor: th.color.bg },
  head: { paddingHorizontal: th.layout.gutter, paddingBottom: th.space[3], gap: th.space[2] },
  row: {
    flexDirection: 'row',
    gap: th.space[3],
    paddingHorizontal: th.layout.gutter,
    paddingVertical: th.space[3],
    borderBottomWidth: 1,
    borderBottomColor: th.color.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 6 },
}));

export function SecurityLogScreen() {
  const { core, api } = useSession();
  const s = useStyles();
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [next, setNext] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);
  const busy = useRef(false);

  const loadFirst = useCallback(async () => {
    setState('loading');
    try {
      const [page, map] = await Promise.all([loadAuditPage(api), deviceNameMap(core)]);
      setEvents(page.events);
      setNames(map);
      setNext(page.nextBefore);
      setHasMore(page.hasMore);
      setState('ready');
    } catch (e) {
      setError(describeActionError(e) ?? t('error.unknown'));
      setState('error');
    }
  }, [api, core]);
  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = async () => {
    if (busy.current || !hasMore || next === null) return;
    busy.current = true;
    setMore(true);
    try {
      const page = await loadAuditPage(api, next);
      setEvents((e) => [...e, ...page.events]);
      setNext(page.nextBefore);
      setHasMore(page.hasMore);
    } catch {
      setHasMore(false);
    } finally {
      busy.current = false;
      setMore(false);
    }
  };

  const header = (
    <View style={[s.head, { paddingTop: insets.top + 8 }]}>
      <IconButton icon={ChevronLeft} label={t('common.back')} onPress={nav.back} />
      <Text variant="largeTitle" accessibilityRole="header">
        {t('slog.title')}
      </Text>
      <Text variant="footnote" tone="secondary">
        {t('slog.lead')}
      </Text>
    </View>
  );

  return (
    <View style={s.root}>
      {state === 'loading' ? (
        <>
          {header}
          <View style={{ padding: 16, gap: 12 }}>
            <Skeleton height={56} />
            <Skeleton height={56} />
            <Skeleton height={56} />
          </View>
        </>
      ) : state === 'error' ? (
        <>
          {header}
          <EmptyState
            icon={ShieldAlert}
            title={t('slog.loadFailed')}
            message={error}
            actionLabel={t('common.retry')}
            onAction={loadFirst}
          />
        </>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(e) => String(e.id)}
          ListHeaderComponent={header}
          ListEmptyComponent={<EmptyState icon={History} title={t('slog.empty')} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            more ? (
              <ActivityIndicator style={{ margin: 16 }} color={th.color.accent} />
            ) : hasMore ? (
              <Button variant="ghost" label={t('slog.more')} onPress={loadMore} />
            ) : undefined
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          renderItem={({ item }) => {
            const sev = severity(item.kind);
            const color =
              sev === 'danger'
                ? th.color.danger
                : sev === 'warning'
                  ? th.color.warning
                  : th.color.accent;
            const device = item.deviceId
              ? (names.get(item.deviceId) ?? t('slog.unknownDevice'))
              : null;
            return (
              <View
                style={s.row}
                accessible
                accessibilityLabel={`${t(KIND_LABEL[item.kind])}。${device ?? ''}。${relativeTime(item.createdAt)}`}
              >
                <View style={[s.dot, { backgroundColor: color }]} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="callout">{t(KIND_LABEL[item.kind])}</Text>
                  {device !== null && (
                    <Text variant="footnote" tone="secondary">
                      {device}
                    </Text>
                  )}
                </View>
                <Text variant="caption" tone="tertiary">
                  {relativeTime(item.createdAt)}
                </Text>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}
