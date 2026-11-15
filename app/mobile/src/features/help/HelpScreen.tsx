import { View } from 'react-native';
import { Card, Screen, Text } from '../../components';
import { type MessageKey, t } from '../../i18n';
import { nav } from '../../lib/nav';

const SECTIONS: { title: MessageKey; body: MessageKey[] }[] = [
  {
    title: 'help.lost.title',
    body: ['help.lost.1', 'help.lost.2', 'help.lost.3', 'help.lost.4', 'help.lost.note'],
  },
  {
    title: 'help.forgot.title',
    body: ['help.forgot.1', 'help.forgot.2', 'help.forgot.3', 'help.forgot.note'],
  },
  { title: 'help.rc.title', body: ['help.rc.1', 'help.rc.2', 'help.rc.3'] },
  { title: 'help.pc.title', body: ['help.pc.1', 'help.pc.2'] },
];

export function HelpScreen() {
  return (
    <Screen title={t('help.title')} onBack={nav.back}>
      {SECTIONS.map((s) => (
        <Card key={s.title}>
          <View style={{ gap: 8 }}>
            <Text variant="title3" accessibilityRole="header">
              {t(s.title)}
            </Text>
            {s.body.map((k) => (
              <Text key={k} variant="body" tone={k.endsWith('note') ? 'secondary' : 'primary'}>
                {t(k)}
              </Text>
            ))}
          </View>
        </Card>
      ))}
    </Screen>
  );
}
