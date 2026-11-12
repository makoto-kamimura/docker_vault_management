import { Check } from 'lucide-react-native';
import { View } from 'react-native';
import { t as tr } from '../i18n';
import { makeStyles, useTheme } from '../theme';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  item: { flex: 1, alignItems: 'center', gap: t.space[1] },
  dot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
}));

/** Horizontal step indicator. `current` is 0-based. */
export function ProgressSteps({ steps, current }: { steps: readonly string[]; current: number }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View
      style={s.row}
      accessible
      accessibilityLabel={`${tr('a11y.progress', { current: current + 1, total: steps.length })}、${steps[current] ?? ''}`}
    >
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <View key={label} style={s.item}>
            <View
              style={[
                s.dot,
                {
                  backgroundColor: done || active ? t.color.accent : t.color.bgSunken,
                  borderWidth: active ? 0 : 1,
                  borderColor: t.color.border,
                },
              ]}
            >
              {done ? (
                <Check size={14} color={t.color.onAccent} strokeWidth={3} />
              ) : (
                <Text variant="caption" weight="bold" tone={active ? 'onAccent' : 'tertiary'}>
                  {i + 1}
                </Text>
              )}
            </View>
            <Text variant="caption" tone={active ? 'primary' : 'tertiary'} align="center">
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
