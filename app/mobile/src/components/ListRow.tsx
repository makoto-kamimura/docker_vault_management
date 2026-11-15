import type { LucideIcon } from 'lucide-react-native';
import { ChevronRight } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { haptics } from '../lib/haptics';
import { makeStyles, useTheme } from '../theme';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ListRowProps = {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  /** Replaces the icon (e.g. an Avatar). */
  leading?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  /** Shows a chevron when pressable (default true). */
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  testID?: string;
};

const useStyles = makeStyles((t) => ({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space[3],
    paddingHorizontal: t.space[4],
    paddingVertical: t.space[3],
  },
  text: { flex: 1, gap: 2 },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: t.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.color.accentSubtle,
  },
}));

export function ListRow({
  title,
  subtitle,
  icon: Icon,
  leading,
  trailing,
  onPress,
  chevron = true,
  destructive,
  disabled,
  accessibilityHint,
  testID,
}: ListRowProps) {
  const t = useTheme();
  const s = useStyles();
  const content = (
    <>
      {leading ??
        (Icon ? (
          <View style={s.iconWrap}>
            <Icon size={18} color={destructive ? t.color.danger : t.color.accent} />
          </View>
        ) : null)}
      <View style={s.text}>
        <Text variant="callout" tone={destructive ? 'danger' : 'primary'}>
          {title}
        </Text>
        {subtitle !== undefined && (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        )}
      </View>
      {trailing}
      {onPress !== undefined && chevron && <ChevronRight size={18} color={t.color.textTertiary} />}
    </>
  );
  if (onPress === undefined) {
    return (
      <View
        testID={testID}
        style={s.row}
        accessible
        accessibilityLabel={subtitle ? `${title}、${subtitle}` : title}
      >
        {content}
      </View>
    );
  }
  return (
    <PressableScale
      testID={testID}
      scaleTo={0.99}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}、${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        haptics.select();
        onPress();
      }}
      style={({ pressed }) => [
        s.row,
        { backgroundColor: pressed ? t.color.bgSunken : 'transparent' },
      ]}
    >
      {content}
    </PressableScale>
  );
}
