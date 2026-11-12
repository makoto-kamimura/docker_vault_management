import { avatarColorFor, avatarLetterFor } from '@localvault/design-tokens';
import { View } from 'react-native';
import { Text } from './Text';

/** Letter avatar (FR-24): colour is derived deterministically from the title. No network images. */
export function Avatar({ title, size = 40 }: { title: string; size?: number }) {
  const { background, foreground } = avatarColorFor(title);
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        weight="semibold"
        maxFontSizeMultiplier={1.2}
        style={{ color: foreground, fontSize: size * 0.45, lineHeight: size * 0.6 }}
      >
        {avatarLetterFor(title)}
      </Text>
    </View>
  );
}
