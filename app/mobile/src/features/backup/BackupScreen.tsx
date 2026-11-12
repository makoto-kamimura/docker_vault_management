import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { Download, Upload } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Banner,
  BottomSheet,
  Button,
  ListRow,
  PasswordField,
  Screen,
  Section,
  Text,
  useToast,
} from '../../components';
import { t } from '../../i18n';
import { formatDate } from '../../lib/format';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSession } from '../session/SessionProvider';
import { useAction } from '../settings/useAction';
import {
  exportFlow,
  exportPasswordProblem,
  type ImportStrategy,
  previewImport,
  runImport,
} from './flows';
import { deleteTempFile } from './tempFile';

type Sheet = 'export' | 'import' | null;
type Preview = { itemCount: number; conflictCount: number };

const STRATEGIES: {
  value: ImportStrategy;
  label: 'bk.strategy.append' | 'bk.strategy.newer' | 'bk.strategy.replace';
}[] = [
  { value: 'append', label: 'bk.strategy.append' },
  { value: 'newer', label: 'bk.strategy.newer' },
  { value: 'replace', label: 'bk.strategy.replace' },
];

export function BackupScreen() {
  const { core, engine } = useSession();
  const toast = useToast();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [file, setFile] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [strategy, setStrategy] = useState<ImportStrategy>('append');
  const [result, setResult] = useState<{ added: number; updated: number } | null>(null);
  const act = useAction();

  const loadInfo = useCallback(() => {
    core
      .getBackupInfo()
      .then((b) => setLastExport(b.lastExportAt))
      .catch(() => undefined);
  }, [core]);
  useEffect(loadInfo, [loadInfo]);

  const close = () => {
    if (file) deleteTempFile(file);
    setSheet(null);
    setPw('');
    setAgain('');
    setFile(null);
    setPreview(null);
    setResult(null);
    setStrategy('append');
    act.clear();
  };

  const problem = exportPasswordProblem(pw, again);
  const doExport = async () => {
    const ok = await act.run(async () => {
      await exportFlow(core, pw, async (uri) => {
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
      });
      return true;
    });
    if (ok) {
      haptics.success();
      toast.success(t('bk.exported'));
      loadInfo();
      close();
    }
  };

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (r.canceled) return;
    setFile(r.assets[0]?.uri ?? null);
    setSheet('import');
  };

  const inspect = async () => {
    if (!file) return;
    const p = await act.run(() => previewImport(core, file, pw));
    if (p) setPreview(p);
  };

  const doImport = async () => {
    if (!file) return;
    const r = await act.run(() =>
      runImport(core, file, pw, strategy, () => engine.requestSync('manual')),
    );
    if (r) {
      haptics.success();
      setResult(r);
      deleteTempFile(file);
      setFile(null);
    }
  };

  return (
    <Screen title={t('bk.title')} subtitle={t('bk.lead')} onBack={nav.back}>
      <Section
        title={t('bk.secExport')}
        footer={lastExport ? t('bk.last', { date: formatDate(lastExport) }) : t('bk.never')}
      >
        <ListRow
          testID="bk-export"
          icon={Upload}
          title={t('bk.export')}
          subtitle={t('bk.exportHint')}
          onPress={() => setSheet('export')}
        />
      </Section>
      <Section title={t('bk.secImport')}>
        <ListRow
          testID="bk-import"
          icon={Download}
          title={t('bk.import')}
          subtitle={t('bk.importHint')}
          onPress={pick}
        />
        <ListRow
          testID="bk-csv"
          icon={Download}
          title={t('set.csv')}
          onPress={() => nav.push('/settings/backup/csv')}
        />
      </Section>

      <BottomSheet visible={sheet === 'export'} onClose={close} title={t('bk.export')}>
        <Text variant="body" tone="secondary">
          {t('bk.exportLead')}
        </Text>
        <PasswordField
          testID="bk-export-pw"
          label={t('bk.exportPassword')}
          hint={t('bk.exportPasswordHint')}
          value={pw}
          onChangeText={setPw}
        />
        <PasswordField
          testID="bk-export-pw2"
          label={t('acct.repeatPassword')}
          value={again}
          onChangeText={setAgain}
          error={again !== '' && problem === 'mismatch' ? t('setup.create.error.mismatch') : null}
        />
        <Banner kind="warning" message={t('bk.exportWarn')} />
        {act.error !== null && <Banner kind="danger" message={act.error} />}
        <Button
          testID="bk-export-go"
          label={t('bk.exportGo')}
          loading={act.busy}
          disabled={problem !== null}
          onPress={doExport}
        />
      </BottomSheet>

      <BottomSheet visible={sheet === 'import'} onClose={close} title={t('bk.import')}>
        {result ? (
          <>
            <Banner
              kind="success"
              message={t('bk.importDone', { added: result.added, updated: result.updated })}
            />
            <Button label={t('common.done')} onPress={close} />
          </>
        ) : preview ? (
          <>
            <Banner
              kind="info"
              message={t('bk.preview', {
                items: preview.itemCount,
                conflicts: preview.conflictCount,
              })}
            />
            <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
              {STRATEGIES.map((s) => (
                <Button
                  key={s.value}
                  testID={`bk-strategy-${s.value}`}
                  variant={strategy === s.value ? 'primary' : 'secondary'}
                  label={t(s.label)}
                  onPress={() => setStrategy(s.value)}
                />
              ))}
            </View>
            {strategy === 'replace' && <Banner kind="danger" message={t('bk.replaceWarn')} />}
            {act.error !== null && <Banner kind="danger" message={act.error} />}
            <Button
              testID="bk-import-go"
              variant={strategy === 'replace' ? 'danger' : 'primary'}
              label={t('bk.importGo')}
              loading={act.busy}
              onPress={doImport}
            />
          </>
        ) : (
          <>
            <PasswordField
              testID="bk-import-pw"
              label={t('bk.importPassword')}
              value={pw}
              onChangeText={setPw}
            />
            {act.error !== null && <Banner kind="danger" message={act.error} />}
            <Button
              testID="bk-inspect"
              label={t('bk.inspect')}
              loading={act.busy}
              disabled={pw === ''}
              onPress={inspect}
            />
          </>
        )}
      </BottomSheet>
    </Screen>
  );
}
