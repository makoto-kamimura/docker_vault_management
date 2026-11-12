import { ShieldAlert } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, ConfirmDialog, Screen, useToast } from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useLockStore } from '../../state/lockStore';
import { useSetupDraft } from '../../state/setupDraft';
import { makeStyles, useTheme } from '../../theme';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';

const useStyles = makeStyles((th) => ({
  badge: {
    alignSelf: 'flex-start',
    width: 72,
    height: 72,
    borderRadius: th.radius.xl,
    backgroundColor: th.color.dangerSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: th.space[6],
  },
}));

/** G1 (device revoked) and G3 (account deleted elsewhere). */
export function RevokedScreen() {
  const { core } = useSession();
  const s = useStyles();
  const th = useTheme();
  const toast = useToast();
  const standing = useLockStore((x) => x.standing);
  const setStanding = useLockStore((x) => x.setStanding);
  const setLockState = useLockStore((x) => x.setLockState);
  const draft = useSetupDraft();
  const [confirm, setConfirm] = useState<'wipe' | 'reregister' | null>(null);
  const [busy, setBusy] = useState(false);
  const deleted = standing === 'accountDeleted';

  const wipe = async (then: 'welcome' | 'restore') => {
    setBusy(true);
    try {
      // Remember where to re-register before the account info disappears.
      if (then === 'restore') {
        const info = await core.getAccountInfo().catch(() => null);
        if (info) {
          draft.setServer(info.serverUrl, 'open');
          draft.setAccountName(info.accountName);
        }
      }
      await core.wipeLocal();
      haptics.success();
      setStanding('ok');
      setLockState(await core.getLockState());
      setConfirm(null);
      nav.replace(then === 'restore' ? '/setup/restore' : '/setup');
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      footer={
        deleted ? (
          <Button
            testID="revoked-wipe"
            label={t('deleted.wipe')}
            variant="danger"
            onPress={() => wipe('welcome')}
            loading={busy}
          />
        ) : (
          <>
            <Button
              testID="revoked-reregister"
              label={t('revoked.reregister')}
              onPress={() => setConfirm('reregister')}
            />
            <Button
              testID="revoked-wipe"
              variant="danger"
              label={t('revoked.wipe')}
              onPress={() => setConfirm('wipe')}
            />
          </>
        )
      }
    >
      <View style={s.badge}>
        <ShieldAlert size={36} color={th.color.danger} strokeWidth={1.75} />
      </View>
      <View style={{ gap: 12 }}>
        <Banner
          kind="danger"
          title={deleted ? t('deleted.title') : t('revoked.title')}
          message={deleted ? t('deleted.lead') : t('revoked.lead')}
        />
        {!deleted && <Banner kind="info" message={t('revoked.reregisterHint')} />}
      </View>
      <ConfirmDialog
        visible={confirm !== null}
        title={t('revoked.wipeConfirmTitle')}
        message={t('revoked.wipeConfirmBody')}
        confirmLabel={confirm === 'reregister' ? t('revoked.reregister') : t('revoked.wipe')}
        destructive={confirm === 'wipe'}
        loading={busy}
        onConfirm={() => wipe(confirm === 'reregister' ? 'restore' : 'welcome')}
        onCancel={() => setConfirm(null)}
      />
    </Screen>
  );
}
