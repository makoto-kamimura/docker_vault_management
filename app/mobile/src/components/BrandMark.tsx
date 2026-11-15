import { brand, brandMark } from '@localvault/design-tokens';
import Svg, { Circle, Polygon, Rect } from 'react-native-svg';

function pts(xs: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < xs.length; i += 2) out.push(`${xs[i]},${xs[i + 1]}`);
  return out.join(' ');
}

/** The うちカギ mark (brass key with a house-shaped bow on 藍), same art as the app icon. */
export function BrandMark({ size = 72 }: { size?: number }) {
  const m = brandMark;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${m.viewBox} ${m.viewBox}`} accessible={false}>
      <Rect
        width={m.viewBox}
        height={m.viewBox}
        rx={m.tileRadius}
        ry={m.tileRadius}
        fill={brand.ai}
      />
      <Polygon points={pts(m.bow)} fill={brand.brass} />
      <Circle
        cx={m.keyholeCircle.cx}
        cy={m.keyholeCircle.cy}
        r={m.keyholeCircle.r}
        fill={brand.ai}
      />
      <Polygon points={pts(m.keyholeStem)} fill={brand.ai} />
      {m.bars.map(([x, y, w, h]) => (
        <Rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} fill={brand.brass} />
      ))}
    </Svg>
  );
}
