import { View } from 'react-native';
import { makeStyles, useTheme } from '../theme';
import { Text } from './Text';

const useStyles = makeStyles((t) => ({
  pill: {
    paddingHorizontal: t.space[2],
    paddingVertical: 2,
    borderRadius: t.radius.full,
    alignSelf: 'flex-start',
  },
}));

/** Small status pill ("この端末", "解除済み"). */
export function Badge({
  label,
  tone = 'accent',
}: {
  label: string;
  tone?: 'accent' | 'neutral' | 'danger';
}) {
  const s = useStyles();
  const t = useTheme();
  const bg =
    tone === 'accent'
      ? t.color.accentSubtle
      : tone === 'danger'
        ? t.color.dangerSubtle
        : t.color.bgSunken;
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      <Text
        variant="caption"
        weight="medium"
        tone={tone === 'accent' ? 'accent' : tone === 'danger' ? 'danger' : 'secondary'}
      >
        {label}
      </Text>
    </View>
  );
}
