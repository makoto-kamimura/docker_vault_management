import { GENERATOR_MAX_LENGTH, GENERATOR_MIN_LENGTH } from '@localvault/core';
import { Copy, RefreshCw } from 'lucide-react-native';
import { View } from 'react-native';
import { Button, Card, Screen, Slider, StrengthMeter, SwitchRow, Text } from '../../components';
import { t } from '../../i18n';
import { nav } from '../../lib/nav';
import { makeStyles } from '../../theme';
import { canDisable, classKeys } from './options';
import { useGenerator } from './useGenerator';

const useStyles = makeStyles((th) => ({
  value: { gap: th.space[3] },
  mono: { fontSize: 20, lineHeight: 30 },
  stack: { gap: th.space[1] },
}));

export function GeneratorScreen() {
  const s = useStyles();
  const g = useGenerator();
  const o = g.options;
  return (
    <Screen
      testID="generator-screen"
      title={t('gen.title')}
      onBack={nav.back}
      footer={
        <View style={{ gap: 8, paddingBottom: 12 }}>
          <Button testID="gen-use" label={t('gen.use')} onPress={g.use} disabled={g.value === ''} />
        </View>
      }
    >
      <Card>
        <View style={s.value}>
          <Text variant="mono" style={s.mono} testID="gen-value" selectable>
            {g.value}
          </Text>
          <StrengthMeter password={g.value} />
          <Button
            variant="secondary"
            icon={Copy}
            label={t('gen.copy')}
            testID="gen-copy"
            onPress={() => void g.copy()}
            disabled={g.value === ''}
          />
          <Button
            variant="secondary"
            icon={RefreshCw}
            label={t('gen.regenerate')}
            testID="gen-regenerate"
            onPress={() => void g.regenerate()}
          />
        </View>
      </Card>
      <Card>
        <View style={s.stack}>
          <Text weight="medium">{t('gen.length', { n: o.length })}</Text>
          <Slider
            testID="gen-length"
            label={t('gen.length', { n: o.length })}
            value={o.length}
            min={GENERATOR_MIN_LENGTH}
            max={GENERATOR_MAX_LENGTH}
            onChange={g.setLength}
          />
        </View>
      </Card>
      <Card>
        {classKeys.map((k) => (
          <SwitchRow
            key={k}
            title={t(`gen.${k}`)}
            value={o[k]}
            disabled={o[k] && !canDisable(o, k)}
            onValueChange={() => g.toggleClass(k)}
          />
        ))}
        <SwitchRow
          title={t('gen.ambiguous')}
          subtitle={t('gen.ambiguousHint')}
          value={o.excludeAmbiguous}
          onValueChange={g.toggleAmbiguous}
        />
      </Card>
    </Screen>
  );
}
