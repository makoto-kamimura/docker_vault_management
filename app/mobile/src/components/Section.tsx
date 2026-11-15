import { Children, type ReactNode } from 'react';
import { View } from 'react-native';
import { makeStyles } from '../theme';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  wrap: { gap: t.space[2] },
  card: {
    backgroundColor: t.color.surface,
    borderRadius: t.radius.xl,
    borderWidth: 1,
    borderColor: t.color.border,
    overflow: 'hidden',
  },
  divider: { height: 1, backgroundColor: t.color.border, marginLeft: t.space[4] },
  header: { paddingHorizontal: t.space[2] },
}));

/** Titled group of rows rendered as one soft card with hairline dividers. */
export function Section({
  title,
  footer,
  children,
}: {
  title?: string;
  footer?: string;
  children: ReactNode;
}) {
  const s = useStyles();
  const items = Children.toArray(children);
  return (
    <View style={s.wrap}>
      {title !== undefined && (
        <Text
          variant="footnote"
          weight="medium"
          tone="secondary"
          style={s.header}
          accessibilityRole="header"
        >
          {title}
        </Text>
      )}
      <View style={s.card}>
        {items.map((child, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static children order
          <View key={i}>
            {i > 0 && <View style={s.divider} />}
            {child}
          </View>
        ))}
      </View>
      {footer !== undefined && (
        <Text variant="footnote" tone="tertiary" style={s.header}>
          {footer}
        </Text>
      )}
    </View>
  );
}

/** A plain rounded card for free-form content. */
export function Card({
  children,
  tone = 'surface',
}: {
  children: ReactNode;
  tone?: 'surface' | 'subtle' | 'danger';
}) {
  const s = useStyles();
  return (
    <View
      style={[s.card, { padding: 16 }, tone === 'subtle' && { backgroundColor: 'transparent' }]}
    >
      {children}
    </View>
  );
}
