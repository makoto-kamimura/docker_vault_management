import { useRef, useState } from 'react';
import { type AccessibilityActionEvent, PanResponder, View } from 'react-native';
import { makeStyles, useTheme } from '../theme';

const useStyles = makeStyles((t) => ({
  hit: { height: 44, justifyContent: 'center' },
  track: { height: 6, borderRadius: t.radius.full, backgroundColor: t.color.bgSunken },
  fill: { height: 6, borderRadius: t.radius.full, backgroundColor: t.color.accent },
  thumb: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: t.color.surface,
    borderWidth: 2,
    borderColor: t.color.accent,
    top: 8,
  },
}));

/** Integer slider (drag or VoiceOver/TalkBack increment/decrement). 44-pt touch height. */
export function Slider({
  value,
  min,
  max,
  onChange,
  label,
  testID,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  testID?: string;
}) {
  const s = useStyles();
  const th = useTheme();
  const [width, setWidth] = useState(0);
  const latest = useRef({ width, min, max, onChange });
  latest.current = { width, min, max, onChange };

  const fromX = (x: number) => {
    const { width: w, min: lo, max: hi } = latest.current;
    if (w <= 0) return lo;
    const ratio = Math.min(1, Math.max(0, (x - 14) / Math.max(1, w - 28)));
    return Math.round(lo + ratio * (hi - lo));
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => latest.current.onChange(fromX(e.nativeEvent.locationX)),
      onPanResponderMove: (e) => latest.current.onChange(fromX(e.nativeEvent.locationX)),
    }),
  ).current;

  const ratio = (value - min) / (max - min);
  const left = ratio * Math.max(0, width - 28);
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e: AccessibilityActionEvent) => {
        const d = e.nativeEvent.actionName === 'increment' ? 1 : -1;
        onChange(Math.min(max, Math.max(min, value + d)));
      }}
      style={s.hit}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      {...pan.panHandlers}
    >
      <View style={s.track}>
        <View style={[s.fill, { width: left + 14 }]} />
      </View>
      <View pointerEvents="none" style={[s.thumb, { left, borderColor: th.color.accent }]} />
    </View>
  );
}
