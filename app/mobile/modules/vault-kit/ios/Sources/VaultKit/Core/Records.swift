// Record encryption — spec §6.1/§6.2. Port of core/src/records.ts.
//   AES-256-GCM(VK, fresh nonce, JSON(RecordPlain) padded with spaces to a multiple of 256 bytes,
//               AAD = "lv|v2|rec|<accountId>|<recordId>|<vkVersion>")

public struct EncryptedPayload: Sendable, Equatable {
  public var nonce: String
  public var ct: String
  public init(nonce: String, ct: String) { self.nonce = nonce; self.ct = ct }
}

public struct RecordLocator: Sendable, Equatable {
  public var accountId: String
  public var recordId: String
  public var vkVersion: Int
  public init(accountId: String, recordId: String, vkVersion: Int) {
    self.accountId = accountId; self.recordId = recordId; self.vkVersion = vkVersion
  }
}

public enum Records {
  public static let padBlock = 256

  /// The next multiple of 256 (unchanged if already a multiple; at least 256).
  public static func paddedLength(_ jsonByteLength: Int) -> Int {
    max(1, (jsonByteLength + padBlock - 1) / padBlock) * padBlock
  }

  static func pad(_ json: Bytes) -> Bytes {
    json + Bytes(repeating: 0x20, count: paddedLength(json.count) - json.count)
  }

  static func checkLocator(_ l: RecordLocator) throws {
    guard UUIDBytes.isValid(l.recordId), UUIDBytes.isValid(l.accountId) else { throw VaultCoreError(.invalidInput, "bad id") }
    guard l.vkVersion >= 1 else { throw VaultCoreError(.invalidInput, "bad vkVersion") }
  }

  public static func encrypt(_ p: CryptoProvider, vk: Bytes, locator: RecordLocator, record: RecordPlain) throws -> EncryptedPayload {
    try checkLocator(locator)
    guard vk.count == ByteSize.vk else { throw VaultCoreError(.invalidInput, "vault key must be 32 bytes") }
    // Re-validate through the schema (the TS reference parses before encrypting).
    let json = record.json
    let checked: RecordPlain
    do { checked = try RecordPlain(json: json) } catch { throw VaultCoreError(.invalidInput, "record does not match the schema") }
    guard (checked.kind == "meta") == (locator.recordId == metaRecordId) else {
      throw VaultCoreError(.invalidInput, "record kind does not match its id")
    }
    let plaintext = pad(checked.json.utf8())
    guard plaintext.count + ByteSize.gcmTag <= Limits.maxCiphertextBytes else {
      throw VaultCoreError(.tooLarge, "record exceeds the ciphertext limit")
    }
    let nonce = try p.randomBytes(ByteSize.nonce)
    let ct = try p.aesGcmEncrypt(
      key: vk, nonce: nonce, plaintext: plaintext,
      aad: Array(Strings.recordAad(locator.accountId, locator.recordId, locator.vkVersion).utf8))
    return EncryptedPayload(nonce: Base64Url.encode(nonce), ct: Base64Url.encode(ct))
  }

  /// `CryptoError.decrypt` for a key / AAD / nonce / ciphertext mismatch; `E_CORRUPTED` when the
  /// authenticated plaintext is not a valid record. A missing `passwordHistory` becomes [].
  public static func decrypt(_ p: CryptoProvider, vk: Bytes, locator: RecordLocator, payload: EncryptedPayload) throws -> RecordPlain {
    try checkLocator(locator)
    guard let nonce = try? Base64Url.decode(payload.nonce), let ct = try? Base64Url.decode(payload.ct) else { throw CryptoError.decrypt }
    let plaintext = try p.aesGcmDecrypt(
      key: vk, nonce: nonce, ciphertextAndTag: ct,
      aad: Array(Strings.recordAad(locator.accountId, locator.recordId, locator.vkVersion).utf8))
    let json: JSONValue
    do { json = try JSONValue.parse(plaintext) } catch { throw VaultCoreError(.corrupted, "record plaintext is not JSON") }
    var rec: RecordPlain
    do { rec = try RecordPlain(json: json) } catch { throw VaultCoreError(.corrupted, "record plaintext does not match the schema") }
    guard (rec.kind == "meta") == (locator.recordId == metaRecordId) else {
      throw VaultCoreError(.corrupted, "record kind does not match its id")
    }
    if case var .login(d) = rec.data {
      d.passwordHistory = d.history
      rec.data = .login(d)
    }
    return rec
  }
}
