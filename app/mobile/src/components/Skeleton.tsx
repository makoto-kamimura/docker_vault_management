import { useEffect } from 'react';
import type { DimensionValue, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useReduceMotion, useTheme } from '../theme';

/** Placeholder block; pulses unless Reduce Motion is on. */
export function Skeleton({
  width = '100%',
  height = 16,
  radius,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const o = useSharedValue(1);
  useEffect(() => {
    if (reduce) {
      o.value = 0.7;
      return;
    }
    o.value = withRepeat(
      withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [reduce, o]);
  const a = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <Animated.View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[
        { width, height, borderRadius: radius ?? t.radius.md, backgroundColor: t.color.border },
        a,
        style,
      ]}
    />
  );
}
