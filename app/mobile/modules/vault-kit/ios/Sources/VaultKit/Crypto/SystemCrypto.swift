// CryptoProvider on Apple system frameworks: CryptoKit (SHA-256, HMAC, HKDF, AES-GCM, P-256) and
// CommonCrypto (PBKDF2, native speed: ~0.3 s for 600k iterations on an A14). No third-party code.
import CommonCrypto
import CryptoKit
import Foundation
import Security

public struct SystemCrypto: CryptoProvider {
  public init() {}

  public func randomBytes(_ n: Int) throws -> Bytes {
    if n < 0 { throw CryptoError.input("random: bad length") }
    if n == 0 { return [] }
    var out = Bytes(repeating: 0, count: n)
    let status = SecRandomCopyBytes(kSecRandomDefault, n, &out)
    if status != errSecSuccess { throw VaultCoreError(.io, "random source failed") }
    return out
  }

  public func sha256(_ data: Bytes) -> Bytes {
    Array(SHA256.hash(data: data))
  }

  public func hmacSha256(key: Bytes, data: Bytes) -> Bytes {
    Array(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
  }

  public func hkdfSha256(ikm: Bytes, salt: Bytes, info: Bytes, length: Int) throws -> Bytes {
    try requirePositive(length, "HKDF length")
    if length > 255 * 32 { throw CryptoError.input("HKDF length: bad value") }
    let key = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: length)
    return key.withUnsafeBytes { Array($0) }
  }

  public func pbkdf2Sha256(password: Bytes, salt: Bytes, iterations: Int, length: Int) throws -> Bytes {
    try requirePositive(iterations, "PBKDF2 iterations")
    try requirePositive(length, "PBKDF2 length")
    guard iterations <= Int(UInt32.max) else { throw CryptoError.input("PBKDF2 iterations: bad value") }
    var out = Bytes(repeating: 0, count: length)
    let status = password.withUnsafeBufferPointer { pw in
      salt.withUnsafeBufferPointer { s in
        CCKeyDerivationPBKDF(
          CCPBKDFAlgorithm(kCCPBKDF2),
          pw.baseAddress.map { UnsafeRawPointer($0).assumingMemoryBound(to: Int8.self) },
          pw.count,
          s.baseAddress, s.count,
          CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
          UInt32(iterations),
          &out, length)
      }
    }
    if status != Int32(kCCSuccess) { throw CryptoError.input("PBKDF2 failed") }
    return out
  }

  public func aesGcmEncrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes) throws -> Bytes {
    try requireLength(key, CryptoSizes.aesKey, "AES key")
    try requireLength(nonce, CryptoSizes.gcmNonce, "GCM nonce")
    let box = try AES.GCM.seal(
      plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
    return Array(box.ciphertext) + Array(box.tag)
  }

  public func aesGcmDecrypt(key: Bytes, nonce: Bytes, ciphertextAndTag: Bytes, aad: Bytes) throws -> Bytes {
    guard key.count == CryptoSizes.aesKey, nonce.count == CryptoSizes.gcmNonce,
      ciphertextAndTag.count >= CryptoSizes.gcmTag
    else { throw CryptoError.decrypt }
    do {
      let split = ciphertextAndTag.count - CryptoSizes.gcmTag
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonce),
        ciphertext: ciphertextAndTag[..<split],
        tag: ciphertextAndTag[split...])
      return Array(try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad))
    } catch {
      throw CryptoError.decrypt
    }
  }

  public func generateKeyPair() throws -> KeyPair {
    let k = P256.KeyAgreement.PrivateKey()
    return KeyPair(privateKey: Array(k.rawRepresentation), publicKey: Array(k.publicKey.x963Representation))
  }

  public func publicKeyOf(privateKey: Bytes) throws -> Bytes {
    try requireLength(privateKey, CryptoSizes.p256Scalar, "P-256 private key")
    do {
      return Array(try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey).publicKey.x963Representation)
    } catch {
      throw CryptoError.input("P-256 private key: invalid")
    }
  }

  public func ecdh(privateKey: Bytes, peerPublicKey: Bytes) throws -> Bytes {
    try requireLength(privateKey, CryptoSizes.p256Scalar, "P-256 private key")
    guard looksLikeUncompressedPoint(peerPublicKey) else { throw CryptoError.input("P-256 public key: invalid") }
    do {
      let priv = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
      let pub = try P256.KeyAgreement.PublicKey(x963Representation: peerPublicKey)
      let shared = try priv.sharedSecretFromKeyAgreement(with: pub)
      return shared.withUnsafeBytes { Array($0) }
    } catch {
      throw CryptoError.input("ECDH failed")
    }
  }

  public func ecdsaSign(privateKey: Bytes, message: Bytes) throws -> Bytes {
    try requireLength(privateKey, CryptoSizes.p256Scalar, "P-256 private key")
    do {
      let k = try P256.Signing.PrivateKey(rawRepresentation: privateKey)
      return Array(try k.signature(for: message).rawRepresentation)
    } catch {
      throw CryptoError.input("ECDSA sign failed")
    }
  }

  public func ecdsaVerify(publicKey: Bytes, message: Bytes, signature: Bytes) -> Bool {
    guard looksLikeUncompressedPoint(publicKey), signature.count == CryptoSizes.ecdsaSignature,
      let pub = try? P256.Signing.PublicKey(x963Representation: publicKey),
      let sig = try? P256.Signing.ECDSASignature(rawRepresentation: P256Order.lowS(signature))
    else { return false }
    return pub.isValidSignature(sig, for: message)
  }
}

/// P-256 group order helpers: (r, s) and (r, n - s) are both valid, so verifying the low-S form
/// accepts high-S signatures regardless of the underlying library's policy.
enum P256Order {
  static let n: Bytes = Array(
    try! Hex.decode("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"))
  static let halfN: Bytes = Array(
    try! Hex.decode("7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8"))

  static func greater(_ a: ArraySlice<UInt8>, _ b: Bytes) -> Bool {
    for (x, y) in zip(a, b) where x != y { return x > y }
    return false
  }

  static func lowS(_ sig: Bytes) -> Bytes {
    let s = sig[32..<64]
    guard greater(s, halfN) else { return sig }
    var out = Bytes(repeating: 0, count: 32)
    var borrow = 0
    for i in stride(from: 31, through: 0, by: -1) {
      var d = Int(n[i]) - Int(s[32 + i]) - borrow
      borrow = d < 0 ? 1 : 0
      if d < 0 { d += 256 }
      out[i] = UInt8(d)
    }
    return Array(sig[0..<32]) + out
  }
}
