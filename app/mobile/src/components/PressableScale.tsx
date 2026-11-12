import { type ReactNode, useState } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useReduceMotion, useTheme } from '../theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type PressableScaleProps = Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle> | ((state: { pressed: boolean }) => StyleProp<ViewStyle>);
  children?: ReactNode | ((state: { pressed: boolean }) => ReactNode);
  scaleTo?: number;
};

/** Pressable with a subtle press-in scale; no scaling when Reduce Motion is on. */
export function PressableScale({
  style,
  children,
  scaleTo = 0.98,
  onPressIn,
  onPressOut,
  ...rest
}: PressableScaleProps) {
  const t = useTheme();
  const reduce = useReduceMotion();
  const scale = useSharedValue(1);
  // Reanimated animated components do not accept style *functions*, so track `pressed` ourselves.
  const [pressed, setPressed] = useState(false);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const resolvedStyle = typeof style === 'function' ? style({ pressed }) : style;
  const resolvedChildren = typeof children === 'function' ? children({ pressed }) : children;
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        setPressed(true);
        if (!reduce) scale.value = withTiming(scaleTo, { duration: t.motion.duration.fast });
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
        if (!reduce) scale.value = withTiming(1, { duration: t.motion.duration.fast });
        onPressOut?.(e);
      }}
      style={[resolvedStyle, animated]}
    >
      {resolvedChildren}
    </AnimatedPressable>
  );
}
