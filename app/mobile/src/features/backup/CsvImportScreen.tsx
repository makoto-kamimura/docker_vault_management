import * as DocumentPicker from 'expo-document-picker';
import { FileSpreadsheet } from 'lucide-react-native';
import { useState } from 'react';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ListRow,
  Screen,
  Section,
  SwitchRow,
  Text,
} from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSession } from '../session/SessionProvider';
import { useAction } from '../settings/useAction';
import { runCsvImport } from './flows';
import { deleteTempFile } from './tempFile';

type Inspect = Awaited<ReturnType<import('@localvault/core').VaultCore['inspectCsvImport']>>;

export function CsvImportScreen() {
  const { core, engine } = useSession();
  const [file, setFile] = useState<string | null>(null);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [skipDup, setSkipDup] = useState(true);
  const [done, setDone] = useState<{ added: number; skipped: number } | null>(null);
  const act = useAction();

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: ['text/csv', 'text/comma-separated-values', 'text/plain'],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (r.canceled) return;
    const uri = r.assets[0]?.uri;
    if (!uri) return;
    setFile(uri);
    const i = await act.run(() => core.inspectCsvImport(uri));
    if (i) setInfo(i);
    else deleteTempFile(uri);
  };

  const run = async () => {
    if (!file) return;
    const r = await act.run(() =>
      runCsvImport(core, file, skipDup, () => engine.requestSync('manual')),
    );
    if (r) {
      haptics.success();
      deleteTempFile(file); // our cache copy; the user's original is theirs to delete
      setFile(null);
      setDone(r);
    }
  };

  if (done) {
    return (
      <Screen
        footer={
          <Button
            testID="csv-done"
            label={t('common.done')}
            onPress={() => nav.replace('/settings')}
          />
        }
      >
        <EmptyState
          icon={FileSpreadsheet}
          title={t('csv.doneTitle')}
          message={t('csv.doneBody', { added: done.added, skipped: done.skipped })}
        />
        <Banner kind="warning" title={t('csv.deleteTitle')} message={t('csv.deleteBody')} />
      </Screen>
    );
  }

  return (
    <Screen
      title={t('csv.title')}
      subtitle={t('csv.lead')}
      onBack={nav.back}
      footer={
        info ? (
          <Button
            testID="csv-import"
            label={t('csv.import', { n: info.itemCount - (skipDup ? info.duplicateCount : 0) })}
            loading={act.busy}
            disabled={info.itemCount === 0}
            onPress={run}
          />
        ) : (
          <Button testID="csv-pick" label={t('csv.pick')} loading={act.busy} onPress={pick} />
        )
      }
    >
      {act.error !== null && <Banner kind="danger" message={act.error} />}
      {!info && <Banner kind="info" message={t('csv.formats')} />}
      {info && (
        <>
          <Section title={t('csv.preview')}>
            <ListRow
              title={t('csv.format')}
              chevron={false}
              trailing={<Text variant="callout">{t(`csv.fmt.${info.format}`)}</Text>}
            />
            <ListRow
              title={t('csv.rows')}
              chevron={false}
              trailing={<Text variant="callout">{info.itemCount}</Text>}
            />
            <ListRow
              title={t('csv.duplicates')}
              subtitle={t('csv.duplicatesHint')}
              chevron={false}
              trailing={<Text variant="callout">{info.duplicateCount}</Text>}
            />
            <ListRow
              title={t('csv.skipped')}
              subtitle={t('csv.skippedHint')}
              chevron={false}
              trailing={<Text variant="callout">{info.skippedCount}</Text>}
            />
          </Section>
          <Section>
            <SwitchRow
              testID="csv-skipdup"
              title={t('csv.skipDup')}
              value={skipDup}
              onValueChange={setSkipDup}
            />
          </Section>
          <Card tone="subtle">
            <Text variant="footnote" tone="secondary">
              {t('csv.deleteBody')}
            </Text>
          </Card>
        </>
      )}
    </Screen>
  );
}
