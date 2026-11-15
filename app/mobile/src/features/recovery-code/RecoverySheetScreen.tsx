import { File } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, QrCode, Screen, Text, TextField, useToast } from '../../components';
import { t } from '../../i18n';
import { getFlagStore } from '../../lib/flagStore';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { setScreenCaptureProtected } from '../../native/privacy';
import { confirmSheetFlow, tailMatches } from './flows';
import { sheetHolder } from './sheetHolder';
import { buildSheetHtml } from './sheetHtml';

function deleteQuietly(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // best effort
  }
}

export function RecoverySheetScreen() {
  const toast = useToast();
  const held = useRef(sheetHolder.peek());
  const [tail, setTail] = useState('');
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);

  useEffect(() => {
    setScreenCaptureProtected(true);
    return () => {
      setScreenCaptureProtected(false);
      // The RC leaves JS memory when the user leaves this screen.
      sheetHolder.clear();
      held.current = null;
    };
  }, []);

  useEffect(() => {
    if (!held.current) nav.replace('/settings/recovery-code');
  }, []);

  const h = held.current;
  if (!h) return null;
  const html = () =>
    buildSheetHtml({
      sheet: h.sheet,
      serverUrl: h.serverUrl,
      accountName: h.accountName,
      waitHours: h.waitSec / 3600,
      createdAt: new Date(),
    });

  const exportPdf = async (kind: 'pdf' | 'print') => {
    setBusy(kind);
    try {
      if (kind === 'print') await Print.printAsync({ html: html() });
      else {
        const { uri } = await Print.printToFileAsync({ html: html() });
        try {
          if (await Sharing.isAvailableAsync())
            await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
        } finally {
          deleteQuietly(uri);
        }
      }
    } catch {
      toast.error(t('rc.pdfFailed'));
    } finally {
      setBusy(null);
    }
  };

  const ok = tailMatches(h.sheet.text, tail);
  const groups = h.sheet.text.split('-');

  return (
    <Screen
      title={t('rc.sheetTitle')}
      subtitle={t('rc.sheetLead')}
      footer={
        <Button
          testID="rc-sheet-done"
          label={t('rc.sheetDone')}
          disabled={!ok}
          onPress={async () => {
            await confirmSheetFlow(getFlagStore()).catch(() => undefined);
            haptics.success();
            nav.replace('/settings/recovery-code');
          }}
        />
      }
    >
      <Banner kind="warning" message={t('rc.sheetWarn')} />
      <Card>
        <View style={{ alignItems: 'center', gap: 16 }}>
          <QrCode value={h.sheet.qr} size={220} label={t('rc.qrLabel')} />
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}
            accessible
            accessibilityLabel={groups.join(' ')}
          >
            {groups.map((g, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional groups
              <Text key={i} variant="mono">
                {g}
              </Text>
            ))}
          </View>
        </View>
      </Card>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Button
            testID="rc-pdf"
            variant="secondary"
            label={t('setup.kit.savePdf')}
            loading={busy === 'pdf'}
            onPress={() => exportPdf('pdf')}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            testID="rc-print"
            variant="secondary"
            label={t('setup.kit.print')}
            loading={busy === 'print'}
            onPress={() => exportPdf('print')}
          />
        </View>
      </View>
      <Text variant="footnote" tone="tertiary">
        {t('rc.deleteFile')}
      </Text>
      <TextField
        testID="rc-tail"
        mono
        label={t('rc.tailLabel')}
        hint={ok ? t('setup.kit.tailOk') : t('rc.tailHint')}
        error={tail.replace(/[\s-]/g, '').length >= 6 && !ok ? t('rc.tailWrong') : null}
        value={tail}
        onChangeText={(v) => setTail(v.slice(0, 8))}
        autoCapitalize="characters"
        autoCorrect={false}
        spellCheck={false}
      />
    </Screen>
  );
}
