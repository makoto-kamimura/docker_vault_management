import { VaultCoreError } from '@localvault/core';
import { ScanFace } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Screen, useToast } from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { makeStyles, useTheme } from '../../theme';
import { useSession } from '../session/SessionProvider';

type Kind = 'faceId' | 'touchId' | 'biometric' | 'none';

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

export function BiometricsScreen() {
  const { core } = useSession();
  const s = useStyles();
  const th = useTheme();
  const toast = useToast();
  const [kind, setKind] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    core.getBiometricAvailability().then((a) => setKind(a.available ? a.kind : 'none'));
  }, [core]);

  const label = kind && kind !== 'none' ? t(`setup.bio.kind.${kind}`) : '';
  const next = () => nav.replace('/setup/notifications');

  const enable = async () => {
    setBusy(true);
    try {
      await core.enableBiometrics();
      haptics.success();
      toast.success(t('setup.bio.enabled'));
      next();
    } catch (e) {
      haptics.error();
      if (!(e instanceof VaultCoreError && e.code === 'E_AUTH_CANCELED'))
        toast.error(t('setup.bio.failed'));
    } finally {
      setBusy(false);
    }
  };

  const unavailable = kind === 'none';
  return (
    <Screen
      title={t('setup.bio.title')}
      subtitle={kind && !unavailable ? t('setup.bio.lead', { kind: label }) : undefined}
      footer={
        <>
          {!unavailable && (
            <Button
              testID="bio-enable"
              label={t('setup.bio.enable', { kind: label })}
              loading={busy}
              disabled={kind === null}
              onPress={enable}
            />
          )}
          <Button
            testID="bio-skip"
            variant={unavailable ? 'primary' : 'ghost'}
            label={unavailable ? t('common.next') : t('common.skip')}
            onPress={next}
          />
        </>
      }
    >
      <View style={s.badge}>
        <ScanFace size={56} color={th.color.accent} strokeWidth={1.5} />
      </View>
      {unavailable && <Banner kind="info" message={t('setup.bio.unavailable')} />}
    </Screen>
  );
}
