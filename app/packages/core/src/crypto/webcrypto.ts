// CryptoProvider on `globalThis.crypto.subtle` (Node 24, browsers, MV3 service workers).
// Not usable on React Native / Hermes (no WebCrypto); use `createNobleProvider` there.
import { CryptoError } from '../errors';
import {
  type CryptoProvider,
  ECDSA_SIG_BYTES,
  GCM_TAG_BYTES,
  type KeyPair,
  looksLikeUncompressedPoint,
  P256_POINT_BYTES,
  P256_SCALAR_BYTES,
  requireGcmInputs,
  requireLength,
  requirePositiveInt,
} from './provider';

// The DOM typings want ArrayBuffer-backed views; our Uint8Arrays are never SharedArrayBuffer-backed.
type Bytes = Uint8Array<ArrayBuffer>;
const b = (u: Uint8Array): Bytes => u as Bytes;

/** getRandomValues refuses requests above 65,536 bytes. */
const RANDOM_CHUNK = 65_536;

// PKCS#8 wrapper around a bare P-256 scalar. WebCrypto cannot import a raw private scalar, so we
// build an ECPrivateKey (RFC 5915) without the optional public key and let the engine derive it:
//   SEQUENCE { INTEGER 0, SEQUENCE { OID ecPublicKey, OID prime256v1 },
//              OCTET STRING { SEQUENCE { INTEGER 1, OCTET STRING <32 bytes> } } }
const PKCS8_P256_PREFIX = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
  0x01, 0x04, 0x20,
]);

function pkcs8FromScalar(scalar: Uint8Array): Bytes {
  requireLength(scalar, P256_SCALAR_BYTES, 'P-256 private key');
  const out = new Uint8Array(PKCS8_P256_PREFIX.length + P256_SCALAR_BYTES);
  out.set(PKCS8_P256_PREFIX, 0);
  out.set(scalar, PKCS8_P256_PREFIX.length);
  return out;
}

function fromB64url(s: string | undefined): Uint8Array {
  // JWK coordinates use base64url without padding; atob is available wherever subtle is.
  if (s === undefined) throw new CryptoError('E_CRYPTO_INPUT', 'missing JWK member');
  const std = s.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function padTo32(x: Uint8Array): Uint8Array {
  if (x.length > 32) throw new CryptoError('E_CRYPTO_INPUT', 'coordinate too long');
  const out = new Uint8Array(32);
  out.set(x, 32 - x.length);
  return out;
}

function pointFromJwk(jwk: JsonWebKey): Uint8Array {
  const out = new Uint8Array(P256_POINT_BYTES);
  out[0] = 0x04;
  out.set(padTo32(fromB64url(jwk.x)), 1);
  out.set(padTo32(fromB64url(jwk.y)), 33);
  return out;
}

export function createWebCryptoProvider(
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): CryptoProvider {
  const rng = globalThis.crypto;

  async function importPrivate(scalar: Uint8Array, algo: 'ECDH' | 'ECDSA', extractable: boolean) {
    return subtle.importKey(
      'pkcs8',
      pkcs8FromScalar(scalar),
      { name: algo, namedCurve: 'P-256' },
      extractable,
      algo === 'ECDH' ? ['deriveBits'] : ['sign'],
    );
  }

  async function aesKey(key: Uint8Array, usage: 'encrypt' | 'decrypt') {
    return subtle.importKey('raw', b(key), { name: 'AES-GCM' }, false, [usage]);
  }

  return {
    async randomBytes(n) {
      if (!Number.isSafeInteger(n) || n < 0) throw new CryptoError('E_CRYPTO_INPUT', 'bad length');
      const out = new Uint8Array(n);
      for (let off = 0; off < n; off += RANDOM_CHUNK) {
        rng.getRandomValues(out.subarray(off, Math.min(n, off + RANDOM_CHUNK)));
      }
      return out;
    },

    async sha256(data) {
      return new Uint8Array(await subtle.digest('SHA-256', b(data)));
    },

    async hmacSha256(key, data) {
      const k = await subtle.importKey('raw', b(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ]);
      return new Uint8Array(await subtle.sign('HMAC', k, b(data)));
    },

    async hkdfSha256(ikm, salt, info, length) {
      requirePositiveInt(length, 'HKDF length');
      const k = await subtle.importKey('raw', b(ikm), 'HKDF', false, ['deriveBits']);
      const bits = await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: b(salt), info: b(info) },
        k,
        length * 8,
      );
      return new Uint8Array(bits);
    },

    async pbkdf2Sha256(password, salt, iterations, length) {
      requirePositiveInt(iterations, 'PBKDF2 iterations');
      requirePositiveInt(length, 'PBKDF2 length');
      const k = await subtle.importKey('raw', b(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: b(salt), iterations },
        k,
        length * 8,
      );
      return new Uint8Array(bits);
    },

    async aesGcmEncrypt(key, nonce, plaintext, aad) {
      requireGcmInputs(key, nonce);
      const out = await subtle.encrypt(
        { name: 'AES-GCM', iv: b(nonce), additionalData: b(aad), tagLength: 128 },
        await aesKey(key, 'encrypt'),
        b(plaintext),
      );
      return new Uint8Array(out);
    },

    async aesGcmDecrypt(key, nonce, ciphertextAndTag, aad) {
      // Every failure, including bad argument sizes, is reported as the same opaque error.
      if (key.length !== 32 || nonce.length !== 12 || ciphertextAndTag.length < GCM_TAG_BYTES) {
        throw new CryptoError('E_DECRYPT');
      }
      try {
        const out = await subtle.decrypt(
          { name: 'AES-GCM', iv: b(nonce), additionalData: b(aad), tagLength: 128 },
          await aesKey(key, 'decrypt'),
          b(ciphertextAndTag),
        );
        return new Uint8Array(out);
      } catch {
        // Deliberate: WebCrypto's OperationError is converted to the typed, detail-free error.
        throw new CryptoError('E_DECRYPT');
      }
    },

    async generateKeyPair(): Promise<KeyPair> {
      const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      const jwk = await subtle.exportKey('jwk', pair.privateKey);
      return { privateKey: padTo32(fromB64url(jwk.d)), publicKey: pointFromJwk(jwk) };
    },

    async publicKeyOf(privateKey) {
      const key = await importPrivate(privateKey, 'ECDSA', true);
      return pointFromJwk(await subtle.exportKey('jwk', key));
    },

    async ecdh(privateKey, peerPublicKey) {
      if (!looksLikeUncompressedPoint(peerPublicKey)) {
        throw new CryptoError('E_CRYPTO_INPUT', 'bad peer public key');
      }
      const priv = await importPrivate(privateKey, 'ECDH', false);
      // importKey validates that the point is on the curve.
      const pub = await subtle.importKey(
        'raw',
        b(peerPublicKey),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
      );
      return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
    },

    async ecdsaSign(privateKey, message) {
      const key = await importPrivate(privateKey, 'ECDSA', false);
      const sig = new Uint8Array(
        await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, b(message)),
      );
      requireLength(sig, ECDSA_SIG_BYTES, 'signature');
      return sig;
    },

    async ecdsaVerify(publicKey, message, signature) {
      if (signature.length !== ECDSA_SIG_BYTES || !looksLikeUncompressedPoint(publicKey)) {
        return false;
      }
      let key: CryptoKey;
      try {
        key = await subtle.importKey(
          'raw',
          b(publicKey),
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        );
      } catch {
        // Contract of ecdsaVerify: a point that is not on the curve is "not valid", not an error.
        return false;
      }
      return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b(signature), b(message));
    },
  };
}
