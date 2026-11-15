// Devices, PC pairing / unlock approval, revocation and key rotation (engine.ts "devices").
import Foundation

extension VaultEngine {
  public func listDevices() throws -> [JSONValue] {
    let (_, l, _) = try unlocked()
    return try devices().map {
      .obj([
        ("deviceId", .string($0.deviceId)), ("name", .string($0.name)), ("type", .string($0.type)), ("platform", .string($0.platform)),
        ("addedAt", .string($0.addedAt)), ("addedVia", .string($0.addedVia)), ("revokedAt", .str($0.revokedAt)),
        ("isThisDevice", .bool($0.deviceId == l.deviceId)),
      ])
    }
  }

  public func renameDevice(_ deviceId: String, name: String) throws {
    let (_, l, _) = try unlocked()
    let n = name.utf16.count
    guard n >= Field.deviceNameMin, n <= Field.deviceNameMax else { throw VaultCoreError(.invalidInput, "device name length") }
    guard let dev = try sess().plains[deviceId], var dd = dev.device else { throw VaultCoreError(.notFound) }
    dd.name = name
    try putLocal(deviceId, RecordPlain(data: .device(dd), updatedAt: nowIso, updatedBy: l.deviceId))
    if deviceId == l.deviceId {
      local!.deviceName = name
      try persistLocal()
    }
    try save()
  }

  public func parsePairingQr(_ qr: String) throws -> JSONValue {
    let (f, _) = try acct()
    let q: (serverOrigin: String, pairingId: String, fingerprint: String)
    do { q = try QrCodec.parsePair(qr, insecure: d.allowInsecureLocalhost) } catch is QrParseError {
      throw VaultCoreError(.invalidInput, "malformed pairing QR")
    }
    guard q.serverOrigin == f.serverUrl else { throw VaultCoreError(.serverMismatch, "QR belongs to a different server") }
    return .obj([("pairingId", .string(q.pairingId)), ("serverOrigin", .string(q.serverOrigin)), ("fingerprint", .string(q.fingerprint))])
  }

  /// `pairing`: { pairingId, deviceId, platform, signPub, ephPub }.
  public func approvePairing(pairing: JSONValue, fingerprint: String, name: String) async throws -> ServerRequest {
    let (f, l, s) = try unlocked()
    guard let pairingId = pairing["pairingId"]?.stringValue, let deviceId = pairing["deviceId"]?.stringValue,
      let platform = pairing["platform"]?.stringValue, let signPub = pairing["signPub"]?.stringValue,
      let ephPub = pairing["ephPub"]?.stringValue
    else { throw VaultCoreError(.invalidInput, "malformed pairing") }
    guard try Signing.verifyPairingFingerprint(d.crypto, signPub: signPub, ephPub: ephPub, expected: fingerprint) else {
      throw VaultCoreError(.fingerprintMismatch, "QR and server public keys differ")
    }
    guard ["chrome", "edge", "brave"].contains(platform) else { throw VaultCoreError(.invalidInput, "unsupported platform") }
    let n = name.utf16.count
    guard n >= Field.deviceNameMin, n <= Field.deviceNameMax else { throw VaultCoreError(.invalidInput, "device name length") }
    let token = try await auth("PC を登録")
    let now = nowIso
    try putLocal(
      deviceId,
      RecordPlain(
        data: .device(DeviceData(
          deviceId: deviceId, name: name, type: "extension", platform: platform, signPub: signPub, adminPub: nil, addedAt: now,
          addedBy: l.deviceId, addedVia: "pairing", revokedAt: nil)),
        updatedAt: now, updatedBy: l.deviceId))
    let env = try Seal.seal(
      d.crypto, recipientPub: try Base64Url.decode(ephPub), ctx: Strings.sealContextPair(pairingId),
      message: SealPlaintext(
        vk: Base64Url.encode(s.vk), vkVersion: f.keyset.vkVersion, sessionMaxSec: meta()?.data.pcSessionMaxSec ?? l.pcSessionMaxSec,
        issuedAt: now))
    try save()
    return try await adminRequest("POST", "/v1/pairings/\(pairingId)/approve", body: .obj([("response", env.json)]), auth: token)
  }

  func nonceSeen(_ nonce: String) -> Bool {
    guard let at = local?.seenNonces.first(where: { $0.0 == nonce })?.1 else { return false }
    return nowMs - at < Double(TTLSec.unlockNonceMemory) * 1000
  }

  public func rememberUnlockNonce(_ nonce: String) throws {
    _ = try acct()
    let t = nowMs
    local!.seenNonces.removeAll { t - $0.1 >= Double(TTLSec.unlockNonceMemory) * 1000 || $0.0 == nonce }
    local!.seenNonces.append((nonce, t))
    try persistLocal()
  }

  /// `req`: { requestId, deviceId, expiresAt, payload: { requestNonce, ephPub, code, issuedAt, sig } }.
  public func verifyUnlockRequest(_ req: JSONValue) throws -> UnlockVerifyResult {
    let (f, _, _) = try unlocked()
    let p = req["payload"]
    let r = UnlockRequestToVerify(
      deviceId: req["deviceId"]?.stringValue ?? "", requestNonce: p?["requestNonce"]?.stringValue ?? "", ephPub: p?["ephPub"]?.stringValue ?? "",
      code: p?["code"]?.stringValue ?? "", issuedAt: p?["issuedAt"]?.stringValue ?? "", sig: p?["sig"]?.stringValue ?? "")
    let trust = try devices()
    return Signing.verifyUnlockRequest(d.crypto, accountId: f.accountId, request: r, trust: trust, now: now) { [self] in nonceSeen($0) }
  }

  public func approveUnlock(request: JSONValue, typedCode: String) async throws -> ServerRequest {
    let (f, l, s) = try unlocked()
    let v = try verifyUnlockRequest(request)
    if case let .failed(reason) = v { throw VaultCoreError(.untrustedDevice, reason.rawValue) }
    guard let id = request["requestId"]?.stringValue, let payload = request["payload"], let code = payload["code"]?.stringValue,
      let ephPub = payload["ephPub"]?.stringValue, let requestNonce = payload["requestNonce"]?.stringValue
    else { throw VaultCoreError(.invalidInput, "malformed unlock request") }
    let failed = unlockFails[id] ?? 0
    if failed >= Limits.unlockCodeMaxAttempts { throw VaultCoreError(.codeMismatch, "too many wrong codes", details: .init(attemptsLeft: 0)) }
    if case let .wrong(left, _) = Signing.evaluateCodeAttempt(typedCode: typedCode, signedCode: code, failedAttempts: failed) {
      unlockFails[id] = failed + 1
      throw VaultCoreError(.codeMismatch, "wrong code", details: .init(attemptsLeft: left))
    }
    _ = try await auth("PC の解錠を承認")
    let env = try Seal.seal(
      d.crypto, recipientPub: try Base64Url.decode(ephPub), ctx: Strings.sealContextUnlock(id),
      message: SealPlaintext(
        vk: Base64Url.encode(s.vk), vkVersion: f.keyset.vkVersion, sessionMaxSec: meta()?.data.pcSessionMaxSec ?? l.pcSessionMaxSec,
        issuedAt: nowIso))
    try rememberUnlockNonce(requestNonce)
    return ServerRequest(method: "POST", path: "/v1/unlock-requests/\(id)/approve", body: .obj([("response", env.json)]))
  }

  public func revokeDevice(_ deviceId: String, rotateKey: Bool, masterPassword: String?) async throws -> [ServerRequest] {
    let (f, _, _) = try unlocked()
    let token = try await auth("端末を解除")
    let c = d.crypto
    var pw: (vk: Bytes, authKey: Bytes, sk: Bytes)?
    if rotateKey {
      guard let mp = masterPassword else { throw VaultCoreError(.needsMasterPassword, "rotation needs the master password") }
      pw = try await verifyPassword(mp)
    }
    try markDeviceRevoked(deviceId)
    let del = try await adminRequest("DELETE", "/v1/devices/\(deviceId)", auth: token)
    guard rotateKey, let pw, let mp = masterPassword else {
      try save()
      if let b = batchRequest(100) { return [b, del] }
      return [del]
    }
    let newVk = try c.randomBytes(32)
    let newVkVersion = f.keyset.vkVersion + 1
    var bundle = try Keys.createKeyset(
      c, masterPassword: mp, recoveryKey: pw.sk, accountId: f.accountId, vk: newVk, keysetVersion: f.keyset.keysetVersion + 1, vkVersion: newVkVersion)
    var records: [RotationRecord] = []
    for r in recs.values {
      guard !r.deleted, let plain = session?.plains[r.id] else {
        records.append(RotationRecord(id: r.id, deleted: true, nonce: nil, ct: nil))
        continue
      }
      let enc = try Records.encrypt(c, vk: newVk, locator: RecordLocator(accountId: f.accountId, recordId: r.id, vkVersion: newVkVersion), record: plain)
      records.append(RotationRecord(id: r.id, deleted: false, nonce: enc.nonce, ct: enc.ct))
    }
    let expectedRev = file!.sync.cursor
    staged = .rotation(keyset: bundle.keyset, verifier: bundle.verifier, newVk: newVk, expectedRev: expectedRev, records: records)
    wipe(&bundle.authKey)
    wipe(&bundle.kek)
    try persistFile()
    let start = try await adminRequest("POST", "/v1/rotations", body: .obj([("expectedRev", .int(expectedRev)), ("newVkVersion", .int(newVkVersion))]), auth: token)
    return [del, start]
  }

  public func continueRotation(_ rotationId: String) async throws -> [ServerRequest] {
    guard case let .rotation(keyset, verifier, _, _, records) = staged else { throw VaultCoreError(.notFound, "no rotation in progress") }
    var out: [ServerRequest] = []
    for i in stride(from: 0, to: records.count, by: 100) {
      out.append(ServerRequest(
        method: "PUT", path: "/v1/rotations/\(rotationId)/records",
        body: .obj([("records", .array(records[i..<min(i + 100, records.count)].map(\.json)))])))
    }
    out.append(try await adminRequest(
      "POST", "/v1/rotations/\(rotationId)/commit",
      body: .obj([("keyset", keyset.json), ("verifier", .string(verifier)), ("recordCount", .int(records.count))])))
    return out
  }

  public func abortRotation(_ rotationId: String) -> ServerRequest {
    staged = nil
    return ServerRequest(method: "DELETE", path: "/v1/rotations/\(rotationId)")
  }

  public func confirmRotation(cursor: Int) async throws {
    guard case let .rotation(keyset, _, newVk, _, records) = staged else { throw VaultCoreError(.notFound, "no rotation in progress") }
    let (_, l) = try acct()
    staged = nil
    var next = OrderedMap<VaultFileRecord>()
    for x in records {
      let rev = recs[x.id]?.rev ?? 0
      let gone = x.deleted || x.nonce == nil || x.ct == nil
      next[x.id] = VaultFileRecord(
        id: x.id, rev: rev, vkVersion: keyset.vkVersion, deleted: gone, nonce: gone ? nil : x.nonce, ct: gone ? nil : x.ct, dirty: false, baseRev: rev)
    }
    recs = next
    file!.keyset = keyset
    try sess()
    session!.vk = newVk
    // The server renumbered every record: refetch everything (fullResync) to learn the new revs.
    file!.sync.cursor = 0
    file!.sync.maxSeenRev = max(file!.sync.maxSeenRev, cursor)
    if l.biometricsEnabled { try await d.keystore.write(.vkBio, newVk) }
    try save()
  }

  // MARK: trusted browsers / autofill (Android only, iOS extension later)

  public func listTrustedBrowsers() -> [JSONValue] { [] }

  public func getAutofillStatus() -> JSONValue {
    .obj([("supported", .bool(false)), ("enabled", .bool(false)), ("textInsertionSupported", .bool(false))])
  }

  // MARK: recovery code (§8.11)

  public func issueRecoveryCode(waitSec: Int) async throws -> (request: ServerRequest, qr: String, text: String) {
    let (f, _, s) = try unlocked()
    let token = try await auth("復旧コードを発行")
    var rc = try RecoveryCode.generate(d.crypto)
    defer { wipe(&rc) }
    let reg = try RecoveryCode.createRegistration(d.crypto, rc: rc, accountId: f.accountId, vk: s.vk, vkVersion: f.keyset.vkVersion)
    let request = try await adminRequest(
      "PUT", "/v1/recovery-code",
      body: .obj([
        ("rcId", .string(reg.rcId)), ("verifier", .string(reg.verifier)), ("wrappedVK", reg.wrappedVK.json),
        ("vkVersion", .int(reg.vkVersion)), ("waitSec", .int(waitSec)),
      ]), auth: token)
    let qr: String
    do { qr = try QrCodec.formatRc(serverUrl: f.serverUrl, accountId: f.accountId, rc: Base64Url.encode(rc), insecure: d.allowInsecureLocalhost) } catch {
      throw VaultCoreError(.invalidInput, "server url cannot be encoded")
    }
    return (request, qr, try RecoveryCode.format(d.crypto, rc))
  }

  public func buildSetRecoveryWait(_ waitSec: Int) async throws -> ServerRequest {
    _ = try acct()
    return try await adminRequest("PUT", "/v1/recovery-code/wait-period", body: .obj([("waitSec", .int(waitSec))]))
  }

  public func buildRevokeRecoveryCode() async throws -> ServerRequest {
    _ = try acct()
    return try await adminRequest("DELETE", "/v1/recovery-code")
  }

  public func buildCancelRecoveryClaim(_ claimId: String) async throws -> ServerRequest {
    _ = try acct()
    return try await adminRequest("POST", "/v1/recovery-claims/\(claimId)/cancel", body: .obj([]))
  }

  public func buildApproveRecoveryClaimNow(_ claimId: String) async throws -> ServerRequest {
    _ = try acct()
    return try await adminRequest("POST", "/v1/recovery-claims/\(claimId)/approve-now", body: .obj([]))
  }
}
