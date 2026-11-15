// Recovery-code claims on a new device (§8.11.4) and backup / import (§6.5, F1).
import Foundation

extension VaultEngine {
  // MARK: claims (the slot holds the RC and this device's new keys until the claim completes)

  func readClaim() async throws -> JSONValue? {
    guard let raw = try await d.keystore.read(.claim, auth: nil) else { return nil }
    return try? JSONValue.parse(raw)
  }

  func writeClaim(_ c: JSONValue) async throws { try await d.keystore.write(.claim, c.utf8()) }

  /// `input`: { qr } or { serverUrl, accountId, text }.
  public func startRecoveryClaim(_ input: JSONValue) async throws -> ServerRequest {
    ensureLoaded()
    let c = d.crypto
    var rc: Bytes
    let origin: String, accountId: String
    if let qr = input["qr"]?.stringValue {
      guard let q = try? QrCodec.parseRc(qr, insecure: d.allowInsecureLocalhost) else { throw VaultCoreError(.invalidRecoveryCode) }
      rc = try Base64Url.decode(q.rc)
      origin = q.serverUrl
      accountId = q.accountId
    } else {
      rc = try RecoveryCode.parse(c, input["text"]?.stringValue ?? "")
      origin = try serverUrl(input["serverUrl"]?.stringValue ?? "")
      accountId = input["accountId"]?.stringValue ?? ""
    }
    defer { wipe(&rc) }
    let keys = try RecoveryCode.deriveKeys(c, rc: rc, accountId: accountId)
    let sign = try c.generateKeyPair()
    let admin = try c.generateKeyPair()
    let deviceId = try newId()
    let signPub = Base64Url.encode(sign.publicKey), adminPub = Base64Url.encode(admin.publicKey)
    try await writeClaim(.obj([
      ("serverUrl", .string(origin)), ("accountId", .string(accountId)), ("rc", .string(Base64Url.encode(rc))),
      ("deviceId", .string(deviceId)), ("platform", .string(d.platform)), ("signPriv", .string(Base64Url.encode(sign.privateKey))),
      ("adminPriv", .string(Base64Url.encode(admin.privateKey))), ("signPub", .string(signPub)), ("adminPub", .string(adminPub)),
    ]))
    return ServerRequest(
      method: "POST", path: "/v1/recovery-claims",
      body: .obj([
        ("accountId", .string(accountId)), ("rcId", .string(Base64Url.encode(keys.rcId))), ("authRC", .string(Base64Url.encode(keys.authRC))),
        ("device", deviceRegistrationJson(deviceId, signPub, adminPub)),
      ]))
  }

  public func rememberRecoveryClaim(claimId: String, claimToken: String, availableAt: String) async throws {
    guard let c = try await readClaim() else { throw VaultCoreError(.notFound, "no recovery claim in progress") }
    try await writeClaim(c.setting("claimId", .string(claimId)).setting("claimToken", .string(claimToken)).setting("availableAt", .string(availableAt)))
  }

  public func getPendingRecoveryClaim() async throws -> JSONValue {
    guard let c = try await readClaim(), let id = c["claimId"]?.stringValue, let at = c["availableAt"]?.stringValue else { return .null }
    return .obj([("claimId", .string(id)), ("availableAt", .string(at)), ("serverUrl", c["serverUrl"] ?? .null)])
  }

  public func buildCompleteRecoveryClaim() async throws -> ServerRequest {
    guard let c = try await readClaim(), let id = c["claimId"]?.stringValue, let token = c["claimToken"]?.stringValue else {
      throw VaultCoreError(.notFound, "no recovery claim in progress")
    }
    return ServerRequest(method: "POST", path: "/v1/recovery-claims/\(id)/complete", body: .obj([]), headers: [("Authorization", "Claim \(token)")])
  }

  /// `response`: { accessToken, accountName, keyset, wrappedVK, vkVersion }.
  public func completeRecoveryClaim(_ response: JSONValue) async throws {
    guard let c = try await readClaim(), let rcB64 = c["rc"]?.stringValue, let accountId = c["accountId"]?.stringValue,
      let deviceId = c["deviceId"]?.stringValue, let signPub = c["signPub"]?.stringValue, let adminPub = c["adminPub"]?.stringValue,
      let signPriv = c["signPriv"]?.stringValue, let adminPriv = c["adminPriv"]?.stringValue, let origin = c["serverUrl"]?.stringValue
    else { throw VaultCoreError(.notFound, "no recovery claim in progress") }
    guard let vkVersion = response["vkVersion"]?.intValue, let wj = response["wrappedVK"], let wrapped = try? WrappedVk(json: wj) else {
      throw VaultCoreError(.corrupted, "inconsistent keyset")
    }
    let vk: Bytes
    do {
      vk = try RecoveryCode.unwrapVaultKey(d.crypto, rc: try Base64Url.decode(rcB64), accountId: accountId, wrapped: wrapped, vkVersion: vkVersion)
    } catch is CryptoError {
      throw VaultCoreError(.corrupted, "recovery code did not unwrap the key")
    }
    guard let kj = response["keyset"], let ks = try? Keyset(json: kj), ks.vkVersion == vkVersion else {
      throw VaultCoreError(.corrupted, "inconsistent keyset")
    }
    let now = nowIso
    guard case let .success(name) = AccountName.normalize(response["accountName"]?.stringValue ?? "") else {
      throw VaultCoreError(.invalidInput, "invalid account name")
    }
    let device = deviceRecord(deviceId, name: defaultDeviceName, signPub: signPub, adminPub: adminPub, via: "recovery-code", now: now)
    let f = VaultFile(
      accountId: accountId, accountName: name, serverUrl: origin, keyset: ks,
      records: [try freshRecord(deviceId, accountId: accountId, vk: vk, vkVersion: ks.vkVersion, plain: device)],
      sync: VaultSyncState(cursor: 0, maxSeenRev: 0, lastSyncedAt: nil))
    try await install(
      PendingAccount(
        file: f, local: LocalState(deviceId: deviceId, deviceName: defaultDeviceName, signPub: signPub, adminPub: adminPub), vk: vk, sk: [],
        signPriv: try Base64Url.decode(signPriv), adminPriv: try Base64Url.decode(adminPriv)), sk: nil)
    try await d.keystore.delete(.claim)  // RC and claimToken are gone
  }

  public func setMasterPasswordAfterCodeRecovery(_ next: String) async throws -> ServerRequest {
    let (f, _, s) = try unlocked()
    if next.utf16.count < Field.masterPasswordMin { throw VaultCoreError(.invalidInput, "master password too short") }
    guard let m = meta() else { throw VaultCoreError(.notFound, "pull all records first") }
    let sk = try RecoveryKey.parse(d.crypto, m.data.recoveryKey)
    try await d.keystore.write(.sk, sk)
    return try await stageKeyset(f, next, sk, s.vk, nil)
  }

  public func abandonRecoveryClaim() async throws { try await d.keystore.delete(.claim) }

  // MARK: backup

  func logins() throws -> [(id: String, plain: RecordPlain, data: LoginData)] {
    try sess().plains.entries.compactMap { id, p in p.login.map { (id, p, $0) } }
  }

  public func exportVault(_ exportPassword: String) async throws -> String {
    try unlocked()
    let items = try logins().filter { $0.data.trashedAt == nil }.map { ExportItem(id: $0.id, data: $0.data, updatedAt: $0.plain.updatedAt) }
    let f = try ExportFile.create(d.crypto, exportPassword: exportPassword, payload: ExportPayload(items: items), exportedAt: nowIso)
    let uri = try await d.files.write(suggestedName: "localvault-\(nowIso.prefix(10)).lvbackup", data: f.json.utf8())
    local!.lastExportAt = nowIso
    try persistLocal()
    return uri
  }

  public func deleteExportFile(_ uri: String) async throws { try await d.files.delete(uri: uri) }

  func readExport(_ uri: String, _ password: String) async throws -> ExportPayload {
    let json: JSONValue
    do { json = try JSONValue.parse(try await d.files.read(uri: uri)) } catch let e as VaultCoreError { throw e } catch {
      throw VaultCoreError(.importFormat, "not JSON")
    }
    return try ExportFile.open(d.crypto, exportPassword: password, file: json).payload
  }

  public func inspectImport(_ uri: String, password: String) async throws -> (itemCount: Int, conflictCount: Int) {
    try unlocked()
    let payload = try await readExport(uri, password)
    let have = Set(try logins().map(\.id))
    return (payload.items.count, payload.items.filter { have.contains($0.id) }.count)
  }

  public func importVault(_ uri: String, password: String, strategy: String) async throws -> (added: Int, updated: Int) {
    let (_, l, _) = try unlocked()
    let payload = try await readExport(uri, password)
    let now = nowIso
    var existing: [String: RecordPlain] = [:]
    for x in try logins() { existing[x.id] = x.plain }
    var added = 0, updated = 0
    if strategy == "replace" {
      let incoming = Set(payload.items.map(\.id))
      for x in try logins() where !incoming.contains(x.id) { try putTombstone(x.id) }
    }
    for it in payload.items {
      let cur = existing[it.id]
      var id = it.id
      if let cur {
        if strategy == "append" { id = try newId() } else if strategy == "newer" && !(it.updatedAt > cur.updatedAt) { continue }
      }
      var data = it.data
      data.passwordHistory = data.history
      try putLocal(id, RecordPlain(data: .login(data), updatedAt: now, updatedBy: l.deviceId))
      if id == it.id && cur != nil { updated += 1 } else { added += 1 }
    }
    try save()
    return (added, updated)
  }

  func parseCsv(_ uri: String) async throws -> (CsvImportResult, Set<Int>) {
    let text = try UTF8Bytes.decode(try await d.files.read(uri: uri))
    let res = try CsvImport.parseImport(text)
    let existing = try logins().filter { $0.data.trashedAt == nil }.map { (username: $0.data.username, urls: $0.data.urls) }
    return (res, Set(CsvImport.findDuplicates(d.psl, drafts: res.drafts, existing: existing)))
  }

  public func inspectCsvImport(_ uri: String) async throws -> JSONValue {
    try unlocked()
    let (res, dup) = try await parseCsv(uri)
    return .obj([
      ("format", .string(res.format.rawValue)), ("itemCount", .int(res.drafts.count)), ("duplicateCount", .int(dup.count)),
      ("skippedCount", .int(res.skipped.count)),
    ])
  }

  public func importCsv(_ uri: String, skipDuplicates: Bool) async throws -> (added: Int, skipped: Int) {
    let (_, l, _) = try unlocked()
    let (res, dup) = try await parseCsv(uri)
    let now = nowIso
    var added = 0
    var skipped = res.skipped.count
    for (i, dr) in res.drafts.enumerated() {
      if skipDuplicates && dup.contains(i) { skipped += 1; continue }
      let data = LoginData(
        title: dr.title, username: dr.username, password: dr.password, urls: dr.urls, androidApps: [], notes: dr.notes,
        favorite: dr.favorite, createdAt: now, trashedAt: nil, conflictOf: nil, passwordHistory: [])
      try putLocal(try newId(), RecordPlain(data: .login(data), updatedAt: now, updatedBy: l.deviceId))
      added += 1
    }
    try save()
    return (added, skipped)
  }
}
