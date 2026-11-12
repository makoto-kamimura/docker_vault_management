import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { makeStyles, useTheme } from '../theme';
import { Button } from './Button';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  wrap: {
    alignItems: 'center',
    gap: t.space[3],
    paddingVertical: t.space[10],
    paddingHorizontal: t.space[6],
  },
  badge: {
    width: 72,
    height: 72,
    borderRadius: t.radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.color.accentSubtle,
    marginBottom: t.space[2],
  },
}));

export function EmptyState({
  icon: Icon,
  title,
  message,
  actionLabel,
  onAction,
}: {
  icon: LucideIcon;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={s.wrap} accessible accessibilityLabel={message ? `${title}。${message}` : title}>
      <View style={s.badge}>
        <Icon size={32} color={t.color.accent} strokeWidth={1.75} />
      </View>
      <Text variant="title3" align="center">
        {title}
      </Text>
      {message !== undefined && (
        <Text variant="body" tone="secondary" align="center">
          {message}
        </Text>
      )}
      {actionLabel !== undefined && onAction !== undefined && (
        <Button label={actionLabel} onPress={onAction} fullWidth={false} />
      )}
    </View>
  );
}
