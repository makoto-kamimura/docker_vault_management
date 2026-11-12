import { View } from 'react-native';
import { haptics } from '../lib/haptics';
import { makeStyles, useTheme } from '../theme';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  wrap: {
    flexDirection: 'row',
    backgroundColor: t.color.bgSunken,
    borderRadius: t.radius.lg,
    padding: 3,
  },
  item: {
    flex: 1,
    minHeight: t.minTouchTarget - 6,
    borderRadius: t.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: t.space[2],
  },
}));

export function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
  /** Accessible name of the whole control. */
  label: string;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={s.wrap} accessibilityRole="tablist" accessibilityLabel={label}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <PressableScale
            key={o.value}
            scaleTo={0.97}
            accessibilityRole="tab"
            accessibilityLabel={o.label}
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) {
                haptics.select();
                onChange(o.value);
              }
            }}
            style={[
              s.item,
              selected && {
                backgroundColor: t.color.surface,
                shadowColor: t.elevation.sm.shadowColor,
                shadowOffset: t.elevation.sm.shadowOffset,
                shadowOpacity: t.elevation.sm.shadowOpacity,
                shadowRadius: t.elevation.sm.shadowRadius,
                elevation: t.elevation.sm.elevation,
              },
            ]}
          >
            <Text
              variant="callout"
              weight={selected ? 'semibold' : 'regular'}
              tone={selected ? 'primary' : 'secondary'}
            >
              {o.label}
            </Text>
          </PressableScale>
        );
      })}
    </View>
  );
}
