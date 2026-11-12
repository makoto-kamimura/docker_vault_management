import type { ReactNode } from 'react';
import { Modal, Pressable, View } from 'react-native';
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t as tr } from '../i18n';
import { makeStyles, useReduceMotion, useTheme } from '../theme';
import { Button } from './Button';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  fill: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    ...({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const),
    backgroundColor: t.color.overlay,
  },
  sheet: {
    backgroundColor: t.color.bgElevated,
    borderTopLeftRadius: t.radius.xl,
    borderTopRightRadius: t.radius.xl,
    paddingHorizontal: t.layout.gutter,
    paddingTop: t.space[3],
    gap: t.space[4],
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: t.radius.full,
    backgroundColor: t.color.border,
  },
}));

export function BottomSheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const s = useStyles();
  const t = useTheme();
  const reduce = useReduceMotion();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={s.fill} accessibilityViewIsModal>
        <Animated.View
          entering={reduce ? undefined : FadeIn.duration(t.motion.duration.base)}
          exiting={reduce ? undefined : FadeOut.duration(t.motion.duration.fast)}
          style={s.backdrop}
        >
          <Pressable
            style={{ flex: 1 }}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={tr('common.close')}
          />
        </Animated.View>
        <Animated.View
          entering={reduce ? undefined : SlideInDown.duration(t.motion.duration.slow)}
          exiting={reduce ? undefined : SlideOutDown.duration(t.motion.duration.base)}
          style={[s.sheet, { paddingBottom: Math.max(insets.bottom, t.space[4]) }]}
        >
          <View style={s.grabber} />
          {title !== undefined && (
            <Text variant="title2" accessibilityRole="header">
              {title}
            </Text>
          )}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel,
  cancelLabel = tr('common.cancel'),
  destructive,
  loading,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <BottomSheet visible={visible} onClose={onCancel} title={title}>
      <Text variant="body" tone="secondary">
        {message}
      </Text>
      <View style={{ gap: 8 }}>
        <Button
          label={confirmLabel}
          variant={destructive ? 'danger' : 'primary'}
          loading={loading}
          onPress={onConfirm}
        />
        <Button label={cancelLabel} variant="ghost" onPress={onCancel} disabled={loading} />
      </View>
    </BottomSheet>
  );
}
