import * as Notifications from 'expo-notifications';
import { Bell } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import { Banner, Button, Screen, Text } from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { makeStyles, useTheme } from '../../theme';
import { useSession } from '../session/SessionProvider';

const useStyles = makeStyles((th) => ({
  badge: {
    alignSelf: 'center',
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: th.color.accentSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: th.space[6],
  },
}));

/** Registers the native (APNs / FCM) token with our own server. Failures are not fatal. */
async function registerPushToken(api: ReturnType<typeof useSession>['api']): Promise<void> {
  const token = await Notifications.getDevicePushTokenAsync();
  await api.call('putPushToken', {
    body: { pushPlatform: Platform.OS === 'ios' ? 'apns' : 'fcm', token: String(token.data) },
  });
}

export function NotificationsScreen() {
  const { api } = useSession();
  const s = useStyles();
  const th = useTheme();
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const next = () => nav.replace('/setup/autofill');

  const enable = async () => {
    setBusy(true);
    try {
      const res = await Notifications.requestPermissionsAsync();
      if (!res.granted) {
        setDenied(true);
        haptics.warning();
        return;
      }
      haptics.success();
      await registerPushToken(api).catch(() => undefined);
      next();
    } catch {
      setDenied(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={t('setup.notif.title')}
      subtitle={t('setup.notif.lead')}
      footer={
        <>
          {!denied && (
            <Button
              testID="notif-enable"
              label={t('setup.notif.enable')}
              loading={busy}
              onPress={enable}
            />
          )}
          <Button
            testID="notif-skip"
            variant={denied ? 'primary' : 'ghost'}
            label={denied ? t('common.next') : t('common.skip')}
            onPress={next}
          />
        </>
      }
    >
      <View style={s.badge}>
        <Bell size={52} color={th.color.accent} strokeWidth={1.5} />
      </View>
      {denied ? (
        <Banner kind="info" message={t('setup.notif.denied')} />
      ) : (
        <Text variant="footnote" tone="tertiary" align="center">
          {t('setup.notif.note')}
        </Text>
      )}
    </Screen>
  );
}
