import { ChevronLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t as tr } from '../i18n';
import { makeStyles, useReduceMotion, useTheme } from '../theme';
import { IconButton } from './IconButton';
import { Text } from './Text';

export type ScreenProps = {
  children: ReactNode;
  /** Large title shown at the top of the content. */
  title?: string;
  subtitle?: string;
  /** Fixed footer (primary actions), above the keyboard. */
  footer?: ReactNode;
  /** Right-aligned element in the title row. */
  headerRight?: ReactNode;
  /** Disable the scroll view (content must then fit). */
  scroll?: boolean;
  /** Reserve the top safe area (false when a native header is shown). */
  topInset?: boolean;
  /** Shows a back chevron above the title. */
  onBack?: () => void;
  testID?: string;
};

const useStyles = makeStyles((t) => ({
  root: { flex: 1, backgroundColor: t.color.bg },
  content: { paddingHorizontal: t.layout.gutter, paddingBottom: t.space[6], gap: t.space[4] },
  backRow: { marginLeft: -t.space[2], marginBottom: -t.space[2] },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: t.space[3],
    paddingTop: t.space[2],
  },
  titles: { flex: 1, gap: t.space[2] },
  footer: {
    paddingHorizontal: t.layout.gutter,
    paddingTop: t.space[3],
    gap: t.space[2],
    borderTopWidth: 1,
    borderTopColor: t.color.border,
    backgroundColor: t.color.bg,
  },
}));

/** Safe area + keyboard avoidance + optional large title. */
export function Screen({
  children,
  title,
  subtitle,
  footer,
  headerRight,
  scroll = true,
  topInset = true,
  onBack,
  testID,
}: ScreenProps) {
  const s = useStyles();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();

  const body = (
    <Animated.View
      entering={reduce ? undefined : FadeInDown.duration(t.motion.duration.slow)}
      style={scroll ? s.content : [s.content, { flex: 1 }]}
    >
      {onBack !== undefined && (
        <View style={s.backRow}>
          <IconButton icon={ChevronLeft} label={tr('common.back')} onPress={onBack} />
        </View>
      )}
      {title !== undefined && (
        <View style={s.titleRow}>
          <View style={s.titles}>
            <Text variant="largeTitle" accessibilityRole="header">
              {title}
            </Text>
            {subtitle !== undefined && (
              <Text variant="body" tone="secondary">
                {subtitle}
              </Text>
            )}
          </View>
          {headerRight}
        </View>
      )}
      {children}
    </Animated.View>
  );

  return (
    <KeyboardAvoidingView
      testID={testID}
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={{ flex: 1, paddingTop: topInset ? insets.top : 0 }}>
        {scroll ? (
          <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            contentInsetAdjustmentBehavior="never"
            showsVerticalScrollIndicator={false}
          >
            {body}
          </ScrollView>
        ) : (
          body
        )}
      </View>
      {footer !== undefined && (
        <View style={[s.footer, { paddingBottom: Math.max(insets.bottom, t.space[4]) }]}>
          {footer}
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
