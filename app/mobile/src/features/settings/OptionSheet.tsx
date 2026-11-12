import { Check } from 'lucide-react-native';
import { View } from 'react-native';
import { BottomSheet, PressableScale, Text } from '../../components';
import { type MessageKey, t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { makeStyles, useTheme } from '../../theme';
import type { Option } from './options';

const useStyles = makeStyles((th) => ({
  row: {
    minHeight: 48,
    paddingHorizontal: th.space[2],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
}));

/** Single-choice picker in a bottom sheet. */
export function OptionSheet<V>({
  visible,
  title,
  options,
  value,
  onSelect,
  onClose,
}: {
  visible: boolean;
  title: MessageKey;
  options: readonly Option<V>[];
  value: V;
  onSelect: (v: V) => void;
  onClose: () => void;
}) {
  const s = useStyles();
  const th = useTheme();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t(title)}>
      <View accessibilityRole="radiogroup">
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <PressableScale
              key={String(o.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={t(o.label)}
              onPress={() => {
                haptics.select();
                onSelect(o.value);
                onClose();
              }}
              style={s.row}
            >
              <Text variant="body" weight={selected ? 'semibold' : 'regular'}>
                {t(o.label)}
              </Text>
              {selected && <Check size={20} color={th.color.accent} />}
            </PressableScale>
          );
        })}
      </View>
    </BottomSheet>
  );
}
