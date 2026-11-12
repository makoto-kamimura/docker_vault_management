import { QrCode as QrIcon } from 'lucide-react-native';
import { useState } from 'react';
import {
  BottomSheet,
  Button,
  QrScanner,
  Screen,
  Text,
  TextField,
  useToast,
} from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSetupDraft } from '../../state/setupDraft';
import { describeClaimError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';
import { FlowInputError, startClaimFlow } from './flows';

export function RestoreCodeScreen() {
  const { core, makeApi } = useSession();
  const toast = useToast();
  const draft = useSetupDraft();
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState(draft.serverUrl);
  const [accountName, setAccountName] = useState('');
  const [text, setText] = useState('');

  const run = async (source: Parameters<typeof startClaimFlow>[0]['source']) => {
    setBusy(true);
    try {
      await startClaimFlow({ core, makeApi, source });
      haptics.success();
      nav.replace('/setup/restore-wait');
    } catch (e) {
      haptics.error();
      toast.error(
        e instanceof FlowInputError ? t('setup.restoreCode.scanBad') : describeClaimError(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={t('setup.restoreCode.title')}
      subtitle={t('setup.restoreCode.lead')}
      onBack={busy ? undefined : nav.back}
    >
      <Button
        testID="code-scan"
        icon={QrIcon}
        label={t('setup.restoreCode.scan')}
        loading={busy && !manual}
        onPress={() => setScanning(true)}
      />
      {!manual ? (
        <Button
          testID="code-manual"
          variant="ghost"
          label={t('setup.restoreCode.manual')}
          onPress={() => setManual(true)}
        />
      ) : (
        <>
          <TextField
            label={t('setup.restoreCode.serverUrl')}
            value={serverUrl}
            onChangeText={setServerUrl}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextField
            label={t('setup.restoreCode.accountName')}
            value={accountName}
            onChangeText={setAccountName}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextField
            mono
            label={t('setup.restoreCode.text')}
            hint={t('setup.restoreCode.textHint')}
            value={text}
            onChangeText={setText}
            autoCapitalize="characters"
            autoCorrect={false}
            spellCheck={false}
          />
          <Button
            label={busy ? t('setup.restoreCode.submitting') : t('setup.restoreCode.submit')}
            loading={busy}
            disabled={serverUrl === '' || accountName === '' || text === ''}
            onPress={() => run({ kind: 'manual', serverUrl, accountName, text })}
          />
        </>
      )}
      <BottomSheet
        visible={scanning}
        onClose={() => setScanning(false)}
        title={t('setup.restoreCode.scan')}
      >
        <QrScanner
          active={scanning && !busy}
          onScan={(data) => {
            setScanning(false);
            void run({ kind: 'qr', data });
          }}
        />
        <Text variant="footnote" tone="tertiary" align="center">
          {t('qr.hint')}
        </Text>
      </BottomSheet>
    </Screen>
  );
}
