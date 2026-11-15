// Ports of vault-engine/test/lifecycle.test.ts, items.test.ts and storage.test.ts.
import XCTest

@testable import VaultKit

final class EngineLifecycleTests: XCTestCase {
  func testTwoPhaseCreationLockUnlockRestart() async throws {
    let s = FakeServer()
    let p = Phone()
    var lockEvents: [String] = []
    let box = EventBox()
    await p.e.setListener { name, payload in if name == "onLockStateChange" { box.add(payload["state"]!.s!) } }
    let st0 = await p.e.getLockState()
    XCTAssertEqual(st0, "uninitialized")
    let (req, rk) = try await p.e.createAccount(serverUrl: "https://Vault.test:443", accountName: "Alice", masterPassword: PW, inviteCode: "inv")
    XCTAssertEqual(req.path, "/v1/accounts")
    XCTAssertTrue(Check.recoveryKey(rk))
    XCTAssertEqual(req.body?["accountName"]?.s, "alice")
    XCTAssertEqual(req.body?["keyset"]?["keysetVersion"]?.intValue, 1)
    let st1 = await p.e.getLockState()
    XCTAssertEqual(st1, "uninitialized")
    await p.e.discardPendingAccount()
    await assertThrowsCode(.notFound) { try await p.e.commitAccount() }

    let (again, rk2) = try await p.e.createAccount(serverUrl: "https://vault.test", accountName: "alice", masterPassword: PW, inviteCode: "x")
    s.keyset = try Keyset(json: again.body!["keyset"]!)
    try await p.e.commitAccount()
    let st2 = await p.e.getLockState()
    XCTAssertEqual(st2, "unlocked")
    await aEq(try await p.e.getAccountInfo()["serverUrl"]?.s, "https://vault.test")
    await aEq(try await p.e.getSyncState()["pendingCount"]?.intValue, 2)

    await p.e.lock()
    await assertThrowsCode(.locked) { try await p.e.listItems() }
    p.restart()
    let st3 = await p.e.getLockState()
    XCTAssertEqual(st3, "locked")
    try await p.e.unlockWithPassword(PW)
    lockEvents = box.items
    XCTAssertTrue(lockEvents.contains("unlocked"))
    await aEq(try await p.e.getRecoveryKey(), rk2)
  }

  func testRejectsBadInput() async {
    let p = Phone()
    await assertThrowsCode(.invalidInput) { try await p.e.createAccount(serverUrl: "https://vault.test", accountName: "alice", masterPassword: "short", inviteCode: "x") }
    await assertThrowsCode(.invalidInput) { try await p.e.createAccount(serverUrl: "https://vault.test", accountName: "-x", masterPassword: PW, inviteCode: "x") }
    await assertThrowsCode(.invalidInput) { try await p.e.createAccount(serverUrl: "http://example.com", accountName: "alice", masterPassword: PW, inviteCode: "x") }
  }

  func testThrottlePersistsAndResets() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    await p.e.lock()
    for i in 0..<4 {
      do {
        try await p.e.unlockWithPassword("wrong-password")
        XCTFail("should fail")
      } catch let e as VaultCoreError {
        XCTAssertEqual(e.code, .wrongPassword)
        XCTAssertEqual(e.details?.attemptsLeft, 4 - i)
      }
    }
    do {
      try await p.e.unlockWithPassword("wrong-password")
    } catch let e as VaultCoreError {
      XCTAssertEqual(e.code, .wrongPassword)
      XCTAssertEqual(e.details?.retryAfterSec, 30)
    }
    p.restart()
    await assertThrowsCode(.throttled) { try await p.e.unlockWithPassword(PW) }
    let t = await p.e.getThrottleState()
    XCTAssertEqual(t.failedCount, 5)
    p.clock.advance(31)
    try await p.e.unlockWithPassword(PW)
    let t2 = await p.e.getThrottleState()
    XCTAssertEqual(t2.failedCount, 0)
    XCTAssertEqual(t2.retryAfterSec, 0)
  }

  func testBiometricUnlock() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    try await p.e.enableBiometrics()
    await p.e.lock()
    try await p.e.unlockWithBiometrics()
    let st = await p.e.getLockState()
    XCTAssertEqual(st, "unlocked")
    await p.e.lock()
    p.bio.script("cancel")
    await assertThrowsCode(.authCanceled) { try await p.e.unlockWithBiometrics() }
    p.bio.script("fail")
    await assertThrowsCode(.authFailed) { try await p.e.unlockWithBiometrics() }
    p.bio.invalidate()
    await assertThrowsCode(.biometryInvalidated) { try await p.e.unlockWithBiometrics() }
    try await p.e.unlockWithPassword(PW)
    try await p.e.enableBiometrics()
    await p.e.lock()
    try await p.e.unlockWithBiometrics()
    try await p.e.disableBiometrics()
    await p.e.lock()
    await assertThrowsCode(.biometryUnavailable) { try await p.e.unlockWithBiometrics() }
  }

  func testAutoLock() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    await p.e.onBackground()
    p.clock.advance(30)
    await p.e.onForeground()
    var st = await p.e.getLockState()
    XCTAssertEqual(st, "unlocked")
    await p.e.onBackground()
    p.clock.advance(60)
    await p.e.onForeground()
    st = await p.e.getLockState()
    XCTAssertEqual(st, "locked")
  }

  // MARK: items

  func testCrudSearchHistoryCopy() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    let gh = try await p.e.saveItem(item("GitHub", favorite: true))
    let id = gh["id"]!.s!
    XCTAssertEqual(gh["hosts"]?.arrayValue?.compactMap(\.s), ["github.example.com"])
    XCTAssertEqual(gh["hasPassword"]?.boolValue, true)
    _ = try await p.e.saveItem(item("Bank"))
    await aEq(try await p.e.listItems().count, 2)
    await aEq(try await p.e.searchItems("ＧＩＴ").compactMap { $0["title"]?.s }, ["GitHub"])
    await aEq(try await p.e.revealPassword(id), "GitHub-pass")

    // F2: password history, newest first, max 5.
    for i in 1...6 { _ = try await p.e.saveItem(item("GitHub", id: id, password: "pw\(i)")) }
    let h = try await p.e.getPasswordHistory(id)
    XCTAssertEqual(h.count, 5)
    await aEq(try await p.e.revealHistoricPassword(id, index: 0), "pw5")
    await aEq(try await p.e.revealPassword(id), "pw6")
    var keep = item("GitHub", id: id)
    keep.password = nil
    _ = try await p.e.saveItem(keep)
    await aEq(try await p.e.revealPassword(id), "pw6")
    let clears = try await p.e.copy(id, field: "password")
    XCTAssertEqual(p.clip.last?.text, "pw6")
    XCTAssertEqual(p.clip.last?.ttl, 60)
    XCTAssertNotNil(clears)
    await aNotNil(try await p.e.getItem(id)["lastUsedAt"]?.s)
    try await p.e.clearPasswordHistory(id)
    await aEq(try await p.e.getPasswordHistory(id).count, 0)
    try await p.e.updateSettings(.obj([("clipboardClearSec", .null)]))
    let never = try await p.e.copyText("x")
    XCTAssertNil(never)
    XCTAssertEqual(p.clip.last?.ttl, nil)
  }

  func testTrashRestorePurgeAndExpiry() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    let a = try await p.e.saveItem(item("A"))["id"]!.s!
    let b = try await p.e.saveItem(item("B"))["id"]!.s!
    try await syncOnce(p.e, s)
    try await p.e.trashItem(a)
    await aEq(try await p.e.listItems().count, 1)
    await aEq(try await p.e.listItems(includeTrashed: true).count, 2)
    try await p.e.restoreItem(a)
    await aEq(try await p.e.listItems().count, 2)
    try await p.e.trashItem(b)
    p.clock.advance(Double(TTLSec.trash) + 1)
    await aEq(try await p.e.purgeExpiredTrash(), 1)
    let changes = try await p.e.getPendingChanges(100)
    XCTAssertEqual(changes.filter(\.deleted).map(\.id), [b])

    // never-synced item: purge sends nothing
    let c = try await p.e.saveItem(item("C"))["id"]!.s!
    try await p.e.purgeItem(c)
    await aFalse(try await p.e.getPendingChanges(100).contains { $0.id == c })
  }

  func testGeneratorAndSettings() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    let pw = try await p.e.generatePassword(GeneratorOptions(length: 24))
    XCTAssertEqual(pw.count, 24)
    await assertThrowsCode(.invalidInput) { try await p.e.generatePassword(GeneratorOptions(length: 7)) }
    try await p.e.updateSettings(.obj([("autoLockSec", .int(300)), ("pcSessionMaxSec", .int(900))]))
    let st = try await p.e.getSettings()
    XCTAssertEqual(st["autoLockSec"]?.intValue, 300)
    XCTAssertEqual(st["pcSessionMaxSec"]?.intValue, 900)
    // the session length lives in the synced meta record
    await aTrue(try await p.e.getPendingChanges(100).contains { $0.id == metaRecordId })
  }

  func testBackupExportImportCsv() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    let a = try await p.e.saveItem(item("A"))["id"]!.s!
    _ = try await p.e.saveItem(item("B"))
    let uri = try await p.e.exportVault("export-password-1")
    await aNotNil(try await p.e.getBackupInfo())
    let ins = try await p.e.inspectImport(uri, password: "export-password-1")
    XCTAssertEqual(ins.itemCount, 2)
    XCTAssertEqual(ins.conflictCount, 2)
    await assertThrowsCode(.wrongPassword) { try await p.e.inspectImport(uri, password: "wrong-password-1") }
    let app = try await p.e.importVault(uri, password: "export-password-1", strategy: "append")
    XCTAssertEqual(app.added, 2)
    await aEq(try await p.e.listItems().count, 4)
    try await p.e.trashItem(a)
    let rep = try await p.e.importVault(uri, password: "export-password-1", strategy: "replace")
    XCTAssertEqual(rep.updated, 2)
    await aEq(try await p.e.listItems().count, 2)

    let csv = "name,url,username,password\nA,https://a.example.com,A-user,p\nNew,https://new.example,u,p\nNoPw,,u,\n"
    let curi = try await p.files.write(suggestedName: "x.csv", data: Array(csv.utf8))
    let info = try await p.e.inspectCsvImport(curi)
    XCTAssertEqual(info["format"]?.s, "chrome")
    XCTAssertEqual(info["duplicateCount"]?.intValue, 1)
    XCTAssertEqual(info["skippedCount"]?.intValue, 1)
    let r = try await p.e.importCsv(curi, skipDuplicates: true)
    XCTAssertEqual(r.added, 1)
    XCTAssertEqual(r.skipped, 2)
  }

  // MARK: storage (§6.6, AC-12)

  func testCrashAfterTmpWrittenKeepsOldFile() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    let before = try p.storage.read("vault.lv")
    p.storage.failWhen = { op, detail, _ in op == "rename" && detail.hasPrefix("vault.lv->") }
    await assertThrowsCode(.io) { try await p.e.saveItem(item("X")) }
    p.storage.failWhen = nil
    XCTAssertEqual(try p.storage.read("vault.lv"), before)
    p.restart()
    try await p.e.unlockWithPassword(PW)
    await aEq(try await p.e.listItems().count, 0)
  }

  func testCrashAfterRenameUsesTmp() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    p.storage.failWhen = { op, detail, _ in op == "rename" && detail == "vault.lv.tmp->vault.lv" }
    await assertThrowsCode(.io) { try await p.e.saveItem(item("X")) }
    p.storage.failWhen = nil
    XCTAssertFalse(p.storage.exists("vault.lv"))
    p.restart()
    try await p.e.unlockWithPassword(PW)
    await aEq(try await p.e.listItems().count, 1)
    await aTrue(await p.e.getStorageStatus().recoveredFromBackup)
  }

  func testCorruptRecordRecoveredFromBak() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    _ = try await p.e.saveItem(item("X"))
    _ = try await p.e.saveItem(item("Y"))
    // Flip one byte inside the newest file's ciphertext of the last record.
    var j = try JSONValue.parse(try p.storage.read("vault.lv")!)
    var recs = j["records"]!.arrayValue!
    var last = recs[recs.count - 1]
    var ct = try Base64Url.decode(last["ct"]!.s!)
    ct[5] ^= 1
    last = last.setting("ct", .string(Base64Url.encode(ct)))
    recs[recs.count - 1] = last
    j = j.setting("records", .array(recs))
    try p.storage.write("vault.lv", j.utf8())
    p.restart()
    try await p.e.unlockWithPassword(PW)
    await aEq(try await p.e.listItems().count, 1)  // the .bak generation (before Y)
    await aTrue(await p.e.getStorageStatus().recoveredFromBackup)
  }

  func testDamagedFileAndBackupIsCorrupted() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    _ = try await p.e.saveItem(item("X"))
    try p.storage.write("vault.lv", Array("{".utf8))
    try p.storage.write("vault.lv.bak", Array("{".utf8))
    p.restart()
    await assertThrowsCode(.corrupted) { try await p.e.unlockWithPassword(PW) }
    try await p.e.wipeLocal()
    let st = await p.e.getLockState()
    XCTAssertEqual(st, "uninitialized")
  }

  func testWipeLeavesNothingBehind() async throws {
    let s = FakeServer()
    let p = Phone()
    try await setup(s, p)
    try await p.e.enableBiometrics()
    let reqs = try await p.e.buildSignOutDevice()
    XCTAssertEqual(reqs.last?.method, "DELETE")
    XCTAssertNotNil(reqs.last?.header("X-LV-Admin"))
    try await p.e.wipeLocal()
    XCTAssertTrue(p.storage.files.isEmpty, "\(p.storage.files.keys)")
    XCTAssertTrue(p.keystore.slots.isEmpty)
  }
}

final class EventBox: @unchecked Sendable {
  private let lock = NSLock()
  private var list: [String] = []
  func add(_ s: String) { lock.withLock { list.append(s) } }
  var items: [String] { lock.withLock { list } }
}
