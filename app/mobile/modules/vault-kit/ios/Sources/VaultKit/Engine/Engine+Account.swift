// Account lifecycle: create / restore / keyset changes / sign-out (engine.ts "account").
import Foundation

extension VaultEngine {
  func deviceRegistrationJson(_ deviceId: String, _ signPub: String, _ adminPub: String) -> JSONValue {
    .obj([("deviceId", .string(deviceId)), ("type", .string("mobile")), ("platform", .string(d.platform)), ("signPub", .string(signPub)), ("adminPub", .string(adminPub))])
  }

  func deviceRecord(_ deviceId: String, name: String, signPub: String, adminPub: String, via: String, now: String) -> RecordPlain {
    RecordPlain(
      data: .device(DeviceData(
        deviceId: deviceId, name: name, type: "mobile", platform: d.platform, signPub: signPub, adminPub: adminPub, addedAt: now,
        addedBy: deviceId, addedVia: via, revokedAt: nil)),
      updatedAt: now, updatedBy: deviceId)
  }

  func freshRecord(_ id: String, accountId: String, vk: Bytes, vkVersion: Int, plain: RecordPlain) throws -> VaultFileRecord {
    let enc = try Records.encrypt(d.crypto, vk: vk, locator: RecordLocator(accountId: accountId, recordId: id, vkVersion: vkVersion), record: plain)
    return VaultFileRecord(id: id, rev: 0, vkVersion: vkVersion, deleted: false, nonce: enc.nonce, ct: enc.ct, dirty: true, baseRev: 0)
  }

  public func createAccount(serverUrl url: String, accountName: String, masterPassword: String, inviteCode: String) async throws -> (request: ServerRequest, recoveryKey: String) {
    ensureLoaded()
    if file != nil { throw VaultCoreError(.invalidInput, "an account already exists") }
    guard case let .success(name) = AccountName.normalize(accountName) else { throw VaultCoreError(.invalidInput, "invalid account name") }
    if masterPassword.utf16.count < Field.masterPasswordMin { throw VaultCoreError(.invalidInput, "master password too short") }
    let origin = try serverUrl(url)
    let c = d.crypto
    let accountId = try newId()
    let deviceId = try newId()
    let sk = try RecoveryKey.generate(c)
    var bundle = try Keys.createKeyset(c, masterPassword: masterPassword, recoveryKey: sk, accountId: accountId)
    let sign = try c.generateKeyPair()
    let admin = try c.generateKeyPair()
    let now = nowIso
    let rk = try RecoveryKey.format(c, sk)
    let signPub = Base64Url.encode(sign.publicKey)
    let adminPub = Base64Url.encode(admin.publicKey)
    let meta = RecordPlain(data: .meta(MetaData(recoveryKey: rk, pcSessionMaxSec: 3600, createdAt: now)), updatedAt: now, updatedBy: deviceId)
    let device = deviceRecord(deviceId, name: defaultDeviceName, signPub: signPub, adminPub: adminPub, via: "setup", now: now)
    let records = [
      try freshRecord(metaRecordId, accountId: accountId, vk: bundle.vk, vkVersion: 1, plain: meta),
      try freshRecord(deviceId, accountId: accountId, vk: bundle.vk, vkVersion: 1, plain: device),
    ]
    let f = VaultFile(
      accountId: accountId, accountName: name, serverUrl: origin, keyset: bundle.keyset, records: records,
      sync: VaultSyncState(cursor: 0, maxSeenRev: 0, lastSyncedAt: nil))
    pendingAccount = PendingAccount(
      file: f, local: LocalState(deviceId: deviceId, deviceName: defaultDeviceName, signPub: signPub, adminPub: adminPub),
      vk: bundle.vk, sk: sk, signPriv: sign.privateKey, adminPriv: admin.privateKey)
    let request = ServerRequest(
      method: "POST", path: "/v1/accounts",
      body: .obj([
        ("inviteCode", .string(inviteCode)), ("accountId", .string(accountId)), ("accountName", .string(name)),
        ("keyset", bundle.keyset.json), ("verifier", .string(bundle.verifier)),
        ("device", deviceRegistrationJson(deviceId, signPub, adminPub)),
      ]))
    wipe(&bundle.authKey)
    wipe(&bundle.kek)
    return (request, rk)
  }

  /// Installs a brand-new account state and opens the session.
  func install(_ a: PendingAccount, sk: Bytes?) async throws {
    file = a.file
    local = a.local
    recs = OrderedMap(a.file.records.map { ($0.id, $0) })
    fatalCorrupt = false
    recovered = false
    if let sk { try await d.keystore.write(.sk, sk) }
    try await d.keystore.write(.signKey, a.signPriv)
    try await d.keystore.write(.adminKey, a.adminPriv)
    try persistFile()
    try persistLocal()
    session = Session(vk: a.vk, plains: try decryptAll(a.file, a.vk))
    await emitLockState()
  }

  public func commitAccount() async throws {
    guard let p = pendingAccount else { throw VaultCoreError(.notFound, "no pending account") }
    pendingAccount = nil
    try await install(p, sk: p.sk)
  }

  public func discardPendingAccount() {
    if pendingAccount != nil {
      wipe(&pendingAccount!.vk)
      wipe(&pendingAccount!.sk)
    }
    pendingAccount = nil
  }

  public func deriveAuthKey(accountId: String, kdf: Kdf, masterPassword: String, recoveryKey: String) throws -> String {
    var sk = try RecoveryKey.parse(d.crypto, recoveryKey)
    var keys = try Keys.deriveMasterKeys(d.crypto, masterPassword: masterPassword, kdf: kdf, recoveryKey: sk, accountId: accountId)
    restoreAccountId = accountId
    defer { wipe(&keys.kek); wipe(&sk) }
    return Base64Url.encode(keys.authKey)
  }

  public func buildRecoverRequest(accountName: String, authKey: String) throws -> ServerRequest {
    guard let accountId = restoreAccountId else { throw VaultCoreError(.invalidInput, "call deriveAuthKey first") }
    let sign = try d.crypto.generateKeyPair()
    let admin = try d.crypto.generateKeyPair()
    let deviceId = try newId()
    let signPub = Base64Url.encode(sign.publicKey), adminPub = Base64Url.encode(admin.publicKey)
    pendingRestore = (accountId, deviceId, sign.privateKey, admin.privateKey, signPub, adminPub)
    return ServerRequest(
      method: "POST", path: "/v1/auth/recover",
      body: .obj([("accountId", .string(accountId)), ("authKey", .string(authKey)), ("device", deviceRegistrationJson(deviceId, signPub, adminPub))]))
  }

  public func restoreAccount(serverUrl url: String, accountName: String, accountId: String, keyset: JSONValue, masterPassword: String, recoveryKey: String) async throws {
    guard let r = pendingRestore, r.accountId == accountId else { throw VaultCoreError(.invalidInput, "no recover request in progress") }
    let sk = try RecoveryKey.parse(d.crypto, recoveryKey)
    let ks: Keyset
    do { ks = try Keyset(json: keyset) } catch { throw VaultCoreError(.invalidInput, "bad keyset") }
    var keys = try Keys.deriveMasterKeys(d.crypto, masterPassword: masterPassword, kdf: ks.kdf, recoveryKey: sk, accountId: accountId)
    defer { wipe(&keys.kek); wipe(&keys.authKey) }
    let vk: Bytes
    do {
      vk = try Keys.unwrapVaultKey(d.crypto, kek: keys.kek, wrapped: ks.wrappedVK, accountId: accountId, keysetVersion: ks.keysetVersion)
    } catch is CryptoError {
      throw VaultCoreError(.wrongCredentials)
    }
    guard case let .success(name) = AccountName.normalize(accountName) else { throw VaultCoreError(.invalidInput, "invalid account name") }
    let now = nowIso
    let device = deviceRecord(r.deviceId, name: defaultDeviceName, signPub: r.signPub, adminPub: r.adminPub, via: "recovery-key", now: now)
    let f = VaultFile(
      accountId: accountId, accountName: name, serverUrl: try serverUrl(url), keyset: ks,
      records: [try freshRecord(r.deviceId, accountId: accountId, vk: vk, vkVersion: ks.vkVersion, plain: device)],
      sync: VaultSyncState(cursor: 0, maxSeenRev: 0, lastSyncedAt: nil))
    pendingRestore = nil
    restoreAccountId = nil
    try await install(
      PendingAccount(
        file: f, local: LocalState(deviceId: r.deviceId, deviceName: defaultDeviceName, signPub: r.signPub, adminPub: r.adminPub),
        vk: vk, sk: sk, signPriv: r.signPriv, adminPriv: r.adminPriv), sk: sk)
  }

  public func signAuthChallenge(_ challenge: String) async throws -> (deviceId: String, sig: String) {
    ensureLoaded()
    let (_, l) = try acct()
    let sign = try await signer(.signKey)
    return (l.deviceId, try Signing.signAuthChallenge(sign: sign, deviceId: l.deviceId, challenge: challenge))
  }

  public func getRecoveryKey() async throws -> String {
    try sess()
    _ = try await auth("リカバリーキーを表示")
    guard let sk = try await d.keystore.read(.sk, auth: nil) else { throw VaultCoreError(.notFound) }
    return try RecoveryKey.format(d.crypto, sk)
  }

  public func changeMasterPassword(current: String, next: String) async throws -> ServerRequest {
    let (f, _, _) = try unlocked()
    if next.utf16.count < Field.masterPasswordMin { throw VaultCoreError(.invalidInput, "master password too short") }
    let r = try await verifyPassword(current)
    return try await stageKeyset(f, next, r.sk, r.vk, nil)
  }

  public func resetMasterPassword(recoveryKey: String, next: String) async throws -> ServerRequest {
    let (f, _, s) = try unlocked()
    if next.utf16.count < Field.masterPasswordMin { throw VaultCoreError(.invalidInput, "master password too short") }
    let sk = try RecoveryKey.parse(d.crypto, recoveryKey)
    let stored = try await d.keystore.read(.sk, auth: nil)
    let metaKey = meta()?.data.recoveryKey
    let formatted = try RecoveryKey.format(d.crypto, sk)
    let ok = (stored.map { constantTimeEqual($0, sk) } ?? false) || (metaKey != nil && metaKey == formatted)
    guard ok else { throw VaultCoreError(.invalidRecoveryKey, "recovery key does not match") }
    return try await stageKeyset(f, next, sk, s.vk, nil)
  }

  public func regenerateRecoveryKey(masterPassword: String) async throws -> (request: ServerRequest, recoveryKey: String) {
    let (f, _, _) = try unlocked()
    let r = try await verifyPassword(masterPassword)
    let newSk = try RecoveryKey.generate(d.crypto)
    let request = try await stageKeyset(f, masterPassword, newSk, r.vk, newSk)
    return (request, try RecoveryKey.format(d.crypto, newSk))
  }

  func stageKeyset(_ f: VaultFile, _ password: String, _ sk: Bytes, _ vk: Bytes, _ newSk: Bytes?) async throws -> ServerRequest {
    var b = try Keys.rewrapKeyset(d.crypto, masterPassword: password, recoveryKey: sk, accountId: f.accountId, vk: vk, previous: f.keyset)
    staged = .keyset(b.keyset, newSk: newSk)
    wipe(&b.authKey)
    wipe(&b.kek)
    return try await adminRequest("PUT", "/v1/keyset", body: .obj([("keyset", b.keyset.json), ("verifier", .string(b.verifier))]))
  }

  public func confirmKeysetAccepted() async throws {
    guard case let .keyset(ks, newSk) = staged else { throw VaultCoreError(.notFound, "no pending keyset") }
    _ = try acct()
    staged = nil
    file!.keyset = ks
    if let newSk {
      try await d.keystore.write(.sk, newSk)
      if let m = meta() {
        var data = m.data
        data.recoveryKey = try RecoveryKey.format(d.crypto, newSk)
        try putLocal(metaRecordId, RecordPlain(data: .meta(data), updatedAt: nowIso, updatedBy: local?.deviceId ?? m.plain.updatedBy))
      }
    }
    try save()
  }

  public func reregisterAdminKey(masterPassword: String) async throws -> ServerRequest {
    _ = try acct()
    let r = try await verifyPassword(masterPassword)
    let admin = try d.crypto.generateKeyPair()
    try await d.keystore.write(.adminKey, admin.privateKey)
    local!.adminPub = Base64Url.encode(admin.publicKey)
    try persistLocal()
    let l = local!
    if let dev = session?.plains[l.deviceId], var dd = dev.device {
      dd.adminPub = l.adminPub
      try putLocal(l.deviceId, RecordPlain(data: .device(dd), updatedAt: nowIso, updatedBy: l.deviceId))
      try save()
    }
    return ServerRequest(
      method: "PUT", path: "/v1/devices/self/admin-key", body: .obj([("adminPub", .string(l.adminPub))]),
      headers: [("X-LV-AuthKey", Base64Url.encode(r.authKey))])
  }

  public func buildDeleteAccount(masterPassword: String) async throws -> ServerRequest {
    let r = try await verifyPassword(masterPassword)
    return try await adminRequest("DELETE", "/v1/account", headers: [("X-LV-AuthKey", Base64Url.encode(r.authKey))])
  }

  public func wipeLocal() async throws {
    ensureLoaded()
    if session != nil { wipe(&session!.vk) }
    session = nil
    for n in ["vault.lv", "local.json", "usage.lv"] { try Store.removeAll(d.storage, n) }
    for s in KeystoreSlot.allCases { try await d.keystore.delete(s) }
    file = nil
    local = nil
    recs = OrderedMap()
    staged = nil
    pendingAccount = nil
    pendingRestore = nil
    fatalCorrupt = false
    notices = []
    await emitLockState()
  }

  public func getAccountInfo() throws -> JSONValue {
    ensureLoaded()
    let (f, l) = try acct()
    return .obj([("accountId", .string(f.accountId)), ("accountName", .string(f.accountName)), ("serverUrl", .string(f.serverUrl)), ("deviceId", .string(l.deviceId))])
  }

  public func changeServerUrl(_ newUrl: String) throws {
    _ = try acct()
    file!.serverUrl = try serverUrl(newUrl)
    try persistFile()
  }

  public func buildSignOutDevice() async throws -> [ServerRequest] {
    let (_, l, _) = try unlocked()
    let token = try await auth("この端末からサインアウト")
    try markDeviceRevoked(l.deviceId)
    try save()
    var out: [ServerRequest] = []
    if let b = batchRequest(100) { out.append(b) }
    out.append(try await adminRequest("DELETE", "/v1/devices/\(l.deviceId)", auth: token))
    return out
  }

  public func isLastApprover() throws -> Bool {
    try unlocked()
    return try devices().filter { $0.type == "mobile" && $0.revokedAt == nil }.count <= 1
  }

  func markDeviceRevoked(_ deviceId: String) throws {
    guard let dev = try sess().plains[deviceId], var dd = dev.device else { throw VaultCoreError(.notFound, "unknown device") }
    if dd.revokedAt != nil { return }
    let (_, l) = try acct()
    dd.revokedAt = nowIso
    try putLocal(deviceId, RecordPlain(data: .device(dd), updatedAt: nowIso, updatedBy: l.deviceId))
  }

  func batchRequest(_ limit: Int) -> ServerRequest? {
    let changes = collectPending(limit)
    if changes.isEmpty { return nil }
    return ServerRequest(method: "POST", path: "/v1/records/batch", body: .obj([("changes", .array(changes.map(\.json)))]))
  }

  public func getDeviceRegistration() throws -> JSONValue {
    ensureLoaded()
    let (_, l) = try acct()
    return .obj([("deviceId", .string(l.deviceId)), ("platform", .string(d.platform)), ("signPub", .string(l.signPub)), ("adminPub", .string(l.adminPub))])
  }
}
