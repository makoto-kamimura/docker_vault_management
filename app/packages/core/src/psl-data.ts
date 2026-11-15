// `@localvault/core/psl-data` — the bundled Public Suffix List (generated, MPL 2.0).
// Kept out of the main entry point so consumers that supply their own list stay small.
import { PublicSuffixList } from './matcher/psl';
import { PSL_COMPACT } from './matcher/psl-data.generated';

export { PSL_COMPACT, PSL_SOURCE_SHA256 } from './matcher/psl-data.generated';

let cached: PublicSuffixList | undefined;

/** Parsed bundled list (built on first use, then cached). */
export function defaultPsl(): PublicSuffixList {
  cached ??= PublicSuffixList.fromCompact(PSL_COMPACT);
  return cached;
}
