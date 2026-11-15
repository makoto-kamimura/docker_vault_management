import { useEffect, useState } from 'react';
import { Banner, Button, Card, Screen, Text, TextField, useToast } from '../../components';
import { t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { getVaultCoreHandle } from '../../native/VaultCore';
import { useSyncStore } from '../../state/syncStore';
import { useSession } from '../session/SessionProvider';
import { changeServerFlow, ServerChangeError } from './serverFlows';
import { useAction } from './useAction';

export function ServerScreen() {
  const { core, makeApi, tokens, engine } = useSession();
  const toast = useToast();
  const sync = useSyncStore((s) => s.status);
  const [current, setCurrent] = useState('');
  const [version, setVersion] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const act = useAction();

  useEffect(() => {
    core
      .getAccountInfo()
      .then((i) => {
        setCurrent(i.serverUrl);
        makeApi(i.serverUrl)
          .call('health')
          .then((h) => setVersion(h.version))
          .catch(() => undefined);
      })
      .catch(() => undefined);
  }, [core, makeApi]);

  const change = async () => {
    setLocal(null);
    const ok = await act.run(async () => {
      try {
        await changeServerFlow({ core, makeApi, fetchImpl: getVaultCoreHandle().fetch, input });
        return true;
      } catch (e) {
        if (e instanceof ServerChangeError) {
          setLocal(t(`srv.err.${e.reason}`));
          return false;
        }
        throw e;
      }
    });
    if (ok) {
      tokens.clear();
      haptics.success();
      toast.success(t('srv.changed'));
      void engine.requestSync('manual');
      nav.back();
    }
  };

  return (
    <Screen
      title={t('srv.title')}
      subtitle={t('srv.lead')}
      onBack={nav.back}
      footer={
        <Button
          testID="srv-change"
          label={t('srv.change')}
          loading={act.busy}
          disabled={input.trim() === ''}
          onPress={change}
        />
      }
    >
      <Card>
        <Text variant="footnote" tone="secondary">
          {t('srv.current')}
        </Text>
        <Text variant="callout">{current}</Text>
        <Text variant="footnote" tone="tertiary">
          {version ? `v${version}` : ''} {sync.kind === 'synced' ? t('sync.synced') : ''}
        </Text>
      </Card>
      <TextField
        testID="srv-input"
        label={t('srv.newUrl')}
        hint={t('srv.hint')}
        value={input}
        onChangeText={setInput}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Banner kind="info" message={t('srv.note')} />
      {local !== null && <Banner kind="danger" message={local} />}
      {act.clockSkew && <Banner kind="warning" message={t('error.clockSkew')} />}
      {act.error !== null && !act.clockSkew && <Banner kind="danger" message={act.error} />}
    </Screen>
  );
}
