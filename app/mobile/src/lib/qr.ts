// Local QR generation (no network). Wraps qrcode-generator.
import qrcode from 'qrcode-generator';

export type QrMatrix = { size: number; isDark: (row: number, col: number) => boolean };

export function createQrMatrix(text: string, ecc: 'L' | 'M' | 'Q' | 'H' = 'M'): QrMatrix {
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return { size, isDark: (r, c) => qr.isDark(r, c) };
}

/** SVG path data covering all dark modules (one `M x y h1 v1 h-1 z` per module, merged per row run). */
export function qrPathData(m: QrMatrix): string {
  let d = '';
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (m.isDark(r, c)) {
        let run = 1;
        while (c + run < m.size && m.isDark(r, c + run)) run++;
        d += `M${c} ${r}h${run}v1h-${run}z`;
        c += run;
      } else c++;
    }
  }
  return d;
}

/** Standalone SVG string (quiet zone included) for the printable emergency kit. */
export function qrSvgString(text: string, pixelSize: number, quiet = 4): string {
  const m = createQrMatrix(text);
  const total = m.size + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}" viewBox="${-quiet} ${-quiet} ${total} ${total}" shape-rendering="crispEdges"><rect x="${-quiet}" y="${-quiet}" width="${total}" height="${total}" fill="#fff"/><path d="${qrPathData(m)}" fill="#000"/></svg>`;
}
