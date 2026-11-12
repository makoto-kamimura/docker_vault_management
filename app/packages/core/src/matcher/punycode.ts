// Host normalisation without the `URL` global (Hermes' URL is incomplete) — spec §9.1 step 1.
// Punycode is RFC 3492; the IDNA mapping is the practical subset NFKC + lower-case, which gives
// identical results on every platform (the point of test T-10).

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digit(d: number): string {
  return String.fromCharCode(d < 26 ? 97 + d : 22 + d); // a-z, then 0-9 (22 + 26 = 48)
}

/** RFC 3492 encoding of one label (without the `xn--` prefix). */
export function punycodeEncode(input: string): string {
  const cps = Array.from(input, (c) => c.codePointAt(0) as number);
  let out = '';
  for (const c of cps) if (c < INITIAL_N) out += String.fromCharCode(c);
  const basic = out.length;
  let h = basic;
  if (basic > 0) out += '-';
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (h < cps.length) {
    let m = Number.MAX_SAFE_INTEGER;
    for (const c of cps) if (c >= n && c < m) m = c;
    delta += (m - n) * (h + 1);
    n = m;
    for (const c of cps) {
      if (c < n) delta++;
      if (c === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
          if (q < t) break;
          out += digit(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        out += digit(q);
        bias = adapt(delta, h + 1, h === basic);
        delta = 0;
        h++;
      }
    }
    delta++;
    n++;
  }
  return out;
}

const LABEL_MAX = 63;
const HOST_MAX = 253;
const ASCII_LABEL = /^[a-z0-9_-]+$/;
const DELIMITERS = '/\\?#@:%[]';

/** Whitespace, control characters and URL delimiters can never be part of a host label. */
function hasForbiddenChar(label: string): boolean {
  for (const ch of label) {
    const cp = ch.codePointAt(0) as number;
    if (cp <= 0x20 || cp === 0x7f || DELIMITERS.includes(ch) || /\s/u.test(ch)) return true;
  }
  return false;
}

function isAscii(label: string): boolean {
  for (let i = 0; i < label.length; i++) if (label.charCodeAt(i) > 0x7f) return false;
  return true;
}

/**
 * Lower-case ASCII (Punycode) form of a host name, or null if it is not a plausible host.
 * One trailing dot is removed; ideographic full stops count as dots; ports are NOT handled here.
 */
export function toAsciiHost(host: string): string | null {
  let h = host.normalize('NFKC').toLowerCase().replaceAll('。', '.');
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.length === 0) return null;
  const labels: string[] = [];
  for (const label of h.split('.')) {
    if (label.length === 0 || hasForbiddenChar(label)) return null;
    const ascii = isAscii(label) ? label : `xn--${punycodeEncode(label)}`;
    if (!ASCII_LABEL.test(ascii) || ascii.length > LABEL_MAX) return null;
    labels.push(ascii);
  }
  const result = labels.join('.');
  return result.length > HOST_MAX ? null : result;
}
