import { View } from 'react-native';
import { Banner, ProgressBar, Text } from '../../components';
import { t } from '../../i18n';
import { makeStyles } from '../../theme';
import { type RotationProgress, rotationPercent } from './flows';

const useStyles = makeStyles((th) => ({
  wrap: { gap: th.space[4], paddingVertical: th.space[4] },
}));

function phaseLabel(p: RotationProgress | null): string {
  switch (p?.phase) {
    case 'revoke':
      return t('rot.phase.revoke');
    case 'start':
      return t('rot.phase.start');
    case 'staging':
      return t('rot.phase.staging', { done: p.done, total: p.total });
    case 'commit':
      return t('rot.phase.commit');
    case 'finish':
      return t('rot.phase.finish');
    default:
      return t('rot.phase.revoke');
  }
}

/** Determinate view for the many requests of a key rotation. */
export function RotationProgressView({ progress }: { progress: RotationProgress | null }) {
  const s = useStyles();
  const label = phaseLabel(progress);
  return (
    <View style={s.wrap}>
      <Text variant="title3" accessibilityRole="header">
        {t('rot.title')}
      </Text>
      <ProgressBar value={rotationPercent(progress)} label={label} />
      <Text variant="callout" tone="secondary" accessibilityLiveRegion="polite">
        {label}
      </Text>
      <Banner kind="warning" message={t('rot.keepOpen')} />
    </View>
  );
}
