// Test-vector support (port of core/src/crypto/deterministic.ts): randomness and key pairs come
// from queues the test fills in advance; everything else is SystemCrypto.
import Foundation

@testable import VaultKit

final class DeterministicCrypto: CryptoProvider, @unchecked Sendable {
  let inner = SystemCrypto()
  private var randoms: [Bytes] = []
  private var pairs: [KeyPair] = []
  private let lock = NSLock()

  func enqueueRandom(_ values: Bytes...) { lock.withLock { randoms.append(contentsOf: values) } }
  func enqueueKeyPair(_ p: KeyPair) { lock.withLock { pairs.append(p) } }
  var drained: Bool { lock.withLock { randoms.isEmpty && pairs.isEmpty } }

  func randomBytes(_ n: Int) throws -> Bytes {
    try lock.withLock {
      guard !randoms.isEmpty else { throw CryptoError.input("deterministic randomness exhausted") }
      let next = randoms.removeFirst()
      guard next.count == n else { throw CryptoError.input("deterministic randomness: wanted \(n), queued \(next.count)") }
      return next
    }
  }

  func generateKeyPair() throws -> KeyPair {
    try lock.withLock {
      guard !pairs.isEmpty else { throw CryptoError.input("deterministic key pairs exhausted") }
      return pairs.removeFirst()
    }
  }

  func sha256(_ data: Bytes) -> Bytes { inner.sha256(data) }
  func hmacSha256(key: Bytes, data: Bytes) -> Bytes { inner.hmacSha256(key: key, data: data) }
  func hkdfSha256(ikm: Bytes, salt: Bytes, info: Bytes, length: Int) throws -> Bytes {
    try inner.hkdfSha256(ikm: ikm, salt: salt, info: info, length: length)
  }
  func pbkdf2Sha256(password: Bytes, salt: Bytes, iterations: Int, length: Int) throws -> Bytes {
    try inner.pbkdf2Sha256(password: password, salt: salt, iterations: iterations, length: length)
  }
  func aesGcmEncrypt(key: Bytes, nonce: Bytes, plaintext: Bytes, aad: Bytes) throws -> Bytes {
    try inner.aesGcmEncrypt(key: key, nonce: nonce, plaintext: plaintext, aad: aad)
  }
  func aesGcmDecrypt(key: Bytes, nonce: Bytes, ciphertextAndTag: Bytes, aad: Bytes) throws -> Bytes {
    try inner.aesGcmDecrypt(key: key, nonce: nonce, ciphertextAndTag: ciphertextAndTag, aad: aad)
  }
  func publicKeyOf(privateKey: Bytes) throws -> Bytes { try inner.publicKeyOf(privateKey: privateKey) }
  func ecdh(privateKey: Bytes, peerPublicKey: Bytes) throws -> Bytes { try inner.ecdh(privateKey: privateKey, peerPublicKey: peerPublicKey) }
  func ecdsaSign(privateKey: Bytes, message: Bytes) throws -> Bytes { try inner.ecdsaSign(privateKey: privateKey, message: message) }
  func ecdsaVerify(publicKey: Bytes, message: Bytes, signature: Bytes) -> Bool {
    inner.ecdsaVerify(publicKey: publicKey, message: message, signature: signature)
  }
}

extension Dictionary where Key == String, Value == Any {
  /// The raw JSON sub-tree as an order-preserving JSONValue (re-parsed from the file text so the
  /// key order is the file's, as JS would see it).
  func json(_ k: String) throws -> JSONValue {
    let data = try JSONSerialization.data(withJSONObject: self[k] as Any, options: [.fragmentsAllowed])
    return try JSONValue.parse(Array(data))
  }
}
