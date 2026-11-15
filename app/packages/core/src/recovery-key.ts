// Recovery key (SK) — spec §5.5. 128 random bits, Crockford Base32, 2 check characters.
//   display: LV2-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX   (26 data + 2 check chars, 7 groups of 4)
import { BYTES } from '@localvault/protocol';
import {
  checkChars,
  crockfordDecode,
  crockfordEncode,
  groupBy,
  normalizeCrockford,
} from './crockford';
import type { CryptoProvider } from './crypto/provider';
import { VaultCoreError } from './errors';

const DATA_CHARS = 26;
const TOTAL_CHARS = 28;
const PREFIX = 'LV2';

export function generateRecoveryKeyBytes(p: CryptoProvider): Promise<Uint8Array> {
  return p.randomBytes(BYTES.uuid);
}

/** `LV2-XXXX-…` display form of 16 key bytes. */
export async function formatRecoveryKey(p: CryptoProvider, sk: Uint8Array): Promise<string> {
  if (sk.length !== BYTES.uuid)
    throw new VaultCoreError('E_INVALID_INPUT', 'recovery key must be 16 bytes');
  const body = crockfordEncode(sk) + (await checkChars(p, sk));
  return `${PREFIX}-${groupBy(body, 4)}`;
}

/**
 * Lenient parse: case-insensitive, hyphens/spaces ignored, I/L -> 1, O -> 0, the `LV2` prefix is
 * optional. Throws `VaultCoreError('E_INVALID_RECOVERY_KEY')` for any malformed input or a
 * check-character mismatch (the caller shows "入力に誤りがあります").
 */
export async function parseRecoveryKey(p: CryptoProvider, input: string): Promise<Uint8Array> {
  const body = normalizeCrockford(input, PREFIX, TOTAL_CHARS);
  if (body === null || body.length !== TOTAL_CHARS) throw invalid();
  const sk = crockfordDecode(body.slice(0, DATA_CHARS), BYTES.uuid);
  if (sk === null) throw invalid();
  if ((await checkChars(p, sk)) !== body.slice(DATA_CHARS)) throw invalid();
  return sk;
}

function invalid(): VaultCoreError {
  return new VaultCoreError('E_INVALID_RECOVERY_KEY', 'recovery key is not valid');
}
