import { forwardRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

type TextInputRef = React.ComponentRef<typeof TextInput>;

import { formatRecoveryKeyInput } from '../lib/recoveryKeyInput';
import { makeStyles, useTheme } from '../theme';
import { Text } from './Text';
import { TextField } from './TextField';

const useStyles = makeStyles((t) => ({
  digitsRow: { flexDirection: 'row', gap: t.space[3], justifyContent: 'center' },
  digitBox: {
    width: 56,
    height: 68,
    borderRadius: t.radius.lg,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.color.surface,
  },
  hidden: { position: 'absolute', opacity: 0, width: 1, height: 1 },
}));

export type DigitCodeInputProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  length?: number;
  error?: string | null;
  autoFocus?: boolean;
};

/** Numeric code boxes (e.g. the 2-digit PC unlock code, §8.4). */
export function DigitCodeInput({
  label,
  value,
  onChange,
  length = 2,
  error,
  autoFocus,
}: DigitCodeInputProps) {
  const t = useTheme();
  const s = useStyles();
  const [focused, setFocused] = useState(false);
  let ref: TextInputRef | null = null;
  return (
    <View style={{ gap: t.space[2] }}>
      <Text variant="footnote" weight="medium" tone="secondary" align="center">
        {label}
      </Text>
      <Pressable
        accessibilityRole="none"
        accessible={false}
        onPress={() => ref?.focus()}
        style={s.digitsRow}
      >
        {Array.from({ length }, (_, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length positional boxes
            key={i}
            style={[
              s.digitBox,
              {
                borderColor: error
                  ? t.color.danger
                  : focused && i === Math.min(value.length, length - 1)
                    ? t.color.focusRing
                    : t.color.border,
              },
            ]}
          >
            <Text variant="title1">{value[i] ?? ''}</Text>
          </View>
        ))}
      </Pressable>
      <TextInput
        ref={(r) => {
          ref = r;
        }}
        style={s.hidden}
        value={value}
        autoFocus={autoFocus}
        keyboardType="number-pad"
        maxLength={length}
        accessibilityLabel={label}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChangeText={(v) => onChange(v.replace(/\D/g, '').slice(0, length))}
      />
      {error ? (
        <Text variant="footnote" tone="danger" align="center" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export type RecoveryKeyInputProps = {
  label: string;
  value: string;
  onChange: (formatted: string) => void;
  hint?: string;
  error?: string | null;
  autoFocus?: boolean;
};

/** Recovery key entry: live-formatted into `LV2-XXXX-…` groups (spec §5.5). */
export const RecoveryKeyInput = forwardRef<TextInputRef, RecoveryKeyInputProps>(
  function RecoveryKeyInput({ label, value, onChange, hint, error, autoFocus }, ref) {
    return (
      <TextField
        ref={ref}
        mono
        label={label}
        hint={hint}
        error={error}
        autoFocus={autoFocus}
        value={value}
        onChangeText={(v) => onChange(formatRecoveryKeyInput(v))}
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        importantForAutofill="no"
        keyboardType="ascii-capable"
        placeholder="LV2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
        multiline={false}
      />
    );
  },
);
