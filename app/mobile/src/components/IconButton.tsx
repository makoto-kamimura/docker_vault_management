import type { LucideIcon } from 'lucide-react-native';
import { haptics } from '../lib/haptics';
import { useTheme } from '../theme';
import { PressableScale } from './PressableScale';

export type IconButtonProps = {
  icon: LucideIcon;
  /** Required: icon-only controls need an accessible name. */
  label: string;
  onPress: () => void;
  tone?: 'default' | 'accent' | 'danger';
  disabled?: boolean;
  size?: number;
  testID?: string;
};

export function IconButton({
  icon: Icon,
  label,
  onPress,
  tone = 'default',
  disabled = false,
  size = 22,
  testID,
}: IconButtonProps) {
  const t = useTheme();
  const fg = tone === 'accent' ? t.color.accent : tone === 'danger' ? t.color.danger : t.color.text;
  return (
    <PressableScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={t.hitSlop}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      style={({ pressed }) => ({
        width: t.minTouchTarget,
        height: t.minTouchTarget,
        borderRadius: t.radius.full,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? t.color.bgSunken : 'transparent',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Icon size={size} color={fg} strokeWidth={2} />
    </PressableScale>
  );
}
