// `.lvbackup` export file — spec §6.5.
// A fresh random key K encrypts the payload; K is wrapped by a key derived from the export
// password with PBKDF2 only (the recovery key is NOT mixed in).
import {
  BYTES,
  base64urlDecode,
  base64urlEncode,
  EXPORT_AAD_KEY,
  EXPORT_AAD_PAYLOAD,
  type ExportFile,
  type ExportPayload,
  exportFileSchema,
  exportPayloadSchema,
  FIELD,
  KDF_MIN_ITERATIONS,
  kdfSchema,
  utf8Decode,
  utf8Encode,
} from '@localvault/protocol';
import { wipe } from './bytes';
import type { CryptoProvider } from './crypto/provider';
import { CryptoError, VaultCoreError } from './errors';
import { passwordBytes } from './keys';

export type CreateExportInput = {
  exportPassword: string;
  payload: ExportPayload;
  /** ISO 8601 UTC. */
  exportedAt: string;
  iterations?: number;
};

export async function createExportFile(
  p: CryptoProvider,
  input: CreateExportInput,
): Promise<ExportFile> {
  if (input.exportPassword.length < FIELD.exportPasswordMin) {
    throw new VaultCoreError('E_INVALID_INPUT', 'export password too short');
  }
  const payload = exportPayloadSchema.safeParse(input.payload);
  if (!payload.success)
    throw new VaultCoreError('E_INVALID_INPUT', 'export payload does not match the schema');

  const kdf = kdfSchema.parse({
    alg: 'PBKDF2-HMAC-SHA256',
    iterations: input.iterations ?? KDF_MIN_ITERATIONS,
    salt: base64urlEncode(await p.randomBytes(BYTES.kdfSalt)),
  });
  const passwordKey = await p.pbkdf2Sha256(
    passwordBytes(input.exportPassword),
    base64urlDecode(kdf.salt),
    kdf.iterations,
    32,
  );
  const fileKey = await p.randomBytes(32);
  try {
    const keyNonce = await p.randomBytes(BYTES.nonce);
    const wrappedCt = await p.aesGcmEncrypt(
      passwordKey,
      keyNonce,
      fileKey,
      utf8Encode(EXPORT_AAD_KEY),
    );
    const payloadNonce = await p.randomBytes(BYTES.nonce);
    const payloadCt = await p.aesGcmEncrypt(
      fileKey,
      payloadNonce,
      utf8Encode(JSON.stringify(payload.data)),
      utf8Encode(EXPORT_AAD_PAYLOAD),
    );
    return exportFileSchema.parse({
      format: 'localvault-export',
      version: 1,
      exportedAt: input.exportedAt,
      kdf,
      wrappedKey: { nonce: base64urlEncode(keyNonce), ct: base64urlEncode(wrappedCt) },
      payload: { nonce: base64urlEncode(payloadNonce), ct: base64urlEncode(payloadCt) },
    });
  } finally {
    wipe(passwordKey, fileKey);
  }
}

/**
 * Opens an export file given as parsed JSON. Errors: `E_IMPORT_FORMAT` (not a LocalVault export or
 * damaged), `E_UNSUPPORTED_VERSION` (newer version), `E_WRONG_PASSWORD` (the key did not unwrap).
 */
export async function openExportFile(
  p: CryptoProvider,
  exportPassword: string,
  file: unknown,
): Promise<{ payload: ExportPayload; exportedAt: string }> {
  if (
    typeof file === 'object' &&
    file !== null &&
    (file as { format?: unknown }).format === 'localvault-export'
  ) {
    const version = (file as { version?: unknown }).version;
    if (typeof version === 'number' && version > 1)
      throw new VaultCoreError('E_UNSUPPORTED_VERSION');
  }
  const parsed = exportFileSchema.safeParse(file);
  if (!parsed.success) throw new VaultCoreError('E_IMPORT_FORMAT', 'not a LocalVault export file');
  const f = parsed.data;

  const passwordKey = await p.pbkdf2Sha256(
    passwordBytes(exportPassword),
    base64urlDecode(f.kdf.salt),
    f.kdf.iterations,
    32,
  );
  let fileKey: Uint8Array;
  try {
    fileKey = await p.aesGcmDecrypt(
      passwordKey,
      base64urlDecode(f.wrappedKey.nonce),
      base64urlDecode(f.wrappedKey.ct),
      utf8Encode(EXPORT_AAD_KEY),
    );
  } catch (e) {
    if (e instanceof CryptoError && e.code === 'E_DECRYPT')
      throw new VaultCoreError('E_WRONG_PASSWORD');
    throw e;
  } finally {
    wipe(passwordKey);
  }
  try {
    let plaintext: Uint8Array;
    try {
      plaintext = await p.aesGcmDecrypt(
        fileKey,
        base64urlDecode(f.payload.nonce),
        base64urlDecode(f.payload.ct),
        utf8Encode(EXPORT_AAD_PAYLOAD),
      );
    } catch (e) {
      // The key unwrapped with the right password, so a payload failure means a damaged file.
      if (e instanceof CryptoError && e.code === 'E_DECRYPT')
        throw new VaultCoreError('E_IMPORT_FORMAT', 'payload is damaged');
      throw e;
    }
    let json: unknown;
    try {
      json = JSON.parse(utf8Decode(plaintext));
    } catch {
      throw new VaultCoreError('E_IMPORT_FORMAT', 'payload is not JSON');
    }
    const payload = exportPayloadSchema.safeParse(json);
    if (!payload.success)
      throw new VaultCoreError('E_IMPORT_FORMAT', 'payload does not match the schema');
    return { payload: payload.data, exportedAt: f.exportedAt };
  } finally {
    wipe(fileKey);
  }
}
