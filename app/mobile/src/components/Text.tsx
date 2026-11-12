import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { useTheme } from '../theme';

export type TextVariant =
  | 'largeTitle'
  | 'title1'
  | 'title2'
  | 'title3'
  | 'body'
  | 'callout'
  | 'footnote'
  | 'caption'
  | 'mono';

export type TextTone =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'accent'
  | 'danger'
  | 'success'
  | 'warning'
  | 'onAccent';

export type TextProps = RNTextProps & {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold';
  align?: TextStyle['textAlign'];
};

const DEFAULT_WEIGHT: Record<TextVariant, 'regular' | 'medium' | 'semibold' | 'bold'> = {
  largeTitle: 'bold',
  title1: 'bold',
  title2: 'semibold',
  title3: 'semibold',
  body: 'regular',
  callout: 'regular',
  footnote: 'regular',
  caption: 'regular',
  mono: 'medium',
};

/** Themed text. Scales with Dynamic Type / fontScale (capped so layouts survive). */
export function Text({
  variant = 'body',
  tone = 'primary',
  weight,
  align,
  style,
  maxFontSizeMultiplier = 1.6,
  ...rest
}: TextProps) {
  const t = useTheme();
  const base = variant === 'mono' ? 'callout' : variant;
  const colorMap: Record<TextTone, string> = {
    primary: t.color.text,
    secondary: t.color.textSecondary,
    tertiary: t.color.textTertiary,
    accent: t.color.accent,
    danger: t.color.danger,
    success: t.color.success,
    warning: t.color.warning,
    onAccent: t.color.onAccent,
  };
  const resolved: TextStyle = {
    color: colorMap[tone],
    fontSize: t.fontSize[base],
    lineHeight: t.lineHeight[base],
    fontWeight: t.fontWeight[weight ?? DEFAULT_WEIGHT[variant]],
    textAlign: align,
    fontVariant: variant === 'mono' ? ['tabular-nums'] : undefined,
    fontFamily: variant === 'mono' ? 'Menlo' : undefined,
  };
  return (
    <RNText maxFontSizeMultiplier={maxFontSizeMultiplier} style={[resolved, style]} {...rest} />
  );
}
