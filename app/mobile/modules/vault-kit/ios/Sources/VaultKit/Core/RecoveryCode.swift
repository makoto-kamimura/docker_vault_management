// Recovery code (RC) — spec §8.11.1 / §8.11.2. Port of core/src/recovery-code.ts.

public struct RecoveryCodeKeys: Sendable {
  public var rcId: Bytes
  public var kekRC: Bytes
  public var authRC: Bytes
}

public struct RecoveryCodeRegistration: Sendable, Equatable {
  public var rcId: String
  public var wrappedVK: WrappedVk
  public var verifier: String
  public var vkVersion: Int
}

public enum RecoveryCode {
  static let dataChars = 52
  static let totalChars = 54
  static let prefix = "LVRC"

  public static func generate(_ p: CryptoProvider) throws -> Bytes { try p.randomBytes(ByteSize.rc) }

  static func requireRc(_ rc: Bytes) throws {
    guard rc.count == ByteSize.rc else { throw VaultCoreError(.invalidInput, "recovery code must be 32 bytes") }
  }

  /// rcId / kekRC / authRC = HKDF-SHA256(RC, salt = accountId bytes, info, 16 / 32 / 32).
  public static func deriveKeys(_ p: CryptoProvider, rc: Bytes, accountId: String) throws -> RecoveryCodeKeys {
    try requireRc(rc)
    let salt = try UUIDBytes.toBytes(accountId)
    return RecoveryCodeKeys(
      rcId: try p.hkdfSha256(ikm: rc, salt: salt, info: Array(Strings.HKDFInfo.rcId.utf8), length: ByteSize.rcId),
      kekRC: try p.hkdfSha256(ikm: rc, salt: salt, info: Array(Strings.HKDFInfo.rcKek.utf8), length: 32),
      authRC: try p.hkdfSha256(ikm: rc, salt: salt, info: Array(Strings.HKDFInfo.rcAuth.utf8), length: ByteSize.authRC))
  }

  public static func createRegistration(_ p: CryptoProvider, rc: Bytes, accountId: String, vk: Bytes, vkVersion: Int) throws -> RecoveryCodeRegistration {
    guard vk.count == ByteSize.vk else { throw VaultCoreError(.invalidInput, "vault key must be 32 bytes") }
    var keys = try deriveKeys(p, rc: rc, accountId: accountId)
    defer { wipe(&keys.kekRC); wipe(&keys.authRC) }
    let rcId = Base64Url.encode(keys.rcId)
    let nonce = try p.randomBytes(ByteSize.nonce)
    let ct = try p.aesGcmEncrypt(key: keys.kekRC, nonce: nonce, plaintext: vk, aad: Array(Strings.rcAad(accountId, rcId, vkVersion).utf8))
    return RecoveryCodeRegistration(
      rcId: rcId, wrappedVK: WrappedVk(nonce: Base64Url.encode(nonce), ct: Base64Url.encode(ct)),
      verifier: Base64Url.encode(p.sha256(keys.authRC)), vkVersion: vkVersion)
  }

  /// Step 5 of §8.11.4. `CryptoError.decrypt` on mismatch.
  public static func unwrapVaultKey(_ p: CryptoProvider, rc: Bytes, accountId: String, wrapped: WrappedVk, vkVersion: Int) throws -> Bytes {
    var keys = try deriveKeys(p, rc: rc, accountId: accountId)
    defer { wipe(&keys.kekRC); wipe(&keys.authRC) }
    guard let nonce = try? Base64Url.decode(wrapped.nonce), let ct = try? Base64Url.decode(wrapped.ct) else { throw CryptoError.decrypt }
    let vk = try p.aesGcmDecrypt(
      key: keys.kekRC, nonce: nonce, ciphertextAndTag: ct, aad: Array(Strings.rcAad(accountId, Base64Url.encode(keys.rcId), vkVersion).utf8))
    guard vk.count == ByteSize.vk else { throw VaultCoreError(.corrupted, "unexpected vault key size") }
    return vk
  }

  /// `LVRC-XXXXXX-…` (52 data + 2 check chars, 9 groups of 6).
  public static func format(_ p: CryptoProvider, _ rc: Bytes) throws -> String {
    try requireRc(rc)
    return prefix + "-" + Crockford.groupBy(Crockford.encode(rc) + Crockford.checkChars(p, rc), 6)
  }

  /// Lenient parse; `E_INVALID_RECOVERY_CODE`.
  public static func parse(_ p: CryptoProvider, _ input: String) throws -> Bytes {
    let invalid = VaultCoreError(.invalidRecoveryCode, "recovery code is not valid")
    guard let body = Crockford.normalize(input, prefix: prefix, bodyLength: totalChars), body.count == totalChars else { throw invalid }
    guard let rc = Crockford.decode(String(body.prefix(dataChars)), byteLength: ByteSize.rc) else { throw invalid }
    guard Crockford.checkChars(p, rc) == String(body.suffix(totalChars - dataChars)) else { throw invalid }
    return rc
  }

  /// The last 6 characters of the printed text (retyped to confirm the sheet).
  public static func confirmationTail(_ text: String) -> String {
    String(text.replacingOccurrences(of: "-", with: "").suffix(6))
  }
}
