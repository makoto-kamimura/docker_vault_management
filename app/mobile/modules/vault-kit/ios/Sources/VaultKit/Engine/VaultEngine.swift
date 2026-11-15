// The stateful VaultCore (spec §15 + v0.4), ported from vault-engine/src/engine.ts. It never talks
// to the network: secret-bearing operations return `ServerRequest`s for JS to send. An actor, so
// calls are serialised like the single-threaded JS reference.
import Foundation

public struct ServerRequest: Sendable, Equatable {
  public var method: String
  public var path: String
  public var body: JSONValue?
  public var headers: [(String, String)]

  public init(method: String, path: String, body: JSONValue? = nil, headers: [(String, String)] = []) {
    self.method = method; self.path = path; self.body = body; self.headers = headers
  }

  public static func == (a: ServerRequest, b: ServerRequest) -> Bool {
    a.method == b.method && a.path == b.path && a.body == b.body && a.headers.map { $0.0 + ":" + $0.1 } == b.headers.map { $0.0 + ":" + $0.1 }
  }

  public func header(_ name: String) -> String? { headers.first { $0.0.lowercased() == name.lowercased() }?.1 }

  public var json: JSONValue {
    var kv: [(String, JSONValue)] = [("method", .string(method)), ("path", .string(path))]
    if let body { kv.append(("body", body)) }
    if !headers.isEmpty { kv.append(("headers", .object(headers.map { ($0.0, .string($0.1)) }))) }
    return .object(kv)
  }
}

public enum VaultNotice: Sendable, Equatable {
  case serverEditWon(id: String)
  case restoredAsNew(id: String, originalId: String)
  case droppedLocalEdits(count: Int)

  public var json: JSONValue {
    switch self {
    case let .serverEditWon(id): .obj([("kind", .string("server-edit-won")), ("id", .string(id))])
    case let .restoredAsNew(id, o): .obj([("kind", .string("restored-as-new")), ("id", .string(id)), ("originalId", .string(o))])
    case let .droppedLocalEdits(n): .obj([("kind", .string("dropped-local-edits")), ("count", .int(n))])
    }
  }
}

/// Device-local settings and bookkeeping (`local.json`, never synced).
struct LocalState: Equatable {
  var deviceId: String
  var deviceName: String
  var signPub: String
  var adminPub: String
  var biometricsEnabled = false
  var autoLockSec = 60
  var clipboardClearSec: Int? = 60
  var showUsernameBeforeAuth = true
  var pcSessionMaxSec = 3600
  var lastExportAt: String?
  var seenNonces: [(String, Double)] = []
  var pendingRotation: Keyset?
  var rollbackDetected = false
  var allowDowngrade = false
  var revoked = false

  static func == (a: LocalState, b: LocalState) -> Bool { a.json == b.json }

  var json: JSONValue {
    .obj([
      ("v", .int(1)), ("deviceId", .string(deviceId)), ("deviceName", .string(deviceName)), ("signPub", .string(signPub)),
      ("adminPub", .string(adminPub)), ("biometricsEnabled", .bool(biometricsEnabled)), ("autoLockSec", .int(autoLockSec)),
      ("clipboardClearSec", clipboardClearSec.map(JSONValue.int) ?? .null), ("showUsernameBeforeAuth", .bool(showUsernameBeforeAuth)),
      ("pcSessionMaxSec", .int(pcSessionMaxSec)), ("lastExportAt", .str(lastExportAt)),
      ("seenNonces", .object(seenNonces.map { ($0.0, .number($0.1)) })), ("pendingRotation", pendingRotation?.json ?? .null),
      ("rollbackDetected", .bool(rollbackDetected)), ("allowDowngrade", .bool(allowDowngrade)), ("revoked", .bool(revoked)),
    ])
  }

  init(deviceId: String, deviceName: String, signPub: String, adminPub: String) {
    self.deviceId = deviceId; self.deviceName = deviceName; self.signPub = signPub; self.adminPub = adminPub
  }

  init?(json j: JSONValue) {
    guard j["v"]?.intValue == 1, let d = j["deviceId"]?.stringValue, let n = j["deviceName"]?.stringValue,
      let s = j["signPub"]?.stringValue, let a = j["adminPub"]?.stringValue
    else { return nil }
    self.init(deviceId: d, deviceName: n, signPub: s, adminPub: a)
    biometricsEnabled = j["biometricsEnabled"]?.boolValue ?? false
    autoLockSec = j["autoLockSec"]?.intValue ?? 60
    clipboardClearSec = j["clipboardClearSec"]?.intValue
    showUsernameBeforeAuth = j["showUsernameBeforeAuth"]?.boolValue ?? true
    pcSessionMaxSec = j["pcSessionMaxSec"]?.intValue ?? 3600
    lastExportAt = j["lastExportAt"]?.stringValue
    seenNonces = (j["seenNonces"]?.objectValue ?? []).compactMap { k, v in v.doubleValue.map { (k, $0) } }
    pendingRotation = j["pendingRotation"].flatMap { try? Keyset(json: $0) }
    rollbackDetected = j["rollbackDetected"]?.boolValue ?? false
    allowDowngrade = j["allowDowngrade"]?.boolValue ?? false
    revoked = j["revoked"]?.boolValue ?? false
  }
}

struct Session {
  var vk: Bytes
  var plains = OrderedMap<RecordPlain>()
  var usage: [String: (lastUsedAt: String, count: Int)] = [:]
}

enum Staged {
  case keyset(Keyset, newSk: Bytes?)
  case rotation(keyset: Keyset, verifier: String, newVk: Bytes, expectedRev: Int, records: [RotationRecord])
}

struct PendingAccount {
  var file: VaultFile
  var local: LocalState
  var vk: Bytes
  var sk: Bytes
  var signPriv: Bytes
  var adminPriv: Bytes
}

public actor VaultEngine {
  let d: EngineDeps
  var file: VaultFile?
  var recs = OrderedMap<VaultFileRecord>()
  var local: LocalState?
  var loaded = false
  var fatalCorrupt = false
  var recovered = false
  var session: Session?
  var pendingAccount: PendingAccount?
  var pendingRestore: (accountId: String, deviceId: String, signPriv: Bytes, adminPriv: Bytes, signPub: String, adminPub: String)?
  var restoreAccountId: String?
  var staged: Staged?
  var inflight: [String: String] = [:]
  var resyncSeen: Set<String>?
  var unlockFails: [String: Int] = [:]
  var notices: [VaultNotice] = []
  var backgroundedAt: Double?
  var lastState: String?
  var listener: (@Sendable (String, JSONValue) -> Void)?

  public init(_ deps: EngineDeps) { d = deps }

  /// Event sink: `onLockStateChange`, `onVaultChanged`, `onSyncNeeded`, `onNotice`.
  public func setListener(_ fn: (@Sendable (String, JSONValue) -> Void)?) { listener = fn }

  // MARK: - internals

  var now: Date { d.clock.now() }
  var nowIso: String { ISODate.string(now) }
  var nowMs: Double { (now.timeIntervalSince1970 * 1000).rounded(.down) }

  func emit(_ name: String, _ payload: JSONValue = .obj([])) { listener?(name, payload) }

  func emitLockState() async {
    let s = getLockState()
    if s != lastState {
      lastState = s
      emit("onLockStateChange", .obj([("state", .string(s))]))
    }
  }

  func ensureLoaded() {
    if loaded { return }
    let lres = Store.readWithRecovery(d.storage, "local.json") { b in (try? JSONValue.parse(b)).flatMap(LocalState.init(json:)) }
    let fres = Store.readWithRecovery(d.storage, "vault.lv") { b in (try? JSONValue.parse(b)).flatMap { try? VaultFile(json: $0) } }
    if let f = fres.loaded, let l = lres.loaded {
      file = f.value
      local = l.value
      recovered = f.source != .main
      recs = OrderedMap(f.value.records.map { ($0.id, $0) })
      if recovered { try? persistFile() }
    } else if fres.anyFilePresent || lres.anyFilePresent {
      fatalCorrupt = true
    }
    loaded = true
    lastState = nil
  }

  func persistFile() throws {
    guard var f = file else { return }
    f.records = recs.values
    file = f
    do { try Store.writeAtomic(d.storage, "vault.lv", f.json.utf8()) } catch { throw VaultCoreError(.io, "write failed") }
  }

  func persistLocal() throws {
    guard let l = local else { return }
    do { try Store.writeAtomic(d.storage, "local.json", l.json.utf8()) } catch { throw VaultCoreError(.io, "write failed") }
  }

  func acct() throws -> (file: VaultFile, local: LocalState) {
    guard let f = file, let l = local else {
      if fatalCorrupt { throw VaultCoreError(.corrupted) }
      throw VaultCoreError(.notFound, "no account on this device")
    }
    return (f, l)
  }

  @discardableResult
  func sess() throws -> Session {
    guard let s = session else { throw VaultCoreError(.locked) }
    return s
  }

  @discardableResult
  func unlocked() throws -> (file: VaultFile, local: LocalState, session: Session) {
    let a = try acct()
    return (a.file, a.local, try sess())
  }

  func newId() throws -> String { try UUIDBytes.v4(fromRandom: d.crypto.randomBytes(16)) }

  func loginOf(_ id: String) throws -> (plain: RecordPlain, data: LoginData) {
    guard let p = try sess().plains[id], let l = p.login else { throw VaultCoreError(.notFound) }
    return (p, l)
  }

  func devices() throws -> [DeviceData] { try sess().plains.values.compactMap(\.device) }

  func meta() -> (plain: RecordPlain, data: MetaData)? {
    guard let p = session?.plains[metaRecordId], let m = p.meta else { return nil }
    return (p, m)
  }

  /// Encrypts `plain` for record `id` and stores it as a local (dirty) revision.
  func putLocal(_ id: String, _ plain: RecordPlain) throws {
    let (f, _) = try acct()
    let s = try sess()
    let enc = try Records.encrypt(d.crypto, vk: s.vk, locator: RecordLocator(accountId: f.accountId, recordId: id, vkVersion: f.keyset.vkVersion), record: plain)
    let ex = recs[id]
    recs[id] = VaultFileRecord(
      id: id, rev: ex?.rev ?? 0, vkVersion: f.keyset.vkVersion, deleted: false, nonce: enc.nonce, ct: enc.ct, dirty: true,
      baseRev: ex.map { $0.dirty ? $0.baseRev : $0.rev } ?? 0)
    session!.plains[id] = plain
  }

  func putTombstone(_ id: String) throws {
    _ = try sess()
    let ex = recs[id]
    session!.plains[id] = nil
    guard let ex else { return }
    if ex.rev == 0 && ex.baseRev == 0 {
      recs[id] = nil  // never reached the server
      return
    }
    let (f, _) = try acct()
    recs[id] = VaultFileRecord(
      id: id, rev: ex.rev, vkVersion: f.keyset.vkVersion, deleted: true, nonce: nil, ct: nil, dirty: true,
      baseRev: ex.dirty ? ex.baseRev : ex.rev)
  }

  func save() throws {
    try persistFile()
    emit("onVaultChanged")
    emit("onSyncNeeded")
  }

  /// After applying server results: ask for another sync only while local changes remain.
  func saveSynced() throws {
    try persistFile()
    emit("onVaultChanged")
    if recs.values.contains(where: \.dirty) { emit("onSyncNeeded") }
  }

  func auth(_ reason: String) async throws -> AuthToken { try await d.biometric.authenticate(reason: reason) }

  func signer(_ slot: KeystoreSlot, auth: AuthToken? = nil) async throws -> Signer {
    guard let priv = try await d.keystore.read(slot, auth: auth) else {
      throw VaultCoreError(.notFound, slot == .adminKey ? "admin key missing" : "device key missing")
    }
    let c = d.crypto
    return { try c.ecdsaSign(privateKey: priv, message: $0) }
  }

  /// A request with the `X-LV-Admin` header (§8.7). The body is signed as its exact serialization.
  func adminRequest(_ method: String, _ path: String, body: JSONValue? = nil, auth token: AuthToken? = nil, headers: [(String, String)] = []) async throws -> ServerRequest {
    let (_, l) = try acct()
    let t: AuthToken
    if let token { t = token } else { t = try await auth("管理操作") }
    let sign = try await signer(.adminKey, auth: t)
    let header = try Signing.buildAdminHeader(
      d.crypto, sign: sign, method: method, path: path, body: body?.utf8(), deviceId: l.deviceId, nowSec: Int(now.timeIntervalSince1970))
    return ServerRequest(method: method, path: path, body: body, headers: [("X-LV-Admin", header)] + headers)
  }

  // MARK: throttle (FR-12, G15)

  func readThrottle() async -> (failedCount: Int, lastFailureAtMs: Double?) {
    guard let raw = try? await d.keystore.read(.throttle, auth: nil), let j = try? JSONValue.parse(raw) else { return (0, nil) }
    return (j["failedCount"]?.intValue ?? 0, j["lastFailureAtMs"]?.doubleValue)
  }

  func writeThrottle(_ failed: Int, _ last: Double?) async throws {
    try await d.keystore.write(.throttle, JSONValue.obj([("failedCount", .int(failed)), ("lastFailureAtMs", last.map(JSONValue.number) ?? .null)]).utf8())
  }

  public func getThrottleState() async -> (failedCount: Int, retryAfterSec: Int) {
    let t = await readThrottle()
    return Throttle.state(failedCount: t.failedCount, lastFailureAtMs: t.lastFailureAtMs, nowMs: nowMs)
  }

  /// Derives the master keys and unwraps the VK of `keyset`; nil when the password is wrong.
  func tryUnwrap(_ password: String, _ keyset: Keyset) async throws -> (vk: Bytes, authKey: Bytes, sk: Bytes)? {
    let (f, _) = try acct()
    guard let sk = try await d.keystore.read(.sk, auth: nil) else { throw VaultCoreError(.corrupted, "recovery key missing on this device") }
    var keys = try Keys.deriveMasterKeys(d.crypto, masterPassword: password, kdf: keyset.kdf, recoveryKey: sk, accountId: f.accountId)
    defer { wipe(&keys.kek) }
    do {
      let vk = try Keys.unwrapVaultKey(d.crypto, kek: keys.kek, wrapped: keyset.wrappedVK, accountId: f.accountId, keysetVersion: keyset.keysetVersion)
      return (vk, keys.authKey, sk)
    } catch is CryptoError {
      return nil
    }
  }

  /// Counted and throttled master-password check shared by every password-taking method.
  func verifyPassword(_ password: String, _ keyset: Keyset? = nil) async throws -> (vk: Bytes, authKey: Bytes, sk: Bytes) {
    let (f, _) = try acct()
    let t = await getThrottleState()
    if t.retryAfterSec > 0 { throw VaultCoreError(.throttled, "too many attempts", details: .init(retryAfterSec: t.retryAfterSec)) }
    if let r = try await tryUnwrap(password, keyset ?? f.keyset) {
      if t.failedCount > 0 { try await writeThrottle(0, nil) }
      return r
    }
    let failed = t.failedCount + 1
    let ms = nowMs
    try await writeThrottle(failed, ms)
    let after = Throttle.state(failedCount: failed, lastFailureAtMs: ms, nowMs: ms)
    throw VaultCoreError(.wrongPassword, "wrong master password", details: .init(retryAfterSec: after.retryAfterSec, attemptsLeft: Throttle.attemptsBeforeThrottle(failed)))
  }

  // MARK: opening a session

  func decryptAll(_ f: VaultFile, _ vk: Bytes) throws -> OrderedMap<RecordPlain> {
    var out = OrderedMap<RecordPlain>()
    for r in f.records where !r.deleted {
      out[r.id] = try Records.decrypt(
        d.crypto, vk: vk, locator: RecordLocator(accountId: f.accountId, recordId: r.id, vkVersion: r.vkVersion),
        payload: EncryptedPayload(nonce: r.nonce!, ct: r.ct!))
    }
    return out
  }

  func usageAad(_ accountId: String) -> Bytes { Array("lv|v2|usage|\(accountId)".utf8) }

  func loadUsage(_ vk: Bytes) -> [String: (lastUsedAt: String, count: Int)] {
    guard let f = file, let raw = try? d.storage.read("usage.lv"), raw.count >= 29,
      let pt = try? d.crypto.aesGcmDecrypt(key: vk, nonce: Array(raw[0..<12]), ciphertextAndTag: Array(raw[12...]), aad: usageAad(f.accountId)),
      let j = try? JSONValue.parse(pt), let o = j.objectValue
    else { return [:] }
    var out: [String: (lastUsedAt: String, count: Int)] = [:]
    for (k, v) in o {
      if let at = v["lastUsedAt"]?.stringValue { out[k] = (at, v["count"]?.intValue ?? 0) }
    }
    return out
  }

  func saveUsage() throws {
    let (f, _) = try acct()
    let s = try sess()
    let j = JSONValue.object(s.usage.sorted { $0.key < $1.key }.map { ($0.key, .obj([("lastUsedAt", .string($0.value.lastUsedAt)), ("count", .int($0.value.count))])) })
    let nonce = try d.crypto.randomBytes(12)
    let ct = try d.crypto.aesGcmEncrypt(key: s.vk, nonce: nonce, plaintext: j.utf8(), aad: usageAad(f.accountId))
    try Store.writeAtomic(d.storage, "usage.lv", nonce + ct)
  }

  /// Decrypts everything; on damage falls back to the .bak generation, else E_CORRUPTED (AC-12).
  func open(_ vk: Bytes) async throws {
    let (f, _) = try acct()
    var plains: OrderedMap<RecordPlain>
    do {
      plains = try decryptAll(f, vk)
    } catch {
      guard let raw = try? d.storage.read("vault.lv.bak"), let j = try? JSONValue.parse(raw), let cand = try? VaultFile(json: j), cand.accountId == f.accountId
      else { throw VaultCoreError(.corrupted, "vault file is damaged") }
      do { plains = try decryptAll(cand, vk) } catch { throw VaultCoreError(.corrupted, "vault file and its backup are damaged") }
      file = cand
      recs = OrderedMap(cand.records.map { ($0.id, $0) })
      recovered = true
      try persistFile()
    }
    session = Session(vk: vk, plains: plains)
    session!.usage = loadUsage(vk)
    await emitLockState()
    _ = try await purgeExpiredTrash()
  }

  // MARK: - state and unlocking

  public func getLockState() -> String {
    ensureLoaded()
    if pendingAccount != nil && file == nil { return "uninitialized" }
    if file == nil && !fatalCorrupt { return "uninitialized" }
    return session != nil ? "unlocked" : "locked"
  }

  public func getBiometricAvailability() async -> (available: Bool, kind: BiometricKind) { await d.biometric.availability() }

  public func enableBiometrics() async throws {
    _ = try acct()
    let s = try sess()
    let a = await d.biometric.availability()
    if !a.available { throw VaultCoreError(.biometryUnavailable) }
    _ = try await auth("生体認証を有効にする")
    try await d.keystore.write(.vkBio, s.vk)
    local!.biometricsEnabled = true
    try persistLocal()
  }

  public func disableBiometrics() async throws {
    _ = try acct()
    try await d.keystore.delete(.vkBio)
    local!.biometricsEnabled = false
    try persistLocal()
  }

  public func unlockWithBiometrics() async throws {
    ensureLoaded()
    let (_, l) = try acct()
    if fatalCorrupt { throw VaultCoreError(.corrupted) }
    if !l.biometricsEnabled { throw VaultCoreError(.biometryUnavailable) }
    let token = try await auth("ロックを解除")
    guard let vk = try await d.keystore.read(.vkBio, auth: token) else { throw VaultCoreError(.biometryInvalidated) }
    try await open(vk)
  }

  public func unlockWithPassword(_ masterPassword: String) async throws {
    ensureLoaded()
    if fatalCorrupt { throw VaultCoreError(.corrupted) }
    let (f, l) = try acct()
    if let pending = l.pendingRotation {
      let next = try await verifyPassword(masterPassword, pending)
      var oldVk = session?.vk
      if oldVk == nil { oldVk = try await tryUnwrap(masterPassword, f.keyset)?.vk }
      try await applyRotation(next.vk, oldVk, pending)
      return
    }
    let r = try await verifyPassword(masterPassword)
    if session != nil {
      session!.vk = r.vk
      await emitLockState()
      return
    }
    try await open(r.vk)
  }

  /// Another device rotated the VK: re-key local edits, drop stale clean copies, refetch (§7.7).
  func applyRotation(_ newVk: Bytes, _ oldVk: Bytes?, _ ks: Keyset) async throws {
    let (f, l) = try acct()
    var dropped = 0
    var kept = OrderedMap<VaultFileRecord>()
    for r in recs.values where r.dirty {
      if r.deleted {
        var x = r
        x.vkVersion = ks.vkVersion
        kept[r.id] = x
        continue
      }
      guard let oldVk else { dropped += 1; continue }
      let plain = try Records.decrypt(
        d.crypto, vk: oldVk, locator: RecordLocator(accountId: f.accountId, recordId: r.id, vkVersion: r.vkVersion),
        payload: EncryptedPayload(nonce: r.nonce!, ct: r.ct!))
      let enc = try Records.encrypt(d.crypto, vk: newVk, locator: RecordLocator(accountId: f.accountId, recordId: r.id, vkVersion: ks.vkVersion), record: plain)
      var x = r
      x.vkVersion = ks.vkVersion
      x.nonce = enc.nonce
      x.ct = enc.ct
      kept[r.id] = x
    }
    if dropped > 0 { notify(.droppedLocalEdits(count: dropped)) }
    recs = kept
    file!.keyset = ks
    file!.sync.cursor = 0
    local!.pendingRotation = nil
    session = nil
    try persistFile()
    if l.biometricsEnabled { try await d.keystore.write(.vkBio, newVk) }
    try persistLocal()
    try await open(newVk)
    emit("onVaultChanged")
    emit("onSyncNeeded")
  }

  public func lock() async {
    if session != nil {
      wipe(&session!.vk)
      session = nil
    }
    await emitLockState()
  }

  public func onBackground() { backgroundedAt = nowMs }

  public func onForeground() async {
    let at = backgroundedAt
    backgroundedAt = nil
    guard session != nil, let l = local, let at else { return }
    if nowMs - at >= Double(l.autoLockSec * 1000) { await lock() }
  }

  public func drainNotices() -> [VaultNotice] {
    defer { notices = [] }
    return notices
  }

  func notify(_ n: VaultNotice) {
    notices.append(n)
    emit("onNotice", .obj([("notice", n.json)]))
  }

  public func getStorageStatus() -> (recoveredFromBackup: Bool, corrupted: Bool) {
    ensureLoaded()
    return (recovered, fatalCorrupt)
  }

  public func markRevoked() async throws {
    _ = try acct()
    local!.revoked = true
    try persistLocal()
    await lock()
  }

  public func isRotationPending() -> Bool {
    ensureLoaded()
    return local?.pendingRotation != nil
  }

  func serverUrl(_ url: String) throws -> String {
    switch ServerUrl.parse(url, allowInsecureLocalhost: d.allowInsecureLocalhost) {
    case let .success(o): return o
    case let .failure(r): throw VaultCoreError(.invalidInput, "invalid server url (\(r.rawValue))")
    }
  }

  var defaultDeviceName: String { d.deviceName ?? (d.platform == "ios" ? "iPhone" : "Android") }
}
