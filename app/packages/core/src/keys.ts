// Key derivation and keyset handling — spec §5.4, §5.2 (password change / recovery-key reissue).
import {
  BYTES,
  base64urlDecode,
  base64urlEncode,
  concatBytes,
  HKDF_INFO,
  KDF_MIN_ITERATIONS,
  type Kdf,
  type Keyset,
  kdfSchema,
  utf8Encode,
  vkAad,
  type WrappedVk,
} from '@localvault/protocol';
import { uuidToBytes, wipe } from './bytes';
import type { CryptoProvider } from './crypto/provider';
import { VaultCoreError } from './errors';

export type MasterKeys = {
  /** Wraps the vault key. Never stored. */
  kek: Uint8Array;
  /** Authenticates to the server (only SHA-256(authKey) is stored there). Never stored. */
  authKey: Uint8Array;
};

export type DeriveMasterKeysInput = {
  masterPassword: string;
  kdf: Kdf;
  /** SK, 16 raw bytes. */
  recoveryKey: Uint8Array;
  accountId: string;
};

/** The master password is NFKC-normalised; surrounding whitespace is NOT trimmed (§5.4). */
export function passwordBytes(password: string): Uint8Array {
  return utf8Encode(password.normalize('NFKC'));
}

/**
 * p   = PBKDF2-HMAC-SHA256(NFKC(password), kdf.salt, kdf.iterations, 32)
 * ikm = p || SK
 * KEK = HKDF(ikm, salt = accountId bytes, "localvault/v2/kek", 32); authKey likewise with ".../auth".
 */
export async function deriveMasterKeys(
  p: CryptoProvider,
  input: DeriveMasterKeysInput,
): Promise<MasterKeys> {
  const kdf = kdfSchema.parse(input.kdf);
  if (input.recoveryKey.length !== BYTES.uuid) {
    throw new VaultCoreError('E_INVALID_INPUT', 'recovery key must be 16 bytes');
  }
  const salt = uuidToBytes(input.accountId);
  const stretched = await p.pbkdf2Sha256(
    passwordBytes(input.masterPassword),
    base64urlDecode(kdf.salt),
    kdf.iterations,
    32,
  );
  const ikm = concatBytes(stretched, input.recoveryKey);
  try {
    const kek = await p.hkdfSha256(ikm, salt, utf8Encode(HKDF_INFO.kek), 32);
    const authKey = await p.hkdfSha256(ikm, salt, utf8Encode(HKDF_INFO.auth), 32);
    return { kek, authKey };
  } finally {
    wipe(stretched, ikm);
  }
}

/** verifier = SHA-256(authKey): the only authentication value the server stores. */
export function verifierOf(p: CryptoProvider, authKey: Uint8Array): Promise<Uint8Array> {
  return p.sha256(authKey);
}

/** wrappedVK = AES-256-GCM(KEK, VK, AAD = "lv|v2|vk|<accountId>|<keysetVersion>"), fresh nonce. */
export async function wrapVaultKey(
  p: CryptoProvider,
  kek: Uint8Array,
  vk: Uint8Array,
  accountId: string,
  keysetVersion: number,
): Promise<WrappedVk> {
  if (vk.length !== BYTES.vk)
    throw new VaultCoreError('E_INVALID_INPUT', 'vault key must be 32 bytes');
  const nonce = await p.randomBytes(BYTES.nonce);
  const ct = await p.aesGcmEncrypt(kek, nonce, vk, utf8Encode(vkAad(accountId, keysetVersion)));
  return { nonce: base64urlEncode(nonce), ct: base64urlEncode(ct) };
}

/** Throws `CryptoError('E_DECRYPT')` when the KEK, accountId or keysetVersion do not match. */
export async function unwrapVaultKey(
  p: CryptoProvider,
  kek: Uint8Array,
  wrapped: WrappedVk,
  accountId: string,
  keysetVersion: number,
): Promise<Uint8Array> {
  const vk = await p.aesGcmDecrypt(
    kek,
    base64urlDecode(wrapped.nonce),
    base64urlDecode(wrapped.ct),
    utf8Encode(vkAad(accountId, keysetVersion)),
  );
  if (vk.length !== BYTES.vk) throw new VaultCoreError('E_CORRUPTED', 'unexpected vault key size');
  return vk;
}

export async function generateVaultKey(p: CryptoProvider): Promise<Uint8Array> {
  return p.randomBytes(BYTES.vk);
}

export async function generateKdf(
  p: CryptoProvider,
  iterations: number = KDF_MIN_ITERATIONS,
): Promise<Kdf> {
  return kdfSchema.parse({
    alg: 'PBKDF2-HMAC-SHA256',
    iterations,
    salt: base64urlEncode(await p.randomBytes(BYTES.kdfSalt)),
  });
}

export type KeysetBundle = {
  keyset: Keyset;
  /** Server-side authentication value, base64url. */
  verifier: string;
  /** Raw authKey, for the one request that needs it (never persisted). */
  authKey: Uint8Array;
  kek: Uint8Array;
  vk: Uint8Array;
};

export type CreateKeysetInput = {
  masterPassword: string;
  recoveryKey: Uint8Array;
  accountId: string;
  /** Defaults to a fresh random VK. */
  vk?: Uint8Array;
  iterations?: number;
  /** Account creation uses 1/1 (v0.4 §6 item 10). */
  keysetVersion?: number;
  vkVersion?: number;
};

/** First keyset of an account: new random salt (and VK unless given). */
export async function createKeyset(
  p: CryptoProvider,
  input: CreateKeysetInput,
): Promise<KeysetBundle> {
  const keysetVersion = input.keysetVersion ?? 1;
  const vkVersion = input.vkVersion ?? 1;
  const vk = input.vk ?? (await generateVaultKey(p));
  const kdf = await generateKdf(p, input.iterations);
  return buildBundle(p, { ...input, kdf, vk, keysetVersion, vkVersion });
}

export type RewrapKeysetInput = {
  masterPassword: string;
  recoveryKey: Uint8Array;
  accountId: string;
  vk: Uint8Array;
  previous: Keyset;
  /** Defaults to the previous iteration count. */
  iterations?: number;
};

/**
 * Password change / recovery-key reissue / code-based recovery: the same VK is wrapped again under
 * new KEK material with a NEW salt; `keysetVersion + 1`, `vkVersion` unchanged.
 */
export async function rewrapKeyset(
  p: CryptoProvider,
  input: RewrapKeysetInput,
): Promise<KeysetBundle> {
  const kdf = await generateKdf(p, input.iterations ?? input.previous.kdf.iterations);
  return buildBundle(p, {
    masterPassword: input.masterPassword,
    recoveryKey: input.recoveryKey,
    accountId: input.accountId,
    vk: input.vk,
    kdf,
    keysetVersion: input.previous.keysetVersion + 1,
    vkVersion: input.previous.vkVersion,
  });
}

async function buildBundle(
  p: CryptoProvider,
  a: {
    masterPassword: string;
    recoveryKey: Uint8Array;
    accountId: string;
    vk: Uint8Array;
    kdf: Kdf;
    keysetVersion: number;
    vkVersion: number;
  },
): Promise<KeysetBundle> {
  const { kek, authKey } = await deriveMasterKeys(p, {
    masterPassword: a.masterPassword,
    kdf: a.kdf,
    recoveryKey: a.recoveryKey,
    accountId: a.accountId,
  });
  const wrappedVK = await wrapVaultKey(p, kek, a.vk, a.accountId, a.keysetVersion);
  const verifier = base64urlEncode(await verifierOf(p, authKey));
  return {
    keyset: { keysetVersion: a.keysetVersion, vkVersion: a.vkVersion, kdf: a.kdf, wrappedVK },
    verifier,
    authKey,
    kek,
    vk: a.vk,
  };
}
