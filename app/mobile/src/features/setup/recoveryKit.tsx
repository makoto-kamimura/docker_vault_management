import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Banner,
  Button,
  Card,
  ConsentRow,
  Screen,
  Section,
  Text,
  TextField,
  useToast,
} from '../../components';
import { t } from '../../i18n';
import { constantTimeEqual } from '../../lib/constantTime';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { normalizeTailInput, recoveryKeyTail } from '../../lib/recoveryKeyInput';
import { setScreenCaptureProtected } from '../../native/privacy';
import { useSetupDraft } from '../../state/setupDraft';
import { makeStyles } from '../../theme';
import { useSession } from '../session/SessionProvider';
import { printKit, shareKitPdf } from './kitPdf';

const useStyles = makeStyles((th) => ({
  keyBox: { gap: th.space[3], alignItems: 'center' },
  groups: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: th.space[2] },
  group: {
    paddingHorizontal: th.space[3],
    paddingVertical: th.space[2],
    borderRadius: th.radius.md,
    backgroundColor: th.color.bgSunken,
  },
  row: { flexDirection: 'row', gap: th.space[3] },
  grow: { flex: 1 },
}));

export function RecoveryKitScreen() {
  const s = useStyles();
  const toast = useToast();
  const { core } = useSession();
  const draft = useSetupDraft();
  const key = draft.recoveryKey;
  const [tail, setTail] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);

  useEffect(() => {
    setScreenCaptureProtected(true);
    return () => setScreenCaptureProtected(false);
  }, []);

  // No key in memory (e.g. app restarted): nothing to show here, leave the flow.
  useEffect(() => {
    if (key === null) nav.replace('/setup/biometrics');
  }, [key]);

  if (key === null) return null;
  const expectedTail = recoveryKeyTail(key);
  const tailTyped = normalizeTailInput(tail);
  const tailOk = tailTyped.length === 4 && constantTimeEqual(tailTyped, expectedTail);
  const tailWrong = tailTyped.length === 4 && !tailOk;
  const groups = key.split('-');
  const kit = { serverUrl: draft.serverUrl, accountName: draft.accountName, recoveryKey: key };

  const doExport = async (kind: 'pdf' | 'print') => {
    setBusy(kind);
    try {
      if (kind === 'pdf') await shareKitPdf(kit);
      else await printKit(kit);
    } catch {
      toast.error(t('setup.kit.pdfFailed'));
    } finally {
      setBusy(null);
    }
  };

  const finish = () => {
    haptics.success();
    // The key leaves memory as soon as the user confirmed having written it down.
    draft.setRecoveryKey(null);
    // Make sure VaultCore is reachable for the next step even if state changed meanwhile.
    void core.getLockState();
    nav.replace('/setup/biometrics');
  };

  return (
    <Screen
      title={t('setup.kit.title')}
      subtitle={t('setup.kit.lead')}
      footer={
        <Button
          testID="kit-continue"
          label={t('setup.kit.continue')}
          disabled={!(tailOk && consent)}
          onPress={finish}
        />
      }
    >
      <Card>
        <View
          style={s.keyBox}
          accessible
          accessibilityLabel={`${t('setup.kit.keyLabel')} ${groups.join(' ')}`}
        >
          <Text variant="footnote" tone="secondary" weight="medium">
            {t('setup.kit.keyLabel')}
          </Text>
          <View style={s.groups}>
            {groups.map((g, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional groups
              <View key={i} style={s.group}>
                <Text variant="mono" style={{ fontSize: 17 }}>
                  {g}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </Card>
      <Banner kind="warning" message={t('setup.kit.warning')} />
      <View style={s.row}>
        <View style={s.grow}>
          <Button
            testID="kit-pdf"
            variant="secondary"
            label={t('setup.kit.savePdf')}
            loading={busy === 'pdf'}
            onPress={() => doExport('pdf')}
          />
        </View>
        <View style={s.grow}>
          <Button
            testID="kit-print"
            variant="secondary"
            label={t('setup.kit.print')}
            loading={busy === 'print'}
            onPress={() => doExport('print')}
          />
        </View>
      </View>
      <TextField
        testID="kit-tail"
        mono
        label={t('setup.kit.tailLabel')}
        hint={tailOk ? t('setup.kit.tailOk') : t('setup.kit.tailHint')}
        error={tailWrong ? t('setup.kit.tailWrong') : null}
        value={tail}
        onChangeText={(v) => setTail(v.slice(0, 7))}
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
        maxLength={7}
      />
      <Section>
        <ConsentRow
          testID="kit-consent"
          title={t('setup.kit.consent')}
          value={consent}
          onValueChange={setConsent}
        />
      </Section>
    </Screen>
  );
}
