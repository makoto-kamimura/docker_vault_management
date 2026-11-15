// Recovery code (RC) — spec §8.11.1 (derivations) and §8.11.2 (text format).
// RC is 256 random bits and is never stored on a device (except on a new device that is waiting).
import {
  BYTES,
  base64urlDecode,
  base64urlEncode,
  HKDF_INFO,
  rcAad,
  utf8Encode,
  type WrappedVk,
} from '@localvault/protocol';
import { uuidToBytes, wipe } from './bytes';
import {
  checkChars,
  crockfordDecode,
  crockfordEncode,
  groupBy,
  normalizeCrockford,
} from './crockford';
import type { CryptoProvider } from './crypto/provider';
import { VaultCoreError } from './errors';

const DATA_CHARS = 52;
const TOTAL_CHARS = 54;
const PREFIX = 'LVRC';

export function generateRecoveryCode(p: CryptoProvider): Promise<Uint8Array> {
  return p.randomBytes(BYTES.rc);
}

export type RecoveryCodeKeys = {
  /** 16 bytes; public identifier the server stores. */
  rcId: Uint8Array;
  kekRC: Uint8Array;
  authRC: Uint8Array;
};

function requireRc(rc: Uint8Array): void {
  if (rc.length !== BYTES.rc)
    throw new VaultCoreError('E_INVALID_INPUT', 'recovery code must be 32 bytes');
}

/** rcId / kekRC / authRC = HKDF-SHA256(RC, salt = accountId bytes, info, 16 / 32 / 32). */
export async function deriveRecoveryCodeKeys(
  p: CryptoProvider,
  rc: Uint8Array,
  accountId: string,
): Promise<RecoveryCodeKeys> {
  requireRc(rc);
  const salt = uuidToBytes(accountId);
  return {
    rcId: await p.hkdfSha256(rc, salt, utf8Encode(HKDF_INFO.rcId), BYTES.rcId),
    kekRC: await p.hkdfSha256(rc, salt, utf8Encode(HKDF_INFO.rcKek), 32),
    authRC: await p.hkdfSha256(rc, salt, utf8Encode(HKDF_INFO.rcAuth), BYTES.authRC),
  };
}

export type RecoveryCodeRegistration = {
  /** base64url, 16 bytes */
  rcId: string;
  wrappedVK: WrappedVk;
  /** base64url(SHA-256(authRC)) */
  verifier: string;
  vkVersion: number;
};

/** What `PUT /v1/recovery-code` carries: everything derived from RC, wrapping the current VK. */
export async function createRecoveryCodeRegistration(
  p: CryptoProvider,
  rc: Uint8Array,
  accountId: string,
  vk: Uint8Array,
  vkVersion: number,
): Promise<RecoveryCodeRegistration> {
  if (vk.length !== BYTES.vk)
    throw new VaultCoreError('E_INVALID_INPUT', 'vault key must be 32 bytes');
  const keys = await deriveRecoveryCodeKeys(p, rc, accountId);
  try {
    const rcId = base64urlEncode(keys.rcId);
    const nonce = await p.randomBytes(BYTES.nonce);
    const ct = await p.aesGcmEncrypt(
      keys.kekRC,
      nonce,
      vk,
      utf8Encode(rcAad(accountId, rcId, vkVersion)),
    );
    return {
      rcId,
      wrappedVK: { nonce: base64urlEncode(nonce), ct: base64urlEncode(ct) },
      verifier: base64urlEncode(await p.sha256(keys.authRC)),
      vkVersion,
    };
  } finally {
    wipe(keys.kekRC, keys.authRC);
  }
}

/** Recover the VK from the server's wrappedVK (step 5 of §8.11.4). Throws `E_DECRYPT` on mismatch. */
export async function unwrapVaultKeyWithRecoveryCode(
  p: CryptoProvider,
  rc: Uint8Array,
  accountId: string,
  wrapped: WrappedVk,
  vkVersion: number,
): Promise<Uint8Array> {
  const keys = await deriveRecoveryCodeKeys(p, rc, accountId);
  try {
    const vk = await p.aesGcmDecrypt(
      keys.kekRC,
      base64urlDecode(wrapped.nonce),
      base64urlDecode(wrapped.ct),
      utf8Encode(rcAad(accountId, base64urlEncode(keys.rcId), vkVersion)),
    );
    if (vk.length !== BYTES.vk)
      throw new VaultCoreError('E_CORRUPTED', 'unexpected vault key size');
    return vk;
  } finally {
    wipe(keys.kekRC, keys.authRC);
  }
}

/** `LVRC-XXXXXX-…` (52 data + 2 check chars, 9 groups of 6). */
export async function formatRecoveryCode(p: CryptoProvider, rc: Uint8Array): Promise<string> {
  requireRc(rc);
  const body = crockfordEncode(rc) + (await checkChars(p, rc));
  return `${PREFIX}-${groupBy(body, 6)}`;
}

/** Lenient parse with the same rules as the recovery key; throws `E_INVALID_RECOVERY_CODE`. */
export async function parseRecoveryCode(p: CryptoProvider, input: string): Promise<Uint8Array> {
  const body = normalizeCrockford(input, PREFIX, TOTAL_CHARS);
  if (body === null || body.length !== TOTAL_CHARS) throw invalid();
  const rc = crockfordDecode(body.slice(0, DATA_CHARS), BYTES.rc);
  if (rc === null) throw invalid();
  if ((await checkChars(p, rc)) !== body.slice(DATA_CHARS)) throw invalid();
  return rc;
}

/** The last 6 characters of the printed text, which the user retypes to confirm the sheet (§8.11.2). */
export function recoveryCodeConfirmationTail(text: string): string {
  return text.replace(/-/g, '').slice(-6);
}

function invalid(): VaultCoreError {
  return new VaultCoreError('E_INVALID_RECOVERY_CODE', 'recovery code is not valid');
}
