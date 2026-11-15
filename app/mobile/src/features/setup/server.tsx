import { useState } from 'react';
import { View } from 'react-native';
import { checkServerUrl } from '../../api';
import { Banner, Button, ListRow, Screen, Section, TextField } from '../../components';
import { type MessageKey, t } from '../../i18n';
import { haptics } from '../../lib/haptics';
import { nav } from '../../lib/nav';
import { useSetupDraft } from '../../state/setupDraft';
import { describeError } from '../errors/messages';
import { useSession } from '../session/SessionProvider';

type Check =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'ok'; origin: string; version: string; mode: 'open' | 'invite' | 'closed' }
  | { phase: 'failed'; message: string };

const REASON: Record<string, MessageKey> = {
  invalid: 'setup.server.error.invalid',
  not_https: 'setup.server.error.notHttps',
  has_path: 'setup.server.error.hasPath',
  has_credentials: 'setup.server.error.hasCredentials',
};

export function ServerScreen() {
  const { makeApi } = useSession();
  const draft = useSetupDraft();
  const [url, setUrl] = useState(draft.serverUrl);
  const [check, setCheck] = useState<Check>({ phase: 'idle' });

  const run = async () => {
    const parsed = checkServerUrl(url);
    if (!parsed.ok) {
      haptics.error();
      setCheck({
        phase: 'failed',
        message: t(REASON[parsed.reason] ?? 'setup.server.error.invalid'),
      });
      return;
    }
    setCheck({ phase: 'checking' });
    try {
      const h = await makeApi(parsed.origin).call('health');
      haptics.success();
      setUrl(parsed.origin);
      draft.setServer(parsed.origin, h.registrationMode);
      setCheck({
        phase: 'ok',
        origin: parsed.origin,
        version: h.version,
        mode: h.registrationMode,
      });
    } catch (e) {
      haptics.error();
      setCheck({ phase: 'failed', message: describeError(e) });
    }
  };

  return (
    <Screen title={t('setup.server.title')} subtitle={t('setup.server.lead')} onBack={nav.back}>
      <TextField
        testID="server-url"
        label={t('setup.server.urlLabel')}
        value={url}
        onChangeText={(v) => {
          setUrl(v);
          if (check.phase !== 'idle') setCheck({ phase: 'idle' });
        }}
        placeholder={t('setup.server.urlPlaceholder')}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="go"
        onSubmitEditing={run}
        error={check.phase === 'failed' ? check.message : null}
      />
      <Button
        testID="server-check"
        variant={check.phase === 'ok' ? 'secondary' : 'primary'}
        label={check.phase === 'checking' ? t('setup.server.checking') : t('setup.server.check')}
        loading={check.phase === 'checking'}
        disabled={url.trim() === ''}
        onPress={run}
      />
      {check.phase === 'ok' && (
        <View style={{ gap: 16 }}>
          <Banner
            kind={check.mode === 'closed' ? 'warning' : 'success'}
            title={t('setup.server.ok')}
            message={`${t('setup.server.okDetail', { version: check.version })}\n${t(`setup.server.mode.${check.mode}`)}`}
          />
          <Section>
            <ListRow
              testID="server-create"
              title={t('setup.server.createNew')}
              subtitle={t('setup.server.createNewHint')}
              disabled={check.mode === 'closed'}
              onPress={() => nav.push('/setup/create')}
            />
            <ListRow
              testID="server-restore"
              title={t('setup.server.restoreExisting')}
              subtitle={t('setup.server.restoreExistingHint')}
              onPress={() => nav.push('/setup/restore')}
            />
          </Section>
        </View>
      )}
    </Screen>
  );
}
