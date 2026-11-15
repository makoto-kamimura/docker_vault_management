import { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { Banner, Button, Card, Screen, Text } from '../../components';
import { type MessageKey, t } from '../../i18n';
import { nav } from '../../lib/nav';
import { useSetupDraft } from '../../state/setupDraft';
import { makeStyles } from '../../theme';
import { useSession } from '../session/SessionProvider';

const useStyles = makeStyles((th) => ({
  step: { flexDirection: 'row', gap: th.space[3], alignItems: 'flex-start' },
  num: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: th.color.accentSubtle,
  },
  steps: { gap: th.space[4] },
}));

export function AutofillScreen() {
  const { core } = useSession();
  const s = useStyles();
  const draft = useSetupDraft();
  const [status, setStatus] = useState<{ supported: boolean; enabled: boolean } | null>(null);

  useEffect(() => {
    core
      .getAutofillStatus()
      .then(setStatus)
      .catch(() => setStatus({ supported: false, enabled: false }));
  }, [core]);

  const os = Platform.OS === 'android' ? 'android' : 'ios';
  const keys = [1, 2, 3].map((n) => `setup.autofill.${os}.step${n}` as MessageKey);
  const finish = () => {
    draft.clear();
    nav.replace('/');
  };
  const statusText = !status
    ? ''
    : !status.supported
      ? t('setup.autofill.status.unsupported')
      : status.enabled
        ? t('setup.autofill.status.on')
        : t('setup.autofill.status.off');

  return (
    <Screen
      title={t('setup.autofill.title')}
      subtitle={t('setup.autofill.lead')}
      footer={
        <>
          {status?.supported && !status.enabled && (
            <Button
              testID="autofill-enable"
              label={t('setup.autofill.enable')}
              onPress={async () => {
                const ok = await core.requestEnableAutofill().catch(() => false);
                setStatus((p) => (p ? { ...p, enabled: ok } : p));
              }}
            />
          )}
          <Button
            testID="autofill-finish"
            variant={status?.enabled ? 'primary' : 'ghost'}
            label={status?.enabled ? t('setup.autofill.finish') : t('setup.autofill.later')}
            onPress={finish}
          />
        </>
      }
    >
      {status && <Banner kind={status.enabled ? 'success' : 'info'} message={statusText} />}
      <Card>
        <View style={s.steps}>
          {keys.map((k, i) => (
            <View key={k} style={s.step}>
              <View style={s.num}>
                <Text variant="footnote" weight="bold" tone="accent">
                  {i + 1}
                </Text>
              </View>
              <Text variant="body" style={{ flex: 1 }}>
                {t(k)}
              </Text>
            </View>
          ))}
        </View>
      </Card>
    </Screen>
  );
}
