import { Lock, ScanFace } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner, BottomSheet, Button, PasswordField, Screen, Text } from '../../components';
import { t } from '../../i18n';
import { makeStyles, useTheme } from '../../theme';
import { formatThrottle, useUnlock } from './useUnlock';

const useStyles = makeStyles((th) => ({
  head: {
    alignItems: 'center',
    gap: th.space[3],
    paddingTop: th.space[10],
    paddingBottom: th.space[4],
  },
  badge: {
    width: 88,
    height: 88,
    borderRadius: th.radius.xl,
    backgroundColor: th.color.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

export function UnlockScreen() {
  const s = useStyles();
  const th = useTheme();
  const u = useUnlock();
  const [forgot, setForgot] = useState(false);
  const throttled = u.throttleSec > 0;
  const bioLabel = u.bioKind ? t(`setup.bio.kind.${u.bioKind}`) : '';

  return (
    <Screen
      scroll
      footer={
        <>
          <Button
            testID="unlock-submit"
            label={t('unlock.submit')}
            loading={u.busy}
            disabled={u.password === '' || throttled}
            onPress={u.submit}
          />
          {u.bioKind !== null && (
            <Button
              testID="unlock-bio"
              variant="secondary"
              icon={ScanFace}
              label={t('unlock.biometric', { kind: bioLabel })}
              disabled={u.busy}
              onPress={u.tryBiometrics}
            />
          )}
          <Button
            testID="unlock-forgot"
            variant="ghost"
            label={t('unlock.forgot')}
            onPress={() => setForgot(true)}
          />
        </>
      }
    >
      <View style={s.head}>
        <View style={s.badge}>
          <Lock size={40} color={th.color.onAccent} strokeWidth={1.75} />
        </View>
        <Text variant="largeTitle" accessibilityRole="header">
          {t('unlock.title')}
        </Text>
        <Text variant="body" tone="secondary" align="center">
          {t('unlock.lead')}
        </Text>
      </View>
      {u.bioInvalidated && <Banner kind="warning" message={t('unlock.bioInvalidated')} />}
      <PasswordField
        testID="unlock-password"
        label={t('unlock.password')}
        value={u.password}
        onChangeText={u.setPassword}
        editable={!throttled}
        returnKeyType="go"
        onSubmitEditing={u.submit}
        textContentType="password"
        error={throttled ? formatThrottle(u.throttleSec) : u.error}
      />
      <BottomSheet
        visible={forgot}
        onClose={() => setForgot(false)}
        title={t('unlock.forgotTitle')}
      >
        <Text variant="body" tone="secondary">
          {t('unlock.forgotBody')}
        </Text>
        <View style={{ gap: 8 }}>
          {u.bioKind !== null && (
            <Button
              label={t('unlock.forgotBio')}
              onPress={() => {
                setForgot(false);
                void u.tryBiometrics();
              }}
            />
          )}
          <Button variant="ghost" label={t('common.close')} onPress={() => setForgot(false)} />
        </View>
      </BottomSheet>
    </Screen>
  );
}
