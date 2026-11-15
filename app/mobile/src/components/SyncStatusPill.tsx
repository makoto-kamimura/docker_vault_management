import { View } from 'react-native';
import { t as tr } from '../i18n';
import type { SyncStatus } from '../sync/types';
import { makeStyles, useTheme } from '../theme';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  pill: {
    minHeight: t.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: t.space[2],
    paddingHorizontal: t.space[3],
    borderRadius: t.radius.full,
    backgroundColor: t.color.bgSunken,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
}));

function formatTime(iso: string | null): string {
  if (iso === null) return tr('sync.never');
  const d = new Date(iso);
  return tr('sync.lastAt', {
    time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
  });
}

/** FR-73: sync state + last sync time; tapping opens the details. */
export function SyncStatusPill({ status, onPress }: { status: SyncStatus; onPress?: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const color = {
    synced: t.color.success,
    syncing: t.color.accent,
    offline: t.color.textTertiary,
    error: t.color.danger,
    rollback: t.color.danger,
  }[status.kind];
  const label = tr(`sync.${status.kind}`);
  const time = formatTime(status.lastSyncedAt);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${label}、${time}`}
      accessibilityHint={status.kind === 'synced' ? undefined : tr('sync.detailTitle')}
      onPress={onPress}
      style={s.pill}
    >
      <View style={[s.dot, { backgroundColor: color }]} />
      <Text variant="footnote" weight="medium">
        {label}
      </Text>
      <Text variant="caption" tone="tertiary">
        {time}
      </Text>
    </PressableScale>
  );
}
