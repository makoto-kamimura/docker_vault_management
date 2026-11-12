// Public Suffix List — spec §9.1 step 3 (PRIVATE section included) and step 5.
// Rules are stored in ASCII/Punycode so lookups work on normalised hosts.
import { toAsciiHost } from './punycode';

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IPv4 literal or bracketed IPv6 literal. IPs always match by exact host only. */
export function isIpHost(host: string): boolean {
  return IPV4.test(host) || (host.startsWith('[') && host.endsWith(']'));
}

export class PublicSuffixList {
  readonly #normal = new Set<string>();
  readonly #wildcard = new Set<string>(); // "*.ck" is stored as "ck"
  readonly #exception = new Set<string>(); // "!www.ck" is stored as "www.ck"

  /** Rules in PSL syntax (`com`, `*.ck`, `!www.ck`); Unicode labels are converted to Punycode. */
  static fromRules(rules: Iterable<string>): PublicSuffixList {
    const psl = new PublicSuffixList();
    for (const rule of rules) psl.#add(rule);
    return psl;
  }

  /** Parse the text of `public_suffix_list.dat` (both ICANN and PRIVATE sections). */
  static fromDat(text: string): PublicSuffixList {
    const rules: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const token = line.trim().split(/\s+/)[0] ?? '';
      if (token === '' || token.startsWith('//')) continue;
      rules.push(token);
    }
    return PublicSuffixList.fromRules(rules);
  }

  /** The compact form written by `scripts/build-psl.mjs`: space-separated ASCII rules. */
  static fromCompact(compact: string): PublicSuffixList {
    return PublicSuffixList.fromRules(compact.split(' ').filter((r) => r !== ''));
  }

  #add(rule: string): void {
    let body = rule;
    let kind: 'normal' | 'wildcard' | 'exception' = 'normal';
    if (body.startsWith('!')) {
      kind = 'exception';
      body = body.slice(1);
    } else if (body.startsWith('*.')) {
      kind = 'wildcard';
      body = body.slice(2);
    }
    const ascii = toAsciiHost(body);
    if (ascii === null) throw new Error(`invalid public suffix rule: ${rule}`);
    (kind === 'normal' ? this.#normal : kind === 'wildcard' ? this.#wildcard : this.#exception).add(
      ascii,
    );
  }

  get size(): number {
    return this.#normal.size + this.#wildcard.size + this.#exception.size;
  }

  /** Number of labels of the public suffix of `labels`, or null if no rule matches (unknown TLD). */
  #suffixLabelCount(labels: readonly string[]): number | null {
    const n = labels.length;
    let best = 0;
    for (let i = 0; i < n; i++) {
      const suffix = labels.slice(i).join('.');
      // An exception rule prevails over every other rule; its public suffix is its parent.
      if (this.#exception.has(suffix)) return n - i - 1;
      if (this.#normal.has(suffix)) best = Math.max(best, n - i);
      if (i + 1 < n && this.#wildcard.has(labels.slice(i + 1).join('.')))
        best = Math.max(best, n - i);
    }
    return best > 0 ? best : null;
  }

  /**
   * eTLD+1 of a normalised ASCII host. Null for IP literals, hosts whose TLD is not in the list
   * (e.g. `localhost`, `printer.lan`) and hosts that are themselves a public suffix. Callers fall
   * back to exact-host matching in every null case.
   */
  registrableDomain(host: string): string | null {
    if (isIpHost(host)) return null;
    const labels = host.split('.');
    const count = this.#suffixLabelCount(labels);
    if (count === null || labels.length <= count) return null;
    return labels.slice(labels.length - count - 1).join('.');
  }
}
