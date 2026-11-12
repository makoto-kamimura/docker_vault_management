import { Switch, View } from 'react-native';
import { haptics } from '../lib/haptics';
import { makeStyles, useTheme } from '../theme';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.space[3],
    paddingHorizontal: t.space[4],
    paddingVertical: t.space[3],
  },
  text: { flex: 1, gap: 2 },
}));

export function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled,
  testID,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={s.row}>
      <View style={s.text}>
        <Text variant="callout">{title}</Text>
        {subtitle !== undefined && (
          <Text variant="footnote" tone="secondary">
            {subtitle}
          </Text>
        )}
      </View>
      <Switch
        testID={testID}
        value={value}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityHint={subtitle}
        onValueChange={(v) => {
          haptics.select();
          onValueChange(v);
        }}
        trackColor={{ false: t.color.border, true: t.color.accent }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={t.color.border}
      />
    </View>
  );
}

/** Checkbox-style consent row (FR-03): a SwitchRow that reads as an agreement. */
export function ConsentRow(props: {
  title: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  testID?: string;
}) {
  return <SwitchRow {...props} />;
}
