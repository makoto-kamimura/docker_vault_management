// Typed models of @localvault/protocol/records.ts. `init(json:)` validates like the zod schema
// (strict objects) and `json` serializes in the zod output key order (= schema order), so
// `json.stringify()` equals JS `JSON.stringify(schema.parse(x))`.

// MARK: - §6.1 plaintext records

public struct UrlEntry: Sendable, Equatable {
  public var url: String
  public var match: String  // "domain" | "host"
  public init(url: String, match: String) { self.url = url; self.match = match }

  public init(json: JSONValue, path: String = "url") throws {
    let o = try StrictObject(json, allowed: ["url", "match"], path: path)
    url = try o.string("url", min: 1, max: Field.urlMax)
    match = try o.enumString("match", ["domain", "host"])
  }
  public var json: JSONValue { .obj([("url", .string(url)), ("match", .string(match))]) }
}

public struct AndroidAppLink: Sendable, Equatable {
  public var packageName: String
  public var certSha256: [String]
  public var label: String
  public var linkedAt: String

  public init(packageName: String, certSha256: [String], label: String, linkedAt: String) {
    self.packageName = packageName; self.certSha256 = certSha256; self.label = label; self.linkedAt = linkedAt
  }

  public init(json: JSONValue, path: String = "app") throws {
    let o = try StrictObject(json, allowed: ["packageName", "certSha256", "label", "linkedAt"], path: path)
    packageName = try o.string("packageName", where: Check.packageName)
    certSha256 = try o.array("certSha256", max: Field.androidCertsMax, min: 1).map {
      guard let s = $0.stringValue, Check.certSha256(s) else { throw SchemaError(path + ".certSha256") }
      return s
    }
    label = try o.string("label", max: Field.androidLabelMax)
    linkedAt = try o.string("linkedAt", where: Check.iso)
  }

  public var json: JSONValue {
    .obj([
      ("packageName", .string(packageName)), ("certSha256", .array(certSha256.map(JSONValue.string))),
      ("label", .string(label)), ("linkedAt", .string(linkedAt)),
    ])
  }
}

public struct PasswordHistoryEntry: Sendable, Equatable {
  public var password: String
  public var changedAt: String
  public init(password: String, changedAt: String) { self.password = password; self.changedAt = changedAt }

  public init(json: JSONValue, path: String = "history") throws {
    let o = try StrictObject(json, allowed: ["password", "changedAt"], path: path)
    password = try o.string("password", max: Field.passwordMax)
    changedAt = try o.string("changedAt", where: Check.iso)
  }
  public var json: JSONValue { .obj([("password", .string(password)), ("changedAt", .string(changedAt))]) }
}

public struct LoginData: Sendable, Equatable {
  public var title: String
  public var username: String
  public var password: String
  public var urls: [UrlEntry]
  public var androidApps: [AndroidAppLink]
  public var notes: String
  public var favorite: Bool
  public var createdAt: String
  public var trashedAt: String?
  public var conflictOf: String?
  /// nil = absent in JSON (treated as []); present arrays are serialized.
  public var passwordHistory: [PasswordHistoryEntry]?

  public init(
    title: String, username: String, password: String, urls: [UrlEntry], androidApps: [AndroidAppLink],
    notes: String, favorite: Bool, createdAt: String, trashedAt: String?, conflictOf: String?,
    passwordHistory: [PasswordHistoryEntry]?
  ) {
    self.title = title; self.username = username; self.password = password; self.urls = urls
    self.androidApps = androidApps; self.notes = notes; self.favorite = favorite; self.createdAt = createdAt
    self.trashedAt = trashedAt; self.conflictOf = conflictOf; self.passwordHistory = passwordHistory
  }

  static let keys = [
    "title", "username", "password", "urls", "androidApps", "notes", "favorite", "createdAt", "trashedAt",
    "conflictOf", "passwordHistory",
  ]

  public init(json: JSONValue, path: String = "data") throws {
    let o = try StrictObject(json, allowed: LoginData.keys, path: path)
    title = try o.string("title", min: Field.titleMin, max: Field.titleMax)
    username = try o.string("username", max: Field.usernameMax)
    password = try o.string("password", max: Field.passwordMax)
    urls = try o.array("urls", max: Field.urlsMax).map { try UrlEntry(json: $0, path: path + ".urls") }
    androidApps = try o.array("androidApps", max: Field.androidAppsMax).map {
      try AndroidAppLink(json: $0, path: path + ".androidApps")
    }
    notes = try o.string("notes", max: Field.notesMax)
    favorite = try o.bool("favorite")
    createdAt = try o.string("createdAt", where: Check.iso)
    trashedAt = try o.nullableString("trashedAt", check: Check.iso)
    conflictOf = try o.nullableString("conflictOf", check: Check.uuid)
    if o.has("passwordHistory") {
      passwordHistory = try o.array("passwordHistory", max: Field.passwordHistoryMax).map {
        try PasswordHistoryEntry(json: $0, path: path + ".passwordHistory")
      }
    } else {
      passwordHistory = nil
    }
  }

  public var history: [PasswordHistoryEntry] { passwordHistory ?? [] }

  public var json: JSONValue {
    var kv: [(String, JSONValue)] = [
      ("title", .string(title)), ("username", .string(username)), ("password", .string(password)),
      ("urls", .array(urls.map(\.json))), ("androidApps", .array(androidApps.map(\.json))),
      ("notes", .string(notes)), ("favorite", .bool(favorite)), ("createdAt", .string(createdAt)),
      ("trashedAt", .str(trashedAt)), ("conflictOf", .str(conflictOf)),
    ]
    if let h = passwordHistory { kv.append(("passwordHistory", .array(h.map(\.json)))) }
    return .object(kv)
  }
}

public struct DeviceData: Sendable, Equatable {
  public var deviceId: String
  public var name: String
  public var type: String  // mobile | extension
  public var platform: String  // ios | android | chrome | edge | brave
  public var signPub: String
  public var adminPub: String?
  public var addedAt: String
  public var addedBy: String
  public var addedVia: String  // setup | pairing | recovery-key | recovery-code
  public var revokedAt: String?

  public static let platforms = ["ios", "android", "chrome", "edge", "brave"]
  public static let types = ["mobile", "extension"]
  public static let vias = ["setup", "pairing", "recovery-key", "recovery-code"]

  public init(
    deviceId: String, name: String, type: String, platform: String, signPub: String, adminPub: String?,
    addedAt: String, addedBy: String, addedVia: String, revokedAt: String?
  ) {
    self.deviceId = deviceId; self.name = name; self.type = type; self.platform = platform
    self.signPub = signPub; self.adminPub = adminPub; self.addedAt = addedAt; self.addedBy = addedBy
    self.addedVia = addedVia; self.revokedAt = revokedAt
  }

  public init(json: JSONValue, path: String = "data") throws {
    let o = try StrictObject(
      json,
      allowed: ["deviceId", "name", "type", "platform", "signPub", "adminPub", "addedAt", "addedBy", "addedVia", "revokedAt"],
      path: path)
    deviceId = try o.string("deviceId", where: Check.uuid)
    name = try o.string("name", min: Field.deviceNameMin, max: Field.deviceNameMax)
    type = try o.enumString("type", DeviceData.types)
    platform = try o.enumString("platform", DeviceData.platforms)
    signPub = try o.string("signPub", where: Check.signPub)
    adminPub = try o.nullableString("adminPub", check: Check.signPub)
    addedAt = try o.string("addedAt", where: Check.iso)
    addedBy = try o.string("addedBy", where: Check.uuid)
    addedVia = try o.enumString("addedVia", DeviceData.vias)
    revokedAt = try o.nullableString("revokedAt", check: Check.iso)
  }

  public var json: JSONValue {
    .obj([
      ("deviceId", .string(deviceId)), ("name", .string(name)), ("type", .string(type)),
      ("platform", .string(platform)), ("signPub", .string(signPub)), ("adminPub", .str(adminPub)),
      ("addedAt", .string(addedAt)), ("addedBy", .string(addedBy)), ("addedVia", .string(addedVia)),
      ("revokedAt", .str(revokedAt)),
    ])
  }
}

public struct MetaData: Sendable, Equatable {
  public var recoveryKey: String
  public var pcSessionMaxSec: Int
  public var createdAt: String

  public init(recoveryKey: String, pcSessionMaxSec: Int, createdAt: String) {
    self.recoveryKey = recoveryKey; self.pcSessionMaxSec = pcSessionMaxSec; self.createdAt = createdAt
  }

  public init(json: JSONValue, path: String = "data") throws {
    let o = try StrictObject(json, allowed: ["recoveryKey", "pcSessionMaxSec", "createdAt"], path: path)
    recoveryKey = try o.string("recoveryKey", where: Check.recoveryKey)
    pcSessionMaxSec = try o.oneOf("pcSessionMaxSec", Limits.pcSessionMaxSec)
    createdAt = try o.string("createdAt", where: Check.iso)
  }

  public var json: JSONValue {
    .obj([("recoveryKey", .string(recoveryKey)), ("pcSessionMaxSec", .int(pcSessionMaxSec)), ("createdAt", .string(createdAt))])
  }
}

public enum RecordData: Sendable, Equatable {
  case login(LoginData)
  case device(DeviceData)
  case meta(MetaData)

  public var kind: String {
    switch self {
    case .login: "login"
    case .device: "device"
    case .meta: "meta"
    }
  }
}

public struct RecordPlain: Sendable, Equatable {
  public var data: RecordData
  public var updatedAt: String
  public var updatedBy: String

  public init(data: RecordData, updatedAt: String, updatedBy: String) {
    self.data = data; self.updatedAt = updatedAt; self.updatedBy = updatedBy
  }

  public var kind: String { data.kind }

  public init(json: JSONValue) throws {
    let o = try StrictObject(json, allowed: ["kind", "data", "updatedAt", "updatedBy"], path: "record")
    let kind = try o.enumString("kind", ["login", "device", "meta"])
    let d = try o.object("data")
    switch kind {
    case "login": data = .login(try LoginData(json: d))
    case "device": data = .device(try DeviceData(json: d))
    default: data = .meta(try MetaData(json: d))
    }
    updatedAt = try o.string("updatedAt", where: Check.iso)
    updatedBy = try o.string("updatedBy", where: Check.uuid)
  }

  public var json: JSONValue {
    let d: JSONValue
    switch data {
    case let .login(x): d = x.json
    case let .device(x): d = x.json
    case let .meta(x): d = x.json
    }
    return .obj([("kind", .string(kind)), ("data", d), ("updatedAt", .string(updatedAt)), ("updatedBy", .string(updatedBy))])
  }

  public var login: LoginData? { if case let .login(x) = data { return x }; return nil }
  public var device: DeviceData? { if case let .device(x) = data { return x }; return nil }
  public var meta: MetaData? { if case let .meta(x) = data { return x }; return nil }
}

// MARK: - §6.2 encrypted records

public struct EncryptedRecord: Sendable, Equatable {
  public var id: String
  public var rev: Int
  public var vkVersion: Int
  public var deleted: Bool
  public var nonce: String?
  public var ct: String?

  public init(id: String, rev: Int, vkVersion: Int, deleted: Bool, nonce: String?, ct: String?) {
    self.id = id; self.rev = rev; self.vkVersion = vkVersion; self.deleted = deleted; self.nonce = nonce; self.ct = ct
  }

  public init(json: JSONValue, path: String = "record") throws {
    let o = try StrictObject(json, allowed: ["id", "rev", "vkVersion", "deleted", "nonce", "ct"], path: path)
    id = try o.string("id", where: Check.uuid)
    rev = try o.int("rev", min: 0)
    vkVersion = try o.int("vkVersion", min: 1)
    (deleted, nonce, ct) = try cipherFields(o)
  }

  public var json: JSONValue {
    .obj([
      ("id", .string(id)), ("rev", .int(rev)), ("vkVersion", .int(vkVersion)), ("deleted", .bool(deleted)),
      ("nonce", .str(nonce)), ("ct", .str(ct)),
    ])
  }
}

/// `deleted:false` needs a nonce and ciphertext; `deleted:true` needs both null.
func cipherFields(_ o: StrictObject) throws -> (Bool, String?, String?) {
  let deleted = try o.bool("deleted")
  if deleted {
    guard o.raw("nonce")?.isNull == true, o.raw("ct")?.isNull == true else { throw o.fail("nonce") }
    return (true, nil, nil)
  }
  return (false, try o.string("nonce", where: Check.nonce), try o.string("ct", where: Check.ciphertext))
}

public struct RecordChange: Sendable, Equatable {
  public var id: String
  public var baseRev: Int
  public var vkVersion: Int
  public var deleted: Bool
  public var nonce: String?
  public var ct: String?

  public init(id: String, baseRev: Int, vkVersion: Int, deleted: Bool, nonce: String?, ct: String?) {
    self.id = id; self.baseRev = baseRev; self.vkVersion = vkVersion; self.deleted = deleted; self.nonce = nonce; self.ct = ct
  }

  public var json: JSONValue {
    .obj([
      ("id", .string(id)), ("baseRev", .int(baseRev)), ("vkVersion", .int(vkVersion)), ("deleted", .bool(deleted)),
      ("nonce", .str(nonce)), ("ct", .str(ct)),
    ])
  }
}

public enum PushResult: Sendable, Equatable {
  case ok(id: String, rev: Int)
  case conflict(id: String, current: EncryptedRecord)

  public var id: String {
    switch self {
    case let .ok(id, _), let .conflict(id, _): id
    }
  }

  public init(json: JSONValue) throws {
    guard let status = json["status"]?.stringValue else { throw SchemaError("push.status") }
    if status == "ok" {
      let o = try StrictObject(json, allowed: ["id", "status", "rev"], path: "push")
      self = .ok(id: try o.string("id", where: Check.uuid), rev: try o.int("rev", min: 1))
    } else if status == "conflict" {
      let o = try StrictObject(json, allowed: ["id", "status", "current"], path: "push")
      self = .conflict(id: try o.string("id", where: Check.uuid), current: try EncryptedRecord(json: try o.object("current")))
    } else {
      throw SchemaError("push.status")
    }
  }
}

public struct RotationRecord: Sendable, Equatable {
  public var id: String
  public var deleted: Bool
  public var nonce: String?
  public var ct: String?

  public init(id: String, deleted: Bool, nonce: String?, ct: String?) {
    self.id = id; self.deleted = deleted; self.nonce = nonce; self.ct = ct
  }

  public var json: JSONValue {
    .obj([("id", .string(id)), ("deleted", .bool(deleted)), ("nonce", .str(nonce)), ("ct", .str(ct))])
  }
}

// MARK: - keyset

public struct Kdf: Sendable, Equatable {
  public static let alg = "PBKDF2-HMAC-SHA256"
  public var iterations: Int
  public var salt: String

  public init(iterations: Int, salt: String) { self.iterations = iterations; self.salt = salt }

  public init(json: JSONValue, path: String = "kdf") throws {
    let o = try StrictObject(json, allowed: ["alg", "iterations", "salt"], path: path)
    try o.literal("alg", Kdf.alg)
    iterations = try o.int("iterations", min: Limits.kdfMinIterations, max: Limits.kdfMaxIterations)
    salt = try o.string("salt", where: Check.b64(ByteSize.kdfSalt))
  }

  public var json: JSONValue { .obj([("alg", .string(Kdf.alg)), ("iterations", .int(iterations)), ("salt", .string(salt))]) }
}

public struct WrappedVk: Sendable, Equatable {
  public var nonce: String
  public var ct: String

  public init(nonce: String, ct: String) { self.nonce = nonce; self.ct = ct }

  public init(json: JSONValue, path: String = "wrappedVK") throws {
    let o = try StrictObject(json, allowed: ["nonce", "ct"], path: path)
    nonce = try o.string("nonce", where: Check.nonce)
    ct = try o.string("ct", where: Check.b64(ByteSize.wrappedVkCt))
  }

  public var json: JSONValue { .obj([("nonce", .string(nonce)), ("ct", .string(ct))]) }
}

public struct Keyset: Sendable, Equatable {
  public var keysetVersion: Int
  public var vkVersion: Int
  public var kdf: Kdf
  public var wrappedVK: WrappedVk

  public init(keysetVersion: Int, vkVersion: Int, kdf: Kdf, wrappedVK: WrappedVk) {
    self.keysetVersion = keysetVersion; self.vkVersion = vkVersion; self.kdf = kdf; self.wrappedVK = wrappedVK
  }

  public init(json: JSONValue, path: String = "keyset") throws {
    let o = try StrictObject(json, allowed: ["keysetVersion", "vkVersion", "kdf", "wrappedVK"], path: path)
    keysetVersion = try o.int("keysetVersion", min: 1)
    vkVersion = try o.int("vkVersion", min: 1)
    kdf = try Kdf(json: try o.object("kdf"))
    wrappedVK = try WrappedVk(json: try o.object("wrappedVK"))
  }

  public var json: JSONValue {
    .obj([("keysetVersion", .int(keysetVersion)), ("vkVersion", .int(vkVersion)), ("kdf", kdf.json), ("wrappedVK", wrappedVK.json)])
  }
}

// MARK: - §8.5 Seal

public struct SealEnvelope: Sendable, Equatable {
  public var epk: String
  public var nonce: String
  public var ct: String

  public init(epk: String, nonce: String, ct: String) { self.epk = epk; self.nonce = nonce; self.ct = ct }

  public init(json: JSONValue) throws {
    let o = try StrictObject(json, allowed: ["epk", "nonce", "ct"], path: "envelope")
    epk = try o.string("epk", where: Check.b64(ByteSize.ephPub))
    nonce = try o.string("nonce", where: Check.nonce)
    ct = try o.string("ct", where: Check.ciphertext)
  }

  public var json: JSONValue { .obj([("epk", .string(epk)), ("nonce", .string(nonce)), ("ct", .string(ct))]) }
}

public struct SealPlaintext: Sendable, Equatable {
  public var vk: String
  public var vkVersion: Int
  public var sessionMaxSec: Int
  public var issuedAt: String

  public init(vk: String, vkVersion: Int, sessionMaxSec: Int, issuedAt: String) {
    self.vk = vk; self.vkVersion = vkVersion; self.sessionMaxSec = sessionMaxSec; self.issuedAt = issuedAt
  }

  public init(json: JSONValue) throws {
    let o = try StrictObject(json, allowed: ["vk", "vkVersion", "sessionMaxSec", "issuedAt"], path: "seal")
    vk = try o.string("vk", where: Check.b64(ByteSize.vk))
    vkVersion = try o.int("vkVersion", min: 1)
    sessionMaxSec = try o.oneOf("sessionMaxSec", Limits.pcSessionMaxSec)
    issuedAt = try o.string("issuedAt", where: Check.iso)
  }

  public var json: JSONValue {
    .obj([("vk", .string(vk)), ("vkVersion", .int(vkVersion)), ("sessionMaxSec", .int(sessionMaxSec)), ("issuedAt", .string(issuedAt))])
  }
}

// MARK: - §6.3 vault file

public struct VaultFileRecord: Sendable, Equatable {
  public var id: String
  public var rev: Int
  public var vkVersion: Int
  public var deleted: Bool
  public var nonce: String?
  public var ct: String?
  public var dirty: Bool
  public var baseRev: Int

  public init(id: String, rev: Int, vkVersion: Int, deleted: Bool, nonce: String?, ct: String?, dirty: Bool, baseRev: Int) {
    self.id = id; self.rev = rev; self.vkVersion = vkVersion; self.deleted = deleted
    self.nonce = nonce; self.ct = ct; self.dirty = dirty; self.baseRev = baseRev
  }

  public init(json: JSONValue) throws {
    let o = try StrictObject(json, allowed: ["id", "rev", "vkVersion", "deleted", "nonce", "ct", "dirty", "baseRev"], path: "vaultRecord")
    id = try o.string("id", where: Check.uuid)
    rev = try o.int("rev", min: 0)
    vkVersion = try o.int("vkVersion", min: 1)
    (deleted, nonce, ct) = try cipherFields(o)
    dirty = try o.bool("dirty")
    baseRev = try o.int("baseRev", min: 0)
  }

  public var json: JSONValue {
    .obj([
      ("id", .string(id)), ("rev", .int(rev)), ("vkVersion", .int(vkVersion)), ("deleted", .bool(deleted)),
      ("nonce", .str(nonce)), ("ct", .str(ct)), ("dirty", .bool(dirty)), ("baseRev", .int(baseRev)),
    ])
  }

  public var encrypted: EncryptedRecord {
    EncryptedRecord(id: id, rev: rev, vkVersion: vkVersion, deleted: deleted, nonce: nonce, ct: ct)
  }
}

public struct VaultSyncState: Sendable, Equatable {
  public var cursor: Int
  public var maxSeenRev: Int
  public var lastSyncedAt: String?

  public init(cursor: Int, maxSeenRev: Int, lastSyncedAt: String?) {
    self.cursor = cursor; self.maxSeenRev = maxSeenRev; self.lastSyncedAt = lastSyncedAt
  }

  public var json: JSONValue {
    .obj([("cursor", .int(cursor)), ("maxSeenRev", .int(maxSeenRev)), ("lastSyncedAt", .str(lastSyncedAt))])
  }
}

public struct VaultFile: Sendable, Equatable {
  public var accountId: String
  public var accountName: String
  public var serverUrl: String
  public var keyset: Keyset
  public var records: [VaultFileRecord]
  public var sync: VaultSyncState

  public init(accountId: String, accountName: String, serverUrl: String, keyset: Keyset, records: [VaultFileRecord], sync: VaultSyncState) {
    self.accountId = accountId; self.accountName = accountName; self.serverUrl = serverUrl
    self.keyset = keyset; self.records = records; self.sync = sync
  }

  public init(json: JSONValue) throws {
    let o = try StrictObject(
      json, allowed: ["format", "version", "accountId", "accountName", "serverUrl", "keyset", "records", "sync"], path: "vault")
    try o.literal("format", "localvault")
    try o.literal("version", 2)
    accountId = try o.string("accountId", where: Check.uuid)
    accountName = try o.string("accountName", min: Field.accountNameMin, max: Field.accountNameMax)
    serverUrl = try o.string("serverUrl", min: 1, max: Field.urlMax)
    keyset = try Keyset(json: try o.object("keyset"))
    records = try o.array("records").map { try VaultFileRecord(json: $0) }
    let s = try StrictObject(try o.object("sync"), allowed: ["cursor", "maxSeenRev", "lastSyncedAt"], path: "vault.sync")
    sync = VaultSyncState(
      cursor: try s.int("cursor", min: 0), maxSeenRev: try s.int("maxSeenRev", min: 0),
      lastSyncedAt: try s.nullableString("lastSyncedAt", check: Check.iso))
  }

  public var json: JSONValue {
    .obj([
      ("format", .string("localvault")), ("version", .int(2)), ("accountId", .string(accountId)),
      ("accountName", .string(accountName)), ("serverUrl", .string(serverUrl)), ("keyset", keyset.json),
      ("records", .array(records.map(\.json))), ("sync", sync.json),
    ])
  }
}

// MARK: - device registration (API)

public struct DeviceRegistration: Sendable, Equatable {
  public var deviceId: String
  public var type: String
  public var platform: String
  public var signPub: String
  public var adminPub: String?

  public init(deviceId: String, type: String, platform: String, signPub: String, adminPub: String?) {
    self.deviceId = deviceId; self.type = type; self.platform = platform; self.signPub = signPub; self.adminPub = adminPub
  }

  public init(json: JSONValue) throws {
    let o = try StrictObject(json, allowed: ["deviceId", "type", "platform", "signPub", "adminPub"], path: "device")
    deviceId = try o.string("deviceId", where: Check.uuid)
    type = try o.enumString("type", DeviceData.types)
    platform = try o.enumString("platform", DeviceData.platforms)
    signPub = try o.string("signPub", where: Check.signPub)
    adminPub = try o.nullableString("adminPub", check: Check.signPub)
    guard (type == "mobile") == (adminPub != nil) else { throw SchemaError("device.adminPub") }
    let mobilePlatform = platform == "ios" || platform == "android"
    guard (type == "mobile") == mobilePlatform else { throw SchemaError("device.platform") }
  }

  public var json: JSONValue {
    .obj([("deviceId", .string(deviceId)), ("type", .string(type)), ("platform", .string(platform)), ("signPub", .string(signPub)), ("adminPub", .str(adminPub))])
  }
}
