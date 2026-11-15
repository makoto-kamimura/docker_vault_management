// Shown while key derivation runs (account creation, restore, password unlock). With the
// development core PBKDF2 runs in JavaScript (Hermes has no JIT) and takes minutes, so the screen
// says how long to expect, shows the elapsed time, and keeps the device awake: an auto-lock moves
// the app to the background, which stops the work.
import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Banner, ProgressSteps } from '../../components';
import { t } from '../../i18n';
import { formatElapsed } from '../../lib/elapsed';
import { useTheme } from '../../theme';
import { useSession } from './SessionProvider';

/** Seconds before the notice appears, so fast (native) work does not flash it. */
const SHOW_AFTER_SEC = 2;

type Props = {
  active: boolean;
  /** Optional step indicator shown from the start. */
  steps?: readonly string[];
  current?: number;
};

export function LongTaskNotice({ active, steps, current = 0 }: Props) {
  return active ? <ActiveNotice steps={steps} current={current} /> : null;
}

function ActiveNotice({ steps, current }: { steps?: readonly string[]; current: number }) {
  useKeepAwake('lv-long-task');
  const th = useTheme();
  const { kind } = useSession();
  const [sec, setSec] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <View style={{ gap: th.space[3] }}>
      {steps !== undefined && <ProgressSteps steps={steps} current={current} />}
      {sec >= SHOW_AFTER_SEC && (
        <Banner
          kind="info"
          title={t('longTask.elapsed', { time: formatElapsed(sec) })}
          message={kind === 'dev' ? t('longTask.dev') : t('longTask.native')}
        />
      )}
    </View>
  );
}
