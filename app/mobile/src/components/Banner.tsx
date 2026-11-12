import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { makeStyles, useTheme } from '../theme';
import { Button } from './Button';
import { Text } from './Text';

export type BannerKind = 'info' | 'success' | 'warning' | 'danger';

const useStyles = makeStyles((t) => ({
  wrap: {
    flexDirection: 'row',
    gap: t.space[3],
    padding: t.space[4],
    borderRadius: t.radius.lg,
    alignItems: 'flex-start',
  },
  body: { flex: 1, gap: t.space[1] },
}));

export function Banner({
  kind = 'info',
  title,
  message,
  actionLabel,
  onAction,
  children,
}: {
  kind?: BannerKind;
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  children?: ReactNode;
}) {
  const t = useTheme();
  const s = useStyles();
  const cfg = {
    info: { Icon: Info, bg: t.color.accentSubtle, fg: t.color.accent },
    success: { Icon: CheckCircle2, bg: t.color.accentSubtle, fg: t.color.success },
    warning: { Icon: AlertTriangle, bg: t.color.bgSunken, fg: t.color.warning },
    danger: { Icon: XCircle, bg: t.color.dangerSubtle, fg: t.color.danger },
  }[kind];
  return (
    <View
      style={[s.wrap, { backgroundColor: cfg.bg }]}
      accessible
      accessibilityRole={kind === 'danger' ? 'alert' : undefined}
      accessibilityLiveRegion={kind === 'danger' ? 'assertive' : 'polite'}
      accessibilityLabel={title ? `${title}。${message}` : message}
    >
      <cfg.Icon size={22} color={cfg.fg} />
      <View style={s.body}>
        {title !== undefined && (
          <Text variant="callout" weight="semibold">
            {title}
          </Text>
        )}
        <Text variant="footnote" tone="secondary">
          {message}
        </Text>
        {children}
        {actionLabel !== undefined && onAction !== undefined && (
          <View style={{ marginTop: t.space[2] }}>
            <Button label={actionLabel} onPress={onAction} variant="ghost" fullWidth={false} />
          </View>
        )}
      </View>
    </View>
  );
}
