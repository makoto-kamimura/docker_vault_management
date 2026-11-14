// `.lvbackup` export file — spec §6.5. Port of core/src/export-file.ts.
// A fresh random key K encrypts the payload; K is wrapped by a PBKDF2 key from the export password.

public struct ExportItem: Sendable, Equatable {
  public var id: String
  public var data: LoginData
  public var updatedAt: String

  public init(id: String, data: LoginData, updatedAt: String) { self.id = id; self.data = data; self.updatedAt = updatedAt }

  public init(json: JSONValue) throws {
    let o = try StrictObject(json, allowed: ["id", "data", "updatedAt"], path: "item")
    id = try o.string("id", where: Check.uuid)
    data = try LoginData(json: try o.object("data"))
    updatedAt = try o.string("updatedAt", where: Check.iso)
  }

  public var json: JSONValue { .obj([("id", .string(id)), ("data", data.json), ("updatedAt", .string(updatedAt))]) }
}

public struct ExportPayload: Sendable, Equatable {
  public var items: [ExportItem]
  public init(items: [ExportItem]) { self.items = items }

  public init(json: JSONValue) throws {
    let o = try StrictObject(json, allowed: ["items"], path: "payload")
    items = try o.array("items").map { try ExportItem(json: $0) }
  }

  public var json: JSONValue { .obj([("items", .array(items.map(\.json)))]) }
}

public struct ExportFileModel: Sendable, Equatable {
  public var exportedAt: String
  public var kdf: Kdf
  public var wrappedKey: WrappedVk
  public var payloadNonce: String
  public var payloadCt: String

  public init(json: JSONValue) throws {
    let o = try StrictObject(json, allowed: ["format", "version", "exportedAt", "kdf", "wrappedKey", "payload"], path: "export")
    try o.literal("format", "localvault-export")
    try o.literal("version", 1)
    exportedAt = try o.string("exportedAt", where: Check.iso)
    kdf = try Kdf(json: try o.object("kdf"))
    wrappedKey = try WrappedVk(json: try o.object("wrappedKey"))
    let p = try StrictObject(try o.object("payload"), allowed: ["nonce", "ct"], path: "export.payload")
    payloadNonce = try p.string("nonce", where: Check.nonce)
    payloadCt = try p.string("ct", where: Check.b64Max(512 * 1024 * 1024))
  }

  init(exportedAt: String, kdf: Kdf, wrappedKey: WrappedVk, payloadNonce: String, payloadCt: String) {
    self.exportedAt = exportedAt; self.kdf = kdf; self.wrappedKey = wrappedKey; self.payloadNonce = payloadNonce; self.payloadCt = payloadCt
  }

  public var json: JSONValue {
    .obj([
      ("format", .string("localvault-export")), ("version", .int(1)), ("exportedAt", .string(exportedAt)), ("kdf", kdf.json),
      ("wrappedKey", wrappedKey.json), ("payload", .obj([("nonce", .string(payloadNonce)), ("ct", .string(payloadCt))])),
    ])
  }
}

public enum ExportFile {
  public static func create(
    _ p: CryptoProvider, exportPassword: String, payload: ExportPayload, exportedAt: String, iterations: Int? = nil
  ) throws -> ExportFileModel {
    guard exportPassword.utf16.count >= Field.exportPasswordMin else { throw VaultCoreError(.invalidInput, "export password too short") }
    let checked: ExportPayload
    do { checked = try ExportPayload(json: payload.json) } catch { throw VaultCoreError(.invalidInput, "export payload does not match the schema") }
    let kdf = try Keys.generateKdf(p, iterations: iterations ?? Limits.kdfMinIterations)
    var passwordKey = try p.pbkdf2Sha256(
      password: Keys.passwordBytes(exportPassword), salt: try Base64Url.decode(kdf.salt), iterations: kdf.iterations, length: 32)
    var fileKey = try p.randomBytes(32)
    defer { wipe(&passwordKey); wipe(&fileKey) }
    let keyNonce = try p.randomBytes(ByteSize.nonce)
    let wrappedCt = try p.aesGcmEncrypt(key: passwordKey, nonce: keyNonce, plaintext: fileKey, aad: Array(Strings.exportAadKey.utf8))
    let payloadNonce = try p.randomBytes(ByteSize.nonce)
    let payloadCt = try p.aesGcmEncrypt(key: fileKey, nonce: payloadNonce, plaintext: checked.json.utf8(), aad: Array(Strings.exportAadPayload.utf8))
    let file = ExportFileModel(
      exportedAt: exportedAt, kdf: kdf, wrappedKey: WrappedVk(nonce: Base64Url.encode(keyNonce), ct: Base64Url.encode(wrappedCt)),
      payloadNonce: Base64Url.encode(payloadNonce), payloadCt: Base64Url.encode(payloadCt))
    return try ExportFileModel(json: file.json)
  }

  /// `E_IMPORT_FORMAT` (not an export / damaged), `E_UNSUPPORTED_VERSION`, `E_WRONG_PASSWORD`.
  public static func open(_ p: CryptoProvider, exportPassword: String, file: JSONValue) throws -> (payload: ExportPayload, exportedAt: String) {
    if file["format"]?.stringValue == "localvault-export", let v = file["version"]?.doubleValue, v > 1 {
      throw VaultCoreError(.unsupportedVersion)
    }
    let f: ExportFileModel
    do { f = try ExportFileModel(json: file) } catch { throw VaultCoreError(.importFormat, "not a LocalVault export file") }
    var passwordKey = try p.pbkdf2Sha256(
      password: Keys.passwordBytes(exportPassword), salt: try Base64Url.decode(f.kdf.salt), iterations: f.kdf.iterations, length: 32)
    var fileKey: Bytes
    do {
      defer { wipe(&passwordKey) }
      do {
        fileKey = try p.aesGcmDecrypt(
          key: passwordKey, nonce: try Base64Url.decode(f.wrappedKey.nonce), ciphertextAndTag: try Base64Url.decode(f.wrappedKey.ct),
          aad: Array(Strings.exportAadKey.utf8))
      } catch CryptoError.decrypt {
        throw VaultCoreError(.wrongPassword)
      }
    }
    defer { wipe(&fileKey) }
    let plaintext: Bytes
    do {
      plaintext = try p.aesGcmDecrypt(
        key: fileKey, nonce: try Base64Url.decode(f.payloadNonce), ciphertextAndTag: try Base64Url.decode(f.payloadCt),
        aad: Array(Strings.exportAadPayload.utf8))
    } catch CryptoError.decrypt {
      throw VaultCoreError(.importFormat, "payload is damaged")
    }
    let json: JSONValue
    do { json = try JSONValue.parse(plaintext) } catch { throw VaultCoreError(.importFormat, "payload is not JSON") }
    do { return (try ExportPayload(json: json), f.exportedAt) } catch {
      throw VaultCoreError(.importFormat, "payload does not match the schema")
    }
  }
}
