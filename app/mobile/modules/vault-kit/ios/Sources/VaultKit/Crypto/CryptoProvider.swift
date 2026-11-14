// The only surface through which VaultKit touches cryptographic primitives
// (port of app/packages/core/src/crypto/provider.ts). Tests swap in a deterministic provider.

public struct KeyPair: Sendable, Equatable {
  /// 32-byte big-endian P-256 scalar.
  public var privateKey: Bytes
  /// 65-byte SEC1 uncompressed point (0x04 || X || Y).
  public var publicKey: Bytes

  public init(privateKey: Bytes, publicKey: Bytes) {
    self.privateKey = privateKey
    self.publicKey = publicKey
  }
}

public protocol CryptoProvider: Sendable {
  /// `n` cryptographically secure random bytes.
  func randomBytes(_ n: Int) throws -> Bytes
  func sha256(_ data: Bytes) -> Bytes
  func hmacSha256(key: Bytes, data: Bytes) -> Bytes
  func hkdfSha256(ikm: Bytes, salt: Bytes, info: Bytes, length: Int) throws -> Bytes
  func pbkdf2Sha256(password: Bytes, salt: Bytes, iterations: Int, length: Int) throws -> Bytes
  /// AES-256-GCM, 128-bit tag. Returns ciphertext || tag.
  func aesGcmEncrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes) throws -> Bytes
  /// Throws `CryptoError.decrypt` on any failure, without detail.
  func aesGcmDecrypt(key: Bytes, nonce: Bytes, ciphertextAndTag: Bytes, aad: Bytes) throws -> Bytes
  func generateKeyPair() throws -> KeyPair
  /// Public key (65 bytes, uncompressed) of a 32-byte private scalar.
  func publicKeyOf(privateKey: Bytes) throws -> Bytes
  /// ECDH P-256; the 32-byte X coordinate of the shared point.
  func ecdh(privateKey: Bytes, peerPublicKey: Bytes) throws -> Bytes
  /// ECDSA P-256 over SHA-256(message); 64-byte r || s (IEEE P1363).
  func ecdsaSign(privateKey: Bytes, message: Bytes) throws -> Bytes
  /// false (never throws) for a wrong length, an invalid public key or a bad signature.
  /// Both low-S and high-S signatures are accepted.
  func ecdsaVerify(publicKey: Bytes, message: Bytes, signature: Bytes) -> Bool
}

public enum CryptoSizes {
  public static let aesKey = 32
  public static let gcmNonce = 12
  public static let gcmTag = 16
  public static let p256Scalar = 32
  public static let p256Point = 65
  public static let ecdsaSignature = 64
}

func requireLength(_ value: Bytes, _ length: Int, _ what: String) throws {
  if value.count != length { throw CryptoError.input("\(what): need \(length) bytes") }
}

func requirePositive(_ n: Int, _ what: String) throws {
  if n < 1 { throw CryptoError.input("\(what): bad value") }
}

/// Structural check that a public key looks like an uncompressed SEC1 point.
public func looksLikeUncompressedPoint(_ pub: Bytes) -> Bool {
  pub.count == CryptoSizes.p256Point && pub[0] == 0x04
}
