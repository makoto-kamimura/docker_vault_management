import type { TrustedBrowser } from '@localvault/core';
import { Globe, Trash2 } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Banner,
  Button,
  IconButton,
  ListRow,
  Screen,
  Section,
  TextField,
} from '../../components';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { useSession } from '../session/SessionProvider';
import { useAction } from './useAction';

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export function TrustedBrowsersScreen() {
  const { core } = useSession();
  const [list, setList] = useState<TrustedBrowser[]>([]);
  const [pkg, setPkg] = useState('');
  const act = useAction();

  const load = useCallback(() => {
    core
      .listTrustedBrowsers()
      .then(setList)
      .catch(() => undefined);
  }, [core]);
  useEffect(load, [load]);

  const add = async () => {
    const ok = await act.run(async () => {
      await core.addTrustedBrowser(pkg.trim());
      return true;
    });
    if (ok) {
      setPkg('');
      load();
    }
  };
  const remove = async (p: string) => {
    const ok = await act.run(async () => {
      await core.removeTrustedBrowser(p);
      return true;
    });
    if (ok) load();
  };

  return (
    <Screen title={t('tb.title')} subtitle={t('tb.lead')} onBack={nav.back}>
      {act.error !== null && <Banner kind="danger" message={act.error} />}
      <Section title={t('tb.list')}>
        {list.map((b) => (
          <ListRow
            key={b.packageName}
            icon={Globe}
            title={b.label}
            subtitle={b.packageName}
            chevron={false}
            trailing={
              b.builtIn ? (
                <Badge label={t('tb.builtIn')} tone="neutral" />
              ) : (
                <IconButton
                  icon={Trash2}
                  tone="danger"
                  label={t('tb.remove', { name: b.label })}
                  onPress={() => remove(b.packageName)}
                />
              )
            }
          />
        ))}
      </Section>
      <TextField
        testID="tb-input"
        label={t('tb.add')}
        hint={t('tb.addHint')}
        value={pkg}
        onChangeText={setPkg}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button
        testID="tb-add"
        label={t('tb.addButton')}
        loading={act.busy}
        disabled={!PACKAGE_RE.test(pkg.trim())}
        onPress={add}
      />
    </Screen>
  );
}
