import { Eye, EyeOff } from 'lucide-react-native';
import { forwardRef, type ReactNode, useState } from 'react';
import { t } from '../i18n';
import { IconButton } from './IconButton';
import { TextField, type TextFieldProps, type TextInputRef } from './TextField';

export type PasswordFieldProps = Omit<
  TextFieldProps,
  'secureTextEntry' | 'accessory' | 'autoCapitalize' | 'autoCorrect'
> & {
  /** Slot below the field for a strength meter. */
  meter?: ReactNode;
};

/** Secure input with a reveal toggle. Autocorrect, suggestions and capitalisation are disabled. */
export const PasswordField = forwardRef<TextInputRef, PasswordFieldProps>(function PasswordField(
  { meter, ...rest },
  ref,
) {
  const [revealed, setRevealed] = useState(false);
  return (
    <>
      <TextField
        ref={ref}
        secureTextEntry={!revealed}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        textContentType="none"
        importantForAutofill="no"
        accessory={
          <IconButton
            icon={revealed ? EyeOff : Eye}
            label={revealed ? t('a11y.hidePassword') : t('a11y.revealPassword')}
            onPress={() => setRevealed((v) => !v)}
          />
        }
        {...rest}
      />
      {meter}
    </>
  );
});
