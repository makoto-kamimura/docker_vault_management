// Ports of vault-engine/test/sync.test.ts and devices.test.ts (values are evaluated before
// asserting: async autoclosures make the type checker very slow).
import XCTest

@testable import VaultKit

final class EngineSyncTests: XCTestCase {
  /// Two phones on one account (A created it, B restored with the recovery key).
  func two() async throws -> (s: FakeServer, a: Phone, b: Phone, rk: String) {
    let s = FakeServer()
    let a = Phone()
    let rk = try await setup(s, a)
    let b = Phone(clock: a.clock)
    try await restoreOn(s, b, rk)
    try await syncOnce(a.e, s)
    return (s, a, b, rk)
  }

  func ids(_ list: [JSONValue]) -> [String] { list.compactMap { $0["id"]?.s } }
  func titles(_ list: [JSONValue]) -> [String] { list.compactMap { $0["title"]?.s } }
  func pending(_ e: VaultEngine) async throws -> Int { try await e.getSyncState()["pendingCount"]!.intValue! }

  func testPushPullRestore() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("Shared"))["id"]!.s!
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    let got = try await b.e.getItem(x)
    XCTAssertEqual(got["title"]?.s, "Shared")
    let pw = try await b.e.revealPassword(x)
    XCTAssertEqual(pw, "Shared-pass")
    let devs = try await a.e.listDevices()
    XCTAssertEqual(devs.filter { $0["revokedAt"]!.isNull }.count, 2)
  }

  func testConflictCopy() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("Doc"))["id"]!.s!
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    _ = try await a.e.saveItem(item("Doc", id: x, notes: "from A"))
    _ = try await b.e.saveItem(item("Doc", id: x, notes: "from B"))
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    try await syncOnce(a.e, s)
    for p in [a, b] {
      let list = try await p.e.listItems()
      XCTAssertEqual(list.count, 2)
      let copy = list.first { $0["isConflictCopy"]?.boolValue == true }
      XCTAssertTrue(copy?["title"]?.s?.hasPrefix("Doc（競合コピー ") ?? false)
      let orig = try await p.e.getItem(x)
      XCTAssertEqual(orig["notes"]?.s, "from A")
      let c = try await p.e.getItem(copy!["id"]!.s!)
      XCTAssertEqual(c["conflictOf"]?.s, x)
    }
    let copyId = try await b.e.listItems().first { $0["isConflictCopy"]?.boolValue == true }!["id"]!.s!
    try await b.e.resolveConflict(copyId: copyId, keep: "copy")
    let after = try await b.e.listItems()
    XCTAssertEqual(after.map { $0["isConflictCopy"]?.boolValue }, [false])
  }

  func testSyncNeededOnlyWhileLocalChangesRemain() async throws {
    let (s, a, _, _) = try await two()
    let box = EventBox()
    await a.e.setListener { name, _ in if name == "onSyncNeeded" { box.add(name) } }
    try await syncOnce(a.e, s)
    XCTAssertEqual(box.items.count, 0)
    _ = try await a.e.saveItem(item("Local"))
    XCTAssertEqual(box.items.count, 1)
    try await syncOnce(a.e, s)
    XCTAssertEqual(box.items.count, 1)
  }

  func testIdenticalEditsNoCopy() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("Same"))["id"]!.s!
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    _ = try await a.e.saveItem(item("Same", id: x, notes: "n"))
    _ = try await b.e.saveItem(item("Same", id: x, notes: "n"))
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    let list = try await b.e.listItems()
    XCTAssertEqual(list.count, 1)
  }

  func testServerDeletedLocalEditedRestoredAsNew() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("Victim"))["id"]!.s!
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    try await a.e.purgeItem(x)
    try await syncOnce(a.e, s)
    _ = try await b.e.saveItem(item("Victim", id: x, notes: "edited offline"))
    try await syncOnce(b.e, s)
    let list = try await b.e.listItems()
    XCTAssertEqual(list.count, 1)
    XCTAssertNotEqual(list[0]["id"]?.s, x)
    let notices = await b.e.drainNotices()
    XCTAssertEqual(notices, [.restoredAsNew(id: list[0]["id"]!.s!, originalId: x)])
    try await syncOnce(a.e, s)
    let aList = try await a.e.listItems()
    XCTAssertEqual(aList.count, 1)
  }

  func testLocalDeletedServerEditedServerWins() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("Both"))["id"]!.s!
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    _ = try await a.e.saveItem(item("Both", id: x, notes: "server edit"))
    try await syncOnce(a.e, s)
    try await b.e.purgeItem(x)
    try await syncOnce(b.e, s)
    let got = try await b.e.getItem(x)
    XCTAssertEqual(got["notes"]?.s, "server edit")
    let notices = await b.e.drainNotices()
    XCTAssertEqual(notices, [.serverEditWon(id: x)])
  }

  func testTombstonesAndOfflineEdits() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("Gone"))["id"]!.s!
    let y = try await a.e.saveItem(item("Stay"))["id"]!.s!
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    try await a.e.purgeItem(x)
    _ = try await b.e.saveItem(item("Stay", id: y, notes: "offline edit"))
    try await syncOnce(a.e, s)
    let p = try await pending(b.e)
    XCTAssertGreaterThan(p, 0)
    try await syncOnce(b.e, s)
    try await syncOnce(a.e, s)
    let got = try await a.e.getItem(y)
    XCTAssertEqual(got["notes"]?.s, "offline edit")
    let list = try await b.e.listItems()
    XCTAssertEqual(titles(list), ["Stay"])
  }

  func testFailedPushAndInflightEdit() async throws {
    let (s, a, _, _) = try await two()
    let x = try await a.e.saveItem(item("Race"))["id"]!.s!
    _ = try await a.e.getPendingChanges(100)  // response lost
    var p = try await pending(a.e)
    XCTAssertGreaterThan(p, 0)
    let changes = try await a.e.getPendingChanges(100)
    _ = try await a.e.saveItem(item("Race", id: x, notes: "second"))
    _ = try await a.e.applyPushResults(try s.push(changes))
    p = try await pending(a.e)
    XCTAssertEqual(p, 1)
    try await syncOnce(a.e, s)
    p = try await pending(a.e)
    XCTAssertEqual(p, 0)
  }

  func testFullResync() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("Purged"))["id"]!.s!
    _ = try await a.e.saveItem(item("Alive"))
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    let local = try await b.e.saveItem(item("Local only"))["id"]!.s!
    try await a.e.purgeItem(x)
    try await syncOnce(a.e, s)
    s.records[x] = nil
    s.minValid = s.recordRev
    let needs = try await syncOnce(b.e, s)
    XCTAssertFalse(needs)
    let list = try await b.e.listItems()
    XCTAssertEqual(titles(list).sorted(), ["Alive", "Local only"])
    await assertThrowsCode(.notFound) { try await b.e.getItem(x) }
    XCTAssertNotNil(s.records[local])
  }

  func testRollbackDetection() async throws {
    let (s, a, _, _) = try await two()
    _ = try await a.e.saveItem(item("R1"))
    try await syncOnce(a.e, s)
    let maxSeen = try await a.e.getSyncState()["maxSeenRev"]!.intValue!
    s.tamperPull = { $0.cursor = maxSeen - 2; $0.records = [] }
    await assertThrowsCode(.rollbackDetected) { try await syncOnce(a.e, s) }
    s.tamperPull = nil
    await assertThrowsCode(.rollbackDetected) { try await a.e.getPendingChanges(10) }
    let list = try await a.e.listItems()
    XCTAssertTrue(titles(list).contains("R1"))
    try await a.e.acceptServerState()
    try await syncOnce(a.e, s)
    let after = try await a.e.getSyncState()["maxSeenRev"]!.intValue!
    XCTAssertEqual(after, s.recordRev)
  }

  func testKeysetGoingBackwardsIsRollback() async throws {
    let (s, a, _, _) = try await two()
    let old = s.keyset!
    let req = try await a.e.changeMasterPassword(current: PW, next: "new master password 1")
    s.setKeyset(try Keyset(json: req.body!["keyset"]!))
    try await a.e.confirmKeysetAccepted()
    s.tamperPull = { $0.keyset = old }
    await assertThrowsCode(.rollbackDetected) { try await syncOnce(a.e, s) }
  }

  func testSwappedCiphertextsRejected() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("X"))["id"]!.s!
    let y = try await a.e.saveItem(item("Y"))["id"]!.s!
    try await syncOnce(a.e, s)
    let rx = s.records[x]!, ry = s.records[y]!
    s.tamperPull = { res in
      res.records = res.records.map { r in
        if r.id == x { var t = ry; t.id = r.id; t.rev = r.rev; return t }
        if r.id == y { var t = rx; t.id = r.id; t.rev = r.rev; return t }
        return r
      }
    }
    await assertThrowsCode(.corrupted) { try await syncOnce(b.e, s) }
    let list = try await b.e.listItems()
    XCTAssertEqual(list.count, 0)
  }

  func testPasswordChangeAndRecoveryKeyReissuePropagate() async throws {
    let (s, a, b, _) = try await two()
    let req = try await a.e.changeMasterPassword(current: PW, next: "second master password")
    XCTAssertNotNil(req.header("X-LV-Admin"))
    s.setKeyset(try Keyset(json: req.body!["keyset"]!))
    try await a.e.confirmKeysetAccepted()
    try await syncOnce(b.e, s)
    await b.e.lock()
    await assertThrowsCode(.wrongPassword) { try await b.e.unlockWithPassword(PW) }
    try await b.e.unlockWithPassword("second master password")

    let re = try await a.e.regenerateRecoveryKey(masterPassword: "second master password")
    s.setKeyset(try Keyset(json: re.request.body!["keyset"]!))
    try await a.e.confirmKeysetAccepted()
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    let rk = try await b.e.getRecoveryKey()
    XCTAssertEqual(rk, re.recoveryKey)
    await b.e.lock()
    try await b.e.unlockWithPassword("second master password")
  }

  func testResetPasswordNeedsTheRightRecoveryKey() async throws {
    let (_, a, _, rk) = try await two()
    await assertThrowsCode(.invalidRecoveryKey) { try await a.e.resetMasterPassword(recoveryKey: "LV2-0000-0000-0000-0000-0000-0000-0000", next: "another password 1") }
    let req = try await a.e.resetMasterPassword(recoveryKey: rk, next: "another password 1")
    XCTAssertEqual(req.body?["keyset"]?["keysetVersion"]?.intValue, 2)
  }

  func testRotationByAnotherDevice() async throws {
    let (s, a, b, _) = try await two()
    let x = try await a.e.saveItem(item("Rot"))["id"]!.s!
    try await syncOnce(a.e, s)
    try await syncOnce(b.e, s)
    let bDev = try await a.e.listDevices().first { $0["isThisDevice"]?.boolValue == false }!["deviceId"]!.s!
    await assertThrowsCode(.needsMasterPassword) { try await a.e.revokeDevice(bDev, rotateKey: true, masterPassword: nil) }

    let reqs = try await a.e.revokeDevice(bDev, rotateKey: true, masterPassword: PW)
    XCTAssertEqual(reqs.map(\.path), ["/v1/devices/\(bDev)", "/v1/rotations"])
    let more = try await a.e.continueRotation("11111111-1111-4111-8111-111111111111")
    let staged = more.dropLast().flatMap { r in
      r.body!["records"]!.arrayValue!.map { j in
        RotationRecord(id: j["id"]!.s!, deleted: j["deleted"]!.boolValue!, nonce: j["nonce"]?.s, ct: j["ct"]?.s)
      }
    }
    let commit = try Keyset(json: more.last!.body!["keyset"]!)
    let cursor = s.rotate(staged, commit)
    try await a.e.confirmRotation(cursor: cursor)
    try await syncOnce(a.e, s)
    let ga = try await a.e.getItem(x)
    XCTAssertEqual(ga["title"]?.s, "Rot")

    let needs = try await syncOnce(b.e, s)
    XCTAssertTrue(needs)
    let pendingRot = await b.e.isRotationPending()
    XCTAssertTrue(pendingRot)
    let none = try await b.e.getPendingChanges(10)
    XCTAssertTrue(none.isEmpty)
    try await b.e.unlockWithPassword(PW)
    try await syncOnce(b.e, s)
    let pw = try await b.e.revealPassword(x)
    XCTAssertEqual(pw, "Rot-pass")
    let devs = try await b.e.listDevices()
    XCTAssertFalse(devs.first { $0["deviceId"]?.s == bDev }!["revokedAt"]!.isNull)
  }

  func testRestartKeepsDirtyState() async throws {
    let (s, a, _, _) = try await two()
    let x = try await a.e.saveItem(item("Persist"))["id"]!.s!
    a.restart()
    try await a.e.unlockWithPassword(PW)
    let p = try await pending(a.e)
    XCTAssertGreaterThan(p, 0)
    try await syncOnce(a.e, s)
    XCTAssertNotNil(s.records[x])
  }

  func testRestoreWithWrongCredentials() async throws {
    let s = FakeServer()
    let a = Phone()
    let rk = try await setup(s, a)
    let b = Phone()
    let authKey = try await b.e.deriveAuthKey(accountId: s.accountId, kdf: s.keyset.kdf, masterPassword: "wrong password 1", recoveryKey: rk)
    _ = try await b.e.buildRecoverRequest(accountName: s.accountName, authKey: authKey)
    await assertThrowsCode(.wrongCredentials) {
      try await b.e.restoreAccount(
        serverUrl: "https://vault.test", accountName: s.accountName, accountId: s.accountId, keyset: s.keyset.json,
        masterPassword: "wrong password 1", recoveryKey: rk)
    }
  }

  // MARK: devices / PC approval (devices.test.ts)

  /// A browser extension's keys, as the pairing flow would deliver them.
  struct PC {
    let c = SystemCrypto()
    let sign: KeyPair
    let eph: KeyPair
    let deviceId: String
    init() throws {
      sign = try c.generateKeyPair()
      eph = try c.generateKeyPair()
      deviceId = try UUIDBytes.v4(fromRandom: c.randomBytes(16))
    }
  }

  func pair(_ a: Phone, _ s: FakeServer) async throws -> PC {
    let pc = try PC()
    let pairingId = try UUIDBytes.v4(fromRandom: pc.c.randomBytes(16))
    let signPub = Base64Url.encode(pc.sign.publicKey), ephPub = Base64Url.encode(pc.eph.publicKey)
    let fp = try Signing.pairingFingerprint(pc.c, signPub: signPub, ephPub: ephPub)
    let qr = "lvpair:v1?s=\(Base64Url.encode(Array("https://vault.test".utf8)))&p=\(pairingId)&f=\(fp)"
    let parsed = try await a.e.parsePairingQr(qr)
    XCTAssertEqual(parsed["fingerprint"]?.s, fp)
    let req = try await a.e.approvePairing(
      pairing: .obj([("pairingId", .string(pairingId)), ("deviceId", .string(pc.deviceId)), ("platform", .string("chrome")), ("signPub", .string(signPub)), ("ephPub", .string(ephPub))]),
      fingerprint: fp, name: "My PC")
    XCTAssertEqual(req.path, "/v1/pairings/\(pairingId)/approve")
    // The PC opens the sealed VK with its ephemeral key.
    let env = try SealEnvelope(json: req.body!["response"]!)
    let m = try Seal.open(pc.c, recipientPrivateKey: pc.eph.privateKey, ctx: Strings.sealContextPair(pairingId), envelope: env)
    XCTAssertEqual(m.sessionMaxSec, 3600)
    // The admin signature verifies over the exact body bytes JS will send.
    let adminPub = try await a.e.getDeviceRegistration()["adminPub"]!.s!
    let v = Signing.verifyAdminHeader(pc.c, adminPublicKey: adminPub, method: req.method, path: req.path, body: req.body!.utf8(), headerValue: req.header("X-LV-Admin")!)
    if case .ok = v {} else { XCTFail("admin header: \(v)") }
    try await syncOnce(a.e, s)
    return pc
  }

  func unlockRequest(_ pc: PC, accountId: String, issuedAt: Date, code: String = "42", nonce: Bytes? = nil) throws -> JSONValue {
    let requestNonce = Base64Url.encode(try nonce ?? pc.c.randomBytes(16))
    let ephPub = Base64Url.encode(try pc.c.generateKeyPair().publicKey)
    let iso = ISODate.secondsString(issuedAt)
    let sig = try Signing.signUnlockRequest(
      sign: { try pc.c.ecdsaSign(privateKey: pc.sign.privateKey, message: $0) },
      fields: .init(accountId: accountId, deviceId: pc.deviceId, requestNonce: requestNonce, ephPub: ephPub, code: code, issuedAt: iso))
    return .obj([
      ("requestId", .string(try UUIDBytes.v4(fromRandom: pc.c.randomBytes(16)))), ("deviceId", .string(pc.deviceId)),
      ("expiresAt", .string(iso)),
      ("payload", .obj([("requestNonce", .string(requestNonce)), ("ephPub", .string(ephPub)), ("code", .string(code)), ("issuedAt", .string(iso)), ("sig", .string(sig))])),
    ])
  }

  func testPairingApprovalAndUnlockApproval() async throws {
    let (s, a, _, _) = try await two()
    let pc = try await pair(a, s)
    let devs = try await a.e.listDevices()
    XCTAssertTrue(devs.contains { $0["deviceId"]?.s == pc.deviceId && $0["type"]?.s == "extension" })

    let req = try unlockRequest(pc, accountId: s.accountId, issuedAt: a.clock.now())
    let v = try await a.e.verifyUnlockRequest(req)
    XCTAssertEqual(v, .ok(deviceName: "My PC"))
    // AC-23: wrong codes count down, then the request is burnt
    await assertThrowsCode(.codeMismatch) { try await a.e.approveUnlock(request: req, typedCode: "11") }
    let ok = try await a.e.approveUnlock(request: req, typedCode: "42")
    XCTAssertEqual(ok.path, "/v1/unlock-requests/\(req["requestId"]!.s!)/approve")
    // replay of the same nonce
    let replay = try await a.e.verifyUnlockRequest(req)
    XCTAssertEqual(replay, .failed(.replayed))

    let burn = try unlockRequest(pc, accountId: s.accountId, issuedAt: a.clock.now())
    for _ in 0..<3 { await assertThrowsCode(.codeMismatch) { try await a.e.approveUnlock(request: burn, typedCode: "10") } }
    await assertThrowsCode(.codeMismatch) { try await a.e.approveUnlock(request: burn, typedCode: "42") }

    // stale, forged, unknown
    let old = try unlockRequest(pc, accountId: s.accountId, issuedAt: a.clock.now().addingTimeInterval(-600))
    let stale = try await a.e.verifyUnlockRequest(old)
    XCTAssertEqual(stale, .failed(.stale))
    var forged = try unlockRequest(pc, accountId: s.accountId, issuedAt: a.clock.now())
    forged = forged.setting("payload", forged["payload"]!.setting("code", .string("43")))
    let bad = try await a.e.verifyUnlockRequest(forged)
    XCTAssertEqual(bad, .failed(.badSignature))
    let stranger = try unlockRequest(try PC(), accountId: s.accountId, issuedAt: a.clock.now())
    let unknown = try await a.e.verifyUnlockRequest(stranger)
    XCTAssertEqual(unknown, .failed(.unknownDevice))

    // biometric cancel leaves the request unapproved
    let fresh = try unlockRequest(pc, accountId: s.accountId, issuedAt: a.clock.now())
    a.bio.script("cancel")
    await assertThrowsCode(.authCanceled) { try await a.e.approveUnlock(request: fresh, typedCode: "42") }
    let still = try await a.e.verifyUnlockRequest(fresh)
    XCTAssertEqual(still, .ok(deviceName: "My PC"))

    // revoked PC
    _ = try await a.e.revokeDevice(pc.deviceId, rotateKey: false, masterPassword: nil)
    let rv = try await a.e.verifyUnlockRequest(fresh)
    XCTAssertEqual(rv, .failed(.revoked))
  }

  func testPairingMismatches() async throws {
    let (_, a, _, _) = try await two()
    let pc = try PC()
    let other = try PC()
    let signPub = Base64Url.encode(pc.sign.publicKey), ephPub = Base64Url.encode(pc.eph.publicKey)
    let fp = try Signing.pairingFingerprint(pc.c, signPub: signPub, ephPub: ephPub)
    await assertThrowsCode(.fingerprintMismatch) {
      try await a.e.approvePairing(
        pairing: .obj([("pairingId", .string(pc.deviceId)), ("deviceId", .string(pc.deviceId)), ("platform", .string("chrome")), ("signPub", .string(Base64Url.encode(other.sign.publicKey))), ("ephPub", .string(ephPub))]),
        fingerprint: fp, name: "PC")
    }
    let qr = "lvpair:v1?s=\(Base64Url.encode(Array("https://other.test".utf8)))&p=\(pc.deviceId)&f=\(fp)"
    await assertThrowsCode(.serverMismatch) { try await a.e.parsePairingQr(qr) }
    await assertThrowsCode(.invalidInput) { try await a.e.parsePairingQr("lvpair:v1?s=x") }
  }

  // MARK: recovery code (§8.11)

  func testRecoveryCodeClaimOnNewPhone() async throws {
    let (s, a, _, _) = try await two()
    _ = try await a.e.saveItem(item("Kept"))
    try await syncOnce(a.e, s)
    let issued = try await a.e.issueRecoveryCode(waitSec: 86_400)
    XCTAssertEqual(issued.request.path, "/v1/recovery-code")
    // AC-42: the RC is stored nowhere on the issuing device
    let rc = try RecoveryCode.parse(SystemCrypto(), issued.text)
    let rcB64 = Array(Base64Url.encode(rc).utf8)
    for (_, v) in a.storage.files { XCTAssertNil(v.firstRange(of: rcB64)) }
    for (_, v) in a.keystore.slots { XCTAssertNotEqual(v.value, rc) }

    let reg = issued.request.body!
    let c = Phone(clock: a.clock)
    let start = try await c.e.startRecoveryClaim(.obj([("qr", .string(issued.qr))]))
    XCTAssertEqual(start.body?["rcId"]?.s, reg["rcId"]?.s)
    try await c.e.rememberRecoveryClaim(claimId: "22222222-2222-4222-8222-222222222222", claimToken: Base64Url.encode(Bytes(repeating: 7, count: 32)), availableAt: "2026-11-20T00:00:00.000Z")
    let pend = try await c.e.getPendingRecoveryClaim()
    XCTAssertEqual(pend["claimId"]?.s, "22222222-2222-4222-8222-222222222222")
    let complete = try await c.e.buildCompleteRecoveryClaim()
    XCTAssertTrue(complete.header("Authorization")?.hasPrefix("Claim ") ?? false)
    try await c.e.completeRecoveryClaim(.obj([
      ("accessToken", .string("t")), ("accountName", .string(s.accountName)), ("keyset", s.keyset.json),
      ("wrappedVK", reg["wrappedVK"]!), ("vkVersion", reg["vkVersion"]!),
    ]))
    XCTAssertNil(c.keystore.slots[.claim])
    try await syncOnce(c.e, s)
    let list = try await c.e.listItems()
    XCTAssertEqual(titles(list), ["Kept"])
    let req = try await c.e.setMasterPasswordAfterCodeRecovery("brand new password 1")
    XCTAssertEqual(req.path, "/v1/keyset")
    // builders
    let cancel = try await a.e.buildCancelRecoveryClaim("22222222-2222-4222-8222-222222222222")
    XCTAssertEqual(cancel.path, "/v1/recovery-claims/22222222-2222-4222-8222-222222222222/cancel")
    await assertThrowsCode(.invalidRecoveryCode) { try await c.e.startRecoveryClaim(.obj([("qr", .string("lvrc:v1?s=x"))])) }
  }

  func testAdminKeyReregistration() async throws {
    let (_, a, _, _) = try await two()
    let before = try await a.e.getDeviceRegistration()["adminPub"]!.s!
    let req = try await a.e.reregisterAdminKey(masterPassword: PW)
    XCTAssertEqual(req.path, "/v1/devices/self/admin-key")
    XCTAssertNotNil(req.header("X-LV-AuthKey"))
    let after = try await a.e.getDeviceRegistration()["adminPub"]!.s!
    XCTAssertNotEqual(before, after)
    XCTAssertEqual(req.body?["adminPub"]?.s, after)
  }
}
