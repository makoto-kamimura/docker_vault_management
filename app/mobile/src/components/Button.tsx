import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, type StyleProp, View, type ViewStyle } from 'react-native';
import { haptics } from '../lib/haptics';
import { makeStyles, useTheme } from '../theme';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  /** Stretch to the container width (default true). */
  fullWidth?: boolean;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const useStyles = makeStyles((t) => ({
  base: {
    minHeight: Math.max(t.minTouchTarget, 52),
    borderRadius: t.radius.lg,
    paddingHorizontal: t.space[5],
    paddingVertical: t.space[3],
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: t.space[2],
  },
  fill: { alignSelf: 'stretch' },
  content: { flexDirection: 'row', alignItems: 'center', gap: t.space[2] },
}));

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon: Icon,
  loading = false,
  disabled = false,
  fullWidth = true,
  accessibilityHint,
  style,
  testID,
}: ButtonProps) {
  const t = useTheme();
  const s = useStyles();
  const inactive = disabled || loading;

  const palette = {
    primary: {
      bg: t.color.accent,
      bgPressed: t.color.accentPressed,
      fg: t.color.onAccent,
      border: 'transparent',
    },
    secondary: {
      bg: t.color.accentSubtle,
      bgPressed: t.color.bgSunken,
      fg: t.color.accent,
      border: 'transparent',
    },
    ghost: {
      bg: 'transparent',
      bgPressed: t.color.bgSunken,
      fg: t.color.accent,
      border: 'transparent',
    },
    danger: {
      bg: t.color.dangerSubtle,
      bgPressed: t.color.bgSunken,
      fg: t.color.danger,
      border: 'transparent',
    },
  }[variant];

  return (
    <PressableScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      style={({ pressed }) => [
        s.base,
        fullWidth && s.fill,
        {
          backgroundColor: pressed ? palette.bgPressed : palette.bg,
          borderColor: palette.border,
          opacity: disabled && !loading ? 0.45 : 1,
        },
        style,
      ]}
    >
      <View style={s.content}>
        {loading ? (
          <ActivityIndicator color={palette.fg} />
        ) : Icon ? (
          <Icon size={20} color={palette.fg} strokeWidth={2} />
        ) : null}
        <Text variant="callout" weight="semibold" style={{ color: palette.fg }}>
          {label}
        </Text>
      </View>
    </PressableScale>
  );
}
