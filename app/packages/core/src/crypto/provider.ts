// The only surface through which core touches cryptographic primitives. Two implementations ship
// with core (WebCrypto and noble); a deterministic wrapper exists for test vectors.
import { CryptoError } from '../errors';

export interface KeyPair {
  /** 32-byte big-endian P-256 scalar. */
  privateKey: Uint8Array;
  /** 65-byte SEC1 uncompressed point (0x04 || X || Y). */
  publicKey: Uint8Array;
}

export interface CryptoProvider {
  /** `n` cryptographically secure random bytes. */
  randomBytes(n: number): Promise<Uint8Array>;
  sha256(data: Uint8Array): Promise<Uint8Array>;
  hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  hkdfSha256(
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array>;
  pbkdf2Sha256(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    length: number,
  ): Promise<Uint8Array>;
  /** AES-256-GCM, 128-bit tag. Returns ciphertext || tag. */
  aesGcmEncrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    plaintext: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array>;
  /** Throws `CryptoError('E_DECRYPT')` on any failure, without detail. */
  aesGcmDecrypt(
    key: Uint8Array,
    nonce: Uint8Array,
    ciphertextAndTag: Uint8Array,
    aad: Uint8Array,
  ): Promise<Uint8Array>;
  generateKeyPair(): Promise<KeyPair>;
  /** Public key (65 bytes, uncompressed) belonging to a 32-byte private scalar. */
  publicKeyOf(privateKey: Uint8Array): Promise<Uint8Array>;
  /** ECDH P-256; returns the 32-byte X coordinate of the shared point. */
  ecdh(privateKey: Uint8Array, peerPublicKey: Uint8Array): Promise<Uint8Array>;
  /** ECDSA P-256 over SHA-256(message); 64-byte r || s (IEEE P1363). */
  ecdsaSign(privateKey: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
  /**
   * Returns false (never throws) for a wrong length, an invalid public key (wrong length, wrong
   * prefix, not on the curve) or a bad signature. Both low-S and high-S signatures are accepted.
   */
  ecdsaVerify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export const AES_KEY_BYTES = 32;
export const GCM_NONCE_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const P256_SCALAR_BYTES = 32;
export const P256_POINT_BYTES = 65;
export const ECDSA_SIG_BYTES = 64;

/** Argument checks shared by both providers. Messages carry no values. */
export function requireLength(value: Uint8Array, length: number, what: string): void {
  if (value.length !== length)
    throw new CryptoError('E_CRYPTO_INPUT', `${what}: need ${length} bytes`);
}

export function requireGcmInputs(key: Uint8Array, nonce: Uint8Array): void {
  requireLength(key, AES_KEY_BYTES, 'AES key');
  requireLength(nonce, GCM_NONCE_BYTES, 'GCM nonce');
}

export function requirePositiveInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 1)
    throw new CryptoError('E_CRYPTO_INPUT', `${what}: bad value`);
}

/** Structural check that a public key looks like an uncompressed SEC1 point. */
export function looksLikeUncompressedPoint(pub: Uint8Array): boolean {
  return pub.length === P256_POINT_BYTES && pub[0] === 0x04;
}
