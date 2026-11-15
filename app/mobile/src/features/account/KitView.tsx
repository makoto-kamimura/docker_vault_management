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
import { normalizeTailInput, recoveryKeyTail } from '../../lib/recoveryKeyInput';
import { setScreenCaptureProtected } from '../../native/privacy';
import { makeStyles } from '../../theme';
import { printKit, shareKitPdf } from '../setup/kitPdf';

const useStyles = makeStyles((th) => ({
  groups: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: th.space[2] },
  group: {
    paddingHorizontal: th.space[3],
    paddingVertical: th.space[2],
    borderRadius: th.radius.md,
    backgroundColor: th.color.bgSunken,
  },
  row: { flexDirection: 'row', gap: th.space[3] },
}));

export type KitData = { serverUrl: string; accountName: string; recoveryKey: string };

/** Emergency kit display for FR-102/103 (the W3 setup helpers for PDF/print are reused). */
export function KitView({
  kit,
  title,
  onDone,
}: {
  kit: KitData;
  title: string;
  onDone: () => void;
}) {
  const s = useStyles();
  const toast = useToast();
  const [tail, setTail] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);

  useEffect(() => {
    setScreenCaptureProtected(true);
    return () => setScreenCaptureProtected(false);
  }, []);

  const typed = normalizeTailInput(tail);
  const tailOk = typed.length === 4 && constantTimeEqual(typed, recoveryKeyTail(kit.recoveryKey));
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

  return (
    <Screen
      title={title}
      subtitle={t('setup.kit.lead')}
      footer={
        <Button
          testID="kit-done"
          label={t('setup.kit.continue')}
          disabled={!(tailOk && consent)}
          onPress={() => {
            haptics.success();
            onDone();
          }}
        />
      }
    >
      <Card>
        <View
          style={s.groups}
          accessible
          accessibilityLabel={`${t('setup.kit.keyLabel')} ${kit.recoveryKey.split('-').join(' ')}`}
        >
          {kit.recoveryKey.split('-').map((g, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional groups
            <View key={i} style={s.group}>
              <Text variant="mono" style={{ fontSize: 17 }}>
                {g}
              </Text>
            </View>
          ))}
        </View>
      </Card>
      <Banner kind="warning" message={t('setup.kit.warning')} />
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Button
            variant="secondary"
            label={t('setup.kit.savePdf')}
            loading={busy === 'pdf'}
            onPress={() => doExport('pdf')}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
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
        error={typed.length === 4 && !tailOk ? t('setup.kit.tailWrong') : null}
        value={tail}
        onChangeText={(v) => setTail(v.slice(0, 7))}
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
        maxLength={7}
      />
      <Section>
        <ConsentRow title={t('setup.kit.consent')} value={consent} onValueChange={setConsent} />
      </Section>
    </Screen>
  );
}
