import { View } from 'react-native';
import { t } from '../i18n';
import { estimateStrength, type StrengthLevel } from '../lib/passwordStrength';
import { makeStyles, useTheme } from '../theme';
import { Text } from './Text';

const useStyles = makeStyles((th) => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: th.space[3] },
  bars: { flex: 1, flexDirection: 'row', gap: th.space[1] },
  bar: { flex: 1, height: 6, borderRadius: th.radius.full },
}));

/** Four-segment strength meter for PasswordField's `meter` slot (FR-02). */
export function StrengthMeter({ password }: { password: string }) {
  const th = useTheme();
  const s = useStyles();
  const { level } = estimateStrength(password);
  const colors: Record<StrengthLevel, string> = {
    0: th.color.border,
    1: th.color.danger,
    2: th.color.warning,
    3: th.color.success,
    4: th.color.success,
  };
  const label = t(`strength.${level}`);
  return (
    <View
      style={s.row}
      accessible
      accessibilityLabel={t('a11y.strength', { label })}
      accessibilityLiveRegion="polite"
    >
      <View style={s.bars}>
        {[1, 2, 3, 4].map((i) => (
          <View
            key={i}
            style={[s.bar, { backgroundColor: i <= level ? colors[level] : th.color.border }]}
          />
        ))}
      </View>
      <Text variant="footnote" tone="secondary">
        {label}
      </Text>
    </View>
  );
}
