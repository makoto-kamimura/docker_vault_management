import { type ReactNode, useCallback, useEffect } from 'react';
import { AccessibilityInfo, Pressable, View } from 'react-native';
import Animated, { FadeInUp, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t as tr } from '../i18n';
import { type ToastKind, useToastStore } from '../state/toastStore';
import { makeStyles, useReduceMotion, useTheme } from '../theme';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    paddingHorizontal: t.layout.gutter,
    gap: t.space[2],
  },
  toast: {
    minHeight: t.minTouchTarget,
    borderRadius: t.radius.lg,
    paddingHorizontal: t.space[4],
    paddingVertical: t.space[3],
    justifyContent: 'center',
    shadowColor: t.elevation.md.shadowColor,
    shadowOffset: t.elevation.md.shadowOffset,
    shadowOpacity: t.elevation.md.shadowOpacity,
    shadowRadius: t.elevation.md.shadowRadius,
    elevation: t.elevation.md.elevation,
  },
}));

const DURATION_MS = 3500;

function ToastView({ id, kind, message }: { id: number; kind: ToastKind; message: string }) {
  const t = useTheme();
  const s = useStyles();
  const reduce = useReduceMotion();
  const dismiss = useToastStore((x) => x.dismiss);
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message);
    const timer = setTimeout(() => dismiss(id), DURATION_MS);
    return () => clearTimeout(timer);
  }, [id, message, dismiss]);
  const bg =
    kind === 'error' ? t.color.danger : kind === 'success' ? t.color.success : t.color.text;
  const fg = kind === 'info' ? t.color.bg : '#FFFFFF';
  return (
    <Animated.View
      entering={reduce ? undefined : FadeInUp.duration(t.motion.duration.base)}
      exiting={reduce ? undefined : FadeOut.duration(t.motion.duration.fast)}
    >
      <Pressable
        accessibilityRole="alert"
        accessibilityLabel={message}
        accessibilityHint={tr('a11y.toastClose')}
        onPress={() => dismiss(id)}
        style={[s.toast, { backgroundColor: bg }]}
      >
        <Text variant="footnote" weight="medium" style={{ color: fg }}>
          {message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

/** Renders the toast stack. Mount once inside the providers. */
export function ToastHost() {
  const s = useStyles();
  const insets = useSafeAreaInsets();
  const toasts = useToastStore((x) => x.toasts);
  return (
    <View pointerEvents="box-none" style={[s.host, { paddingTop: insets.top + 8 }]}>
      {toasts.map((x) => (
        <ToastView key={x.id} id={x.id} kind={x.kind} message={x.message} />
      ))}
    </View>
  );
}

/** Wrapper kept for symmetry with other providers; state lives in the zustand store. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <ToastHost />
    </>
  );
}

export function useToast() {
  const push = useToastStore((x) => x.push);
  const show = useCallback(
    (message: string, kind: ToastKind = 'info') => push(kind, message),
    [push],
  );
  return {
    show,
    success: useCallback((m: string) => push('success', m), [push]),
    error: useCallback((m: string) => push('error', m), [push]),
  };
}
