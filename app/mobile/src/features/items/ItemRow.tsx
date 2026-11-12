import type { ItemSummary } from '@localvault/core';
import { Copy, Star, Trash2, User } from 'lucide-react-native';
import { memo } from 'react';
import { Pressable, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import { Avatar, Badge, PressableScale, Text } from '../../components';
import { t } from '../../i18n';
import { makeStyles, useTheme } from '../../theme';

const useStyles = makeStyles((th) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: th.space[3],
    paddingVertical: th.space[3],
    paddingLeft: th.space[4],
    paddingRight: th.space[3],
    backgroundColor: th.color.surface,
    borderRadius: th.radius.lg,
    borderWidth: 1,
    borderColor: th.color.border,
    minHeight: 68,
  },
  text: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: th.space[2] },
  actions: { flexDirection: 'row', gap: th.space[2] },
  copyBtn: {
    minWidth: 44,
    minHeight: 44,
    borderRadius: th.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 2,
    backgroundColor: th.color.bgSunken,
  },
  swipe: {
    width: 84,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderRadius: th.radius.lg,
    marginLeft: th.space[2],
  },
}));

export type ItemRowProps = {
  item: ItemSummary;
  highlighted: boolean;
  onOpen: (id: string) => void;
  onCopy: (id: string, field: 'username' | 'password') => void;
  onFavorite: (id: string) => void;
  onTrash: (id: string) => void;
};

function ItemRowBase({ item, highlighted, onOpen, onCopy, onFavorite, onTrash }: ItemRowProps) {
  const s = useStyles();
  const th = useTheme();
  const title = item.title === '' ? t('items.untitled') : item.title;
  const swipeAction = (bg: string, Icon: typeof Star, label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[s.swipe, { backgroundColor: bg }]}
    >
      <Icon size={20} color="#FFFFFF" />
      <Text variant="caption" weight="semibold" style={{ color: '#FFFFFF' }}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View style={{ paddingVertical: 4 }}>
      <ReanimatedSwipeable
        overshootLeft={false}
        overshootRight={false}
        renderLeftActions={() =>
          swipeAction(
            th.color.accent,
            Star,
            item.favorite ? t('items.unfavorite') : t('items.favorite'),
            () => onFavorite(item.id),
          )
        }
        renderRightActions={() =>
          swipeAction(th.color.danger, Trash2, t('items.toTrash'), () => onTrash(item.id))
        }
      >
        <PressableScale
          testID={`item-row-${item.id}`}
          scaleTo={0.99}
          accessibilityRole="button"
          accessibilityLabel={item.username ? `${title}、${item.username}` : title}
          onPress={() => onOpen(item.id)}
          style={s.card}
        >
          <Avatar title={title} />
          <View style={s.text}>
            <View style={s.titleRow}>
              <Text variant="callout" weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
                {title}
              </Text>
              {item.favorite && <Star size={14} color={th.color.warning} fill={th.color.warning} />}
              {item.isConflictCopy && <Badge label={t('items.conflictBadge')} tone="danger" />}
            </View>
            {item.username !== '' && (
              <Text variant="footnote" tone="secondary" numberOfLines={1}>
                {item.username}
              </Text>
            )}
          </View>
          <View style={s.actions}>
            <Pressable
              testID={`copy-user-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={t('items.copyUser')}
              onPress={() => onCopy(item.id, 'username')}
              style={s.copyBtn}
            >
              <User size={16} color={th.color.textSecondary} />
            </Pressable>
            <Pressable
              testID={`copy-pass-${item.id}`}
              accessibilityRole="button"
              accessibilityLabel={t('items.copyPass')}
              onPress={() => onCopy(item.id, 'password')}
              style={[s.copyBtn, highlighted && { backgroundColor: th.color.accent }]}
            >
              <Copy size={16} color={highlighted ? th.color.onAccent : th.color.textSecondary} />
            </Pressable>
          </View>
        </PressableScale>
      </ReanimatedSwipeable>
    </View>
  );
}

export const ItemRow = memo(ItemRowBase);
