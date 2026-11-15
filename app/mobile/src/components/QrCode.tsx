import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { t } from '../i18n';
import { createQrMatrix, qrPathData } from '../lib/qr';

/** QR code rendered locally from `value`. Always black on white for scanner reliability. */
export function QrCode({
  value,
  size = 200,
  label = t('a11y.qrCode'),
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const quiet = 3;
  const { d, total } = useMemo(() => {
    const m = createQrMatrix(value);
    return { d: qrPathData(m), total: m.size + quiet * 2 };
  }, [value]);
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`${-quiet} ${-quiet} ${total} ${total}`}
      accessibilityLabel={label}
      accessibilityRole="image"
    >
      <Rect x={-quiet} y={-quiet} width={total} height={total} fill="#FFFFFF" />
      <Path d={d} fill="#000000" />
    </Svg>
  );
}
