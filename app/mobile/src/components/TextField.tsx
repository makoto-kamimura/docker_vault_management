import { forwardRef, type ReactNode, useState } from 'react';
import { TextInput, type TextInputProps, View } from 'react-native';

export type TextInputRef = React.ComponentRef<typeof TextInput>;

import { makeStyles, useTheme } from '../theme';
import { Text } from './Text';

export type TextFieldProps = Omit<TextInputProps, 'style' | 'placeholderTextColor'> & {
  label: string;
  hint?: string;
  error?: string | null;
  /** Element at the right edge inside the field (e.g. the reveal toggle). */
  accessory?: ReactNode;
  /** Monospaced input (codes, keys). */
  mono?: boolean;
};

const useStyles = makeStyles((t) => ({
  wrap: { gap: t.space[2] },
  box: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: t.radius.lg,
    borderWidth: 1.5,
    backgroundColor: t.color.surface,
    paddingLeft: t.space[4],
    paddingRight: t.space[2],
  },
  input: {
    flex: 1,
    minHeight: t.minTouchTarget,
    fontSize: t.fontSize.callout,
    color: t.color.text,
    paddingVertical: t.space[2],
    paddingRight: t.space[2],
  },
}));

/** Labelled text input with hint and error states. */
export const TextField = forwardRef<TextInputRef, TextFieldProps>(function TextField(
  { label, hint, error, accessory, mono, onFocus, onBlur, ...rest },
  ref,
) {
  const t = useTheme();
  const s = useStyles();
  const [focused, setFocused] = useState(false);
  const borderColor = error ? t.color.danger : focused ? t.color.focusRing : t.color.border;
  return (
    <View style={s.wrap}>
      <Text variant="footnote" weight="medium" tone="secondary">
        {label}
      </Text>
      <View style={[s.box, { borderColor }]}>
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={hint}
          placeholderTextColor={t.color.textTertiary}
          selectionColor={t.color.accent}
          keyboardAppearance={t.name}
          maxFontSizeMultiplier={1.6}
          style={[s.input, mono && { fontFamily: 'Menlo', letterSpacing: 0.5 }]}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          {...rest}
        />
        {accessory}
      </View>
      {error ? (
        <Text variant="footnote" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="footnote" tone="tertiary">
          {hint}
        </Text>
      ) : null}
    </View>
  );
});
