import { EyeOff, KeyRound, WifiOff } from 'lucide-react-native';
import { View } from 'react-native';
import { BrandMark, Button, Screen, Text } from '../../components';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { makeStyles, useTheme } from '../../theme';

const useStyles = makeStyles((th) => ({
  hero: { alignItems: 'flex-start', gap: th.space[4], paddingTop: th.space[6] },
  point: {
    flexDirection: 'row',
    gap: th.space[4],
    padding: th.space[4],
    backgroundColor: th.color.surface,
    borderRadius: th.radius.xl,
    borderWidth: 1,
    borderColor: th.color.border,
  },
  pointIcon: {
    width: 40,
    height: 40,
    borderRadius: th.radius.md,
    backgroundColor: th.color.accentSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pointText: { flex: 1, gap: th.space[1] },
  hint: { textAlign: 'center' },
}));

export function WelcomeScreen() {
  const th = useTheme();
  const s = useStyles();
  const points = [
    { icon: EyeOff, title: t('setup.welcome.point1.title'), body: t('setup.welcome.point1.body') },
    {
      icon: KeyRound,
      title: t('setup.welcome.point2.title'),
      body: t('setup.welcome.point2.body'),
    },
    { icon: WifiOff, title: t('setup.welcome.point3.title'), body: t('setup.welcome.point3.body') },
  ];
  return (
    <Screen
      footer={
        <>
          <Button
            testID="welcome-start"
            label={t('setup.welcome.start')}
            onPress={() => nav.push('/setup/server')}
          />
          <Button
            testID="welcome-restore-code"
            variant="ghost"
            label={t('setup.welcome.restoreCode')}
            accessibilityHint={t('setup.welcome.restoreCodeHint')}
            onPress={() => nav.push('/setup/restore-code')}
          />
        </>
      }
    >
      <View style={s.hero}>
        <BrandMark size={72} />
        <Text variant="largeTitle" accessibilityRole="header">
          {t('setup.welcome.title')}
        </Text>
        <Text variant="body" tone="secondary">
          {t('setup.welcome.lead')}
        </Text>
      </View>
      {points.map((p) => (
        <View key={p.title} style={s.point}>
          <View style={s.pointIcon}>
            <p.icon size={20} color={th.color.accent} />
          </View>
          <View style={s.pointText}>
            <Text variant="callout" weight="semibold">
              {p.title}
            </Text>
            <Text variant="footnote" tone="secondary">
              {p.body}
            </Text>
          </View>
        </View>
      ))}
    </Screen>
  );
}
