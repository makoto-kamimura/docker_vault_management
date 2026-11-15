import { useEffect, useState } from 'react';
import { formatDuration } from '../i18n';
import { Text, type TextProps } from './Text';

/** Ticks once per second towards `targetMs`; calls `onElapsed` once when it reaches zero. */
export function Countdown({
  targetMs,
  onElapsed,
  now = Date.now,
  ...text
}: {
  targetMs: number;
  onElapsed?: () => void;
  now?: () => number;
} & Omit<TextProps, 'children'>) {
  const [remainingSec, setRemainingSec] = useState(() =>
    Math.max(0, Math.ceil((targetMs - now()) / 1000)),
  );
  useEffect(() => {
    let fired = false;
    const tick = () => {
      const r = Math.max(0, Math.ceil((targetMs - now()) / 1000));
      setRemainingSec(r);
      if (r === 0 && !fired) {
        fired = true;
        onElapsed?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetMs, onElapsed, now]);
  return (
    <Text
      variant="mono"
      accessibilityRole="timer"
      accessibilityLabel={`${Math.floor(remainingSec / 3600)}時間${Math.floor((remainingSec % 3600) / 60)}分${remainingSec % 60}秒`}
      {...text}
    >
      {formatDuration(remainingSec)}
    </Text>
  );
}
