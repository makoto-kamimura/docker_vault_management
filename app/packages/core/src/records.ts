// Record encryption — spec §6.1/§6.2.
//   AES-256-GCM(VK, fresh nonce, JSON(RecordPlain) padded with spaces to a multiple of 256 bytes,
//               AAD = "lv|v2|rec|<accountId>|<recordId>|<vkVersion>")
import {
  BYTES,
  base64urlDecode,
  base64urlEncode,
  ciphertextSchema,
  MAX_CIPHERTEXT_BYTES,
  META_RECORD_ID,
  nonceSchema,
  passwordHistoryOf,
  type RecordPlain,
  recordAad,
  recordPlainSchema,
  utf8Decode,
  utf8Encode,
  uuidSchema,
} from '@localvault/protocol';
import type { CryptoProvider } from './crypto/provider';
import { VaultCoreError } from './errors';

export const RECORD_PAD_BLOCK = 256;
const SPACE = 0x20;

/** Length of the padded plaintext: the next multiple of 256 (unchanged if already a multiple). */
export function paddedLength(jsonByteLength: number): number {
  return Math.max(1, Math.ceil(jsonByteLength / RECORD_PAD_BLOCK)) * RECORD_PAD_BLOCK;
}

function pad(json: Uint8Array): Uint8Array {
  const out = new Uint8Array(paddedLength(json.length)).fill(SPACE);
  out.set(json, 0);
  return out;
}

export type EncryptedPayload = { nonce: string; ct: string };

export type RecordLocator = {
  accountId: string;
  recordId: string;
  vkVersion: number;
};

function checkLocator(l: RecordLocator): void {
  if (!uuidSchema.safeParse(l.recordId).success || !uuidSchema.safeParse(l.accountId).success) {
    throw new VaultCoreError('E_INVALID_INPUT', 'bad id');
  }
  if (!Number.isSafeInteger(l.vkVersion) || l.vkVersion < 1) {
    throw new VaultCoreError('E_INVALID_INPUT', 'bad vkVersion');
  }
}

/** The singleton meta record has a fixed id, and only it may use that id. */
function checkKindMatchesId(kind: RecordPlain['kind'], recordId: string): void {
  if ((kind === 'meta') !== (recordId === META_RECORD_ID)) {
    throw new VaultCoreError('E_INVALID_INPUT', 'record kind does not match its id');
  }
}

export async function encryptRecord(
  p: CryptoProvider,
  vk: Uint8Array,
  locator: RecordLocator,
  record: RecordPlain,
): Promise<EncryptedPayload> {
  checkLocator(locator);
  if (vk.length !== BYTES.vk)
    throw new VaultCoreError('E_INVALID_INPUT', 'vault key must be 32 bytes');
  const parsed = recordPlainSchema.safeParse(record);
  if (!parsed.success)
    throw new VaultCoreError('E_INVALID_INPUT', 'record does not match the schema');
  checkKindMatchesId(parsed.data.kind, locator.recordId);

  const plaintext = pad(utf8Encode(JSON.stringify(parsed.data)));
  if (plaintext.length + BYTES.gcmTag > MAX_CIPHERTEXT_BYTES) {
    throw new VaultCoreError('E_TOO_LARGE', 'record exceeds the ciphertext limit');
  }
  const nonce = await p.randomBytes(BYTES.nonce);
  const ct = await p.aesGcmEncrypt(
    vk,
    nonce,
    plaintext,
    utf8Encode(recordAad(locator.accountId, locator.recordId, locator.vkVersion)),
  );
  const out = { nonce: base64urlEncode(nonce), ct: base64urlEncode(ct) };
  // Output validated against the wire schemas (sizes and canonical base64url).
  nonceSchema.parse(out.nonce);
  ciphertextSchema.parse(out.ct);
  return out;
}

/**
 * Decrypts and validates a record. Throws `CryptoError('E_DECRYPT')` when the key, AAD (account id,
 * record id, vkVersion), nonce or ciphertext do not match, and `VaultCoreError('E_CORRUPTED')` when
 * the authenticated plaintext is not a valid record. A missing `passwordHistory` becomes `[]`.
 */
export async function decryptRecord(
  p: CryptoProvider,
  vk: Uint8Array,
  locator: RecordLocator,
  payload: EncryptedPayload,
): Promise<RecordPlain> {
  checkLocator(locator);
  const plaintext = await p.aesGcmDecrypt(
    vk,
    base64urlDecode(payload.nonce),
    base64urlDecode(payload.ct),
    utf8Encode(recordAad(locator.accountId, locator.recordId, locator.vkVersion)),
  );
  let json: unknown;
  try {
    json = JSON.parse(utf8Decode(plaintext));
  } catch {
    // The plaintext authenticated, so this is a writer bug or a format we do not know.
    throw new VaultCoreError('E_CORRUPTED', 'record plaintext is not JSON');
  }
  const parsed = recordPlainSchema.safeParse(json);
  if (!parsed.success)
    throw new VaultCoreError('E_CORRUPTED', 'record plaintext does not match the schema');
  const rec = parsed.data;
  if ((rec.kind === 'meta') !== (locator.recordId === META_RECORD_ID)) {
    throw new VaultCoreError('E_CORRUPTED', 'record kind does not match its id');
  }
  if (rec.kind === 'login') {
    return { ...rec, data: { ...rec.data, passwordHistory: passwordHistoryOf(rec.data) } };
  }
  return rec;
}
