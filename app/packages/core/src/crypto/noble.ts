// CryptoProvider on @noble/* (pure JS). Works on React Native / Hermes, which has no WebCrypto.
// Randomness: @noble/hashes uses `crypto.getRandomValues`; on Hermes the host app must install a
// polyfill (react-native-get-random-values) or pass `random` below.
import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';
import { CryptoError } from '../errors';
import {
  type CryptoProvider,
  ECDSA_SIG_BYTES,
  GCM_TAG_BYTES,
  type KeyPair,
  looksLikeUncompressedPoint,
  P256_SCALAR_BYTES,
  requireGcmInputs,
  requireLength,
  requirePositiveInt,
} from './provider';

export type NobleProviderOptions = {
  /** Override the random source (e.g. a native module on React Native). */
  random?: (n: number) => Uint8Array | Promise<Uint8Array>;
  /** Max milliseconds PBKDF2 may block the thread before yielding. Default 5. */
  pbkdf2AsyncTick?: number;
};

export function createNobleProvider(options: NobleProviderOptions = {}): CryptoProvider {
  const random = options.random ?? ((n: number) => nobleRandomBytes(n));
  const tick = options.pbkdf2AsyncTick ?? 5;

  async function rand(n: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(n) || n < 0) throw new CryptoError('E_CRYPTO_INPUT', 'bad length');
    const out = await random(n);
    if (out.length !== n)
      throw new CryptoError('E_CRYPTO_INPUT', 'random source returned wrong size');
    return out;
  }

  function checkScalar(priv: Uint8Array): void {
    requireLength(priv, P256_SCALAR_BYTES, 'P-256 private key');
    if (!p256.utils.isValidSecretKey(priv))
      throw new CryptoError('E_CRYPTO_INPUT', 'bad private key');
  }

  return {
    randomBytes: rand,
    async sha256(data) {
      return sha256(data);
    },
    async hmacSha256(key, data) {
      return hmac(sha256, key, data);
    },
    async hkdfSha256(ikm, salt, info, length) {
      requirePositiveInt(length, 'HKDF length');
      return hkdf(sha256, ikm, salt, info, length);
    },
    async pbkdf2Sha256(password, salt, iterations, length) {
      requirePositiveInt(iterations, 'PBKDF2 iterations');
      requirePositiveInt(length, 'PBKDF2 length');
      // Async variant yields to the event loop every `tick` ms so a UI thread does not freeze.
      return pbkdf2Async(sha256, password, salt, { c: iterations, dkLen: length, asyncTick: tick });
    },
    async aesGcmEncrypt(key, nonce, plaintext, aad) {
      requireGcmInputs(key, nonce);
      return gcm(key, nonce, aad).encrypt(plaintext);
    },
    async aesGcmDecrypt(key, nonce, ciphertextAndTag, aad) {
      if (key.length !== 32 || nonce.length !== 12 || ciphertextAndTag.length < GCM_TAG_BYTES) {
        throw new CryptoError('E_DECRYPT');
      }
      try {
        return gcm(key, nonce, aad).decrypt(ciphertextAndTag);
      } catch {
        // Deliberate: the library's tag-mismatch error becomes the typed, detail-free error.
        throw new CryptoError('E_DECRYPT');
      }
    },
    async generateKeyPair(): Promise<KeyPair> {
      // Our own random source feeds the library's seed-to-scalar mapping (48 bytes -> valid scalar).
      const seed = await rand(p256.lengths.seed ?? 48);
      const privateKey = p256.utils.randomSecretKey(seed);
      return { privateKey, publicKey: p256.getPublicKey(privateKey, false) };
    },
    async publicKeyOf(privateKey) {
      checkScalar(privateKey);
      return p256.getPublicKey(privateKey, false);
    },
    async ecdh(privateKey, peerPublicKey) {
      checkScalar(privateKey);
      if (
        !looksLikeUncompressedPoint(peerPublicKey) ||
        !p256.utils.isValidPublicKey(peerPublicKey, false)
      ) {
        throw new CryptoError('E_CRYPTO_INPUT', 'bad peer public key');
      }
      // Compressed shared point = 0x02/0x03 || X; X is the ECDH output.
      return p256.getSharedSecret(privateKey, peerPublicKey, true).slice(1);
    },
    async ecdsaSign(privateKey, message) {
      checkScalar(privateKey);
      // Deterministic (RFC 6979) with SHA-256 pre-hash, low-S, compact r || s.
      const sig = p256.sign(message, privateKey, { prehash: true, lowS: true });
      requireLength(sig, ECDSA_SIG_BYTES, 'signature');
      return sig;
    },
    async ecdsaVerify(publicKey, message, signature) {
      if (signature.length !== ECDSA_SIG_BYTES) return false;
      if (
        !looksLikeUncompressedPoint(publicKey) ||
        !p256.utils.isValidPublicKey(publicKey, false)
      ) {
        return false;
      }
      // lowS: false -> accept high-S signatures too (WebCrypto / Secure Enclave may emit either).
      return p256.verify(signature, message, publicKey, { prehash: true, lowS: false });
    },
  };
}
