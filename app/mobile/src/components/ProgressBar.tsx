import { View } from 'react-native';
import { makeStyles, useTheme } from '../theme';

const useStyles = makeStyles((t) => ({
  track: {
    height: 8,
    borderRadius: t.radius.full,
    overflow: 'hidden',
    backgroundColor: t.color.bgSunken,
  },
  fill: { height: 8, borderRadius: t.radius.full },
}));

/** Determinate progress bar (0..1). Not animated, so Reduce Motion needs no special case. */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const s = useStyles();
  const t = useTheme();
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <View
      style={s.track}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: pct }}
    >
      <View style={[s.fill, { width: `${pct}%`, backgroundColor: t.color.accent }]} />
    </View>
  );
}
