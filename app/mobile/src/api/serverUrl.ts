// Server-URL policy (§5.11, G11): https only. http://localhost, 127.0.0.1 and 10.0.2.2 are accepted
// in development builds only.
import { parseServerUrl, type ServerUrlResult } from '@localvault/protocol';
import { allowInsecureLocalhost } from '../env';

export type ServerUrlCheck = ServerUrlResult;

/**
 * Validates user input and returns the normalised origin. A missing scheme is read as https://
 * (a typed `http://` is never upgraded silently: it is rejected unless the dev exception applies).
 */
export function checkServerUrl(
  input: string,
  opts: { allowInsecureLocalhost?: boolean } = {},
): ServerUrlCheck {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'invalid' };
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  return parseServerUrl(withScheme, {
    allowInsecureLocalhost: opts.allowInsecureLocalhost ?? allowInsecureLocalhost,
  });
}
