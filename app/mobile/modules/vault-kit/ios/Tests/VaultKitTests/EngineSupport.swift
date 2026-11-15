// In-memory dependencies, a fake sync server and the sync loop for engine tests
// (ports of vault-engine/src/memory.ts and test/helpers.ts).
import Foundation
import XCTest

@testable import VaultKit

final class MemoryStorage: VaultStorage, @unchecked Sendable {
  var files: [String: Bytes] = [:]
  var log: [String] = []
  /// Throw to simulate a crash before the n-th mutating operation.
  var failWhen: ((String, String, Int) -> Bool)?
  private var ops = 0
  private let lock = NSLock()

  func read(_ name: String) throws -> Bytes? { lock.withLock { files[name] } }
  func exists(_ name: String) -> Bool { lock.withLock { files[name] != nil } }

  private func gate(_ op: String, _ detail: String) throws {
    ops += 1
    log.append("\(op):\(detail)")
    if failWhen?(op, detail, ops) == true { throw VaultCoreError(.io, "simulated crash") }
  }

  func write(_ name: String, _ data: Bytes) throws { try lock.withLock { try gate("write", name); files[name] = data } }
  func rename(_ from: String, _ to: String) throws {
    try lock.withLock {
      try gate("rename", "\(from)->\(to)")
      guard let v = files[from] else { throw VaultCoreError(.io, "rename source is missing") }
      files[to] = v
      files[from] = nil
    }
  }
  func remove(_ name: String) throws { try lock.withLock { try gate("remove", name); files[name] = nil } }

  func corrupt(_ name: String, at offset: Int) {
    lock.withLock {
      guard var v = files[name] else { return }
      let i = offset < 0 ? v.count + offset : offset
      v[i] ^= 1
      files[name] = v
    }
  }
}

final class MemoryBiometric: Biometric, @unchecked Sendable {
  var available = true
  var generation = 0
  var prompts: [String] = []
  var queue: [String] = []
  var tokens: [ObjectIdentifier] = []

  func availability() async -> (available: Bool, kind: BiometricKind) { available ? (true, .faceId) : (false, .none) }
  func script(_ r: String...) { queue.append(contentsOf: r) }
  func invalidate() { generation += 1 }

  func authenticate(reason: String) async throws -> AuthToken {
    prompts.append(reason)
    if !available { throw VaultCoreError(.biometryUnavailable) }
    let next = queue.isEmpty ? "success" : queue.removeFirst()
    switch next {
    case "cancel": throw VaultCoreError(.authCanceled)
    case "fail": throw VaultCoreError(.authFailed)
    case "invalidated": throw VaultCoreError(.biometryInvalidated)
    default: break
    }
    let t = AuthToken()
    tokens.append(ObjectIdentifier(t))
    return t
  }

  func isValid(_ t: AuthToken?) -> Bool { t.map { tokens.contains(ObjectIdentifier($0)) } ?? false }
}

final class MemoryKeystore: Keystore, @unchecked Sendable {
  var slots: [KeystoreSlot: (value: Bytes, generation: Int)] = [:]
  let bio: MemoryBiometric
  init(_ bio: MemoryBiometric) { self.bio = bio }

  func read(_ slot: KeystoreSlot, auth: AuthToken?) async throws -> Bytes? {
    guard let e = slots[slot] else { return nil }
    if slot.biometricGated {
      guard bio.isValid(auth) else { throw VaultCoreError(.authFailed, "slot needs a biometric prompt") }
      guard e.generation == bio.generation else { throw VaultCoreError(.biometryInvalidated) }
    }
    return e.value
  }
  func write(_ slot: KeystoreSlot, _ value: Bytes) async throws { slots[slot] = (value, bio.generation) }
  func delete(_ slot: KeystoreSlot) async throws { slots[slot] = nil }
}

final class MemoryClipboard: SecureClipboard, @unchecked Sendable {
  var last: (text: String, ttl: Int?)?
  func setSensitive(_ text: String, ttlSec: Int?) async throws { last = (text, ttlSec) }
}

final class MemoryFiles: FileAccess, @unchecked Sendable {
  var files: [String: Bytes] = [:]
  var n = 0
  func write(suggestedName: String, data: Bytes) async throws -> String {
    n += 1
    let uri = "mem://\(n)/\(suggestedName)"
    files[uri] = data
    return uri
  }
  func read(uri: String) async throws -> Bytes {
    guard let f = files[uri] else { throw VaultCoreError(.notFound) }
    return f
  }
  func delete(uri: String) async throws { files[uri] = nil }
}

final class ManualClock: Clock, @unchecked Sendable {
  var t = Date(timeIntervalSince1970: 1_794_000_000)
  func now() -> Date { t }
  func advance(_ sec: Double) { t = t.addingTimeInterval(sec) }
}

let PW = "correct horse battery"

final class Phone {
  let storage = MemoryStorage()
  let bio = MemoryBiometric()
  lazy var keystore = MemoryKeystore(bio)
  let clip = MemoryClipboard()
  let files = MemoryFiles()
  let clock: ManualClock
  var e: VaultEngine!
  var events: [String] = []

  init(clock: ManualClock = ManualClock(), platform: String = "ios") {
    self.clock = clock
    e = makeEngine(platform)
  }

  func makeEngine(_ platform: String = "ios") -> VaultEngine {
    VaultEngine(EngineDeps(
      storage: storage, keystore: keystore, biometric: bio, clipboard: clip, files: files, clock: clock, platform: platform))
  }

  /// Same storage / keystore, fresh engine: "the app was restarted".
  func restart() { e = makeEngine() }
}

/// The sync part of the server: rev numbering, tombstones, keyset delivery, rotations.
final class FakeServer {
  var records: [String: EncryptedRecord] = [:]
  var recordRev = 0
  var keysetRev = 0
  var minValid = 0
  var keyset: Keyset!
  var accountId = ""
  var accountName = ""
  var tamperPull: ((inout PullResponse) -> Void)?

  struct PullResponse {
    var records: [EncryptedRecord]
    var cursor: Int
    var hasMore: Bool
    var fullResync: Bool
    var keyset: Keyset?
  }

  func push(_ changes: [RecordChange]) throws -> [PushResult] {
    var out: [PushResult] = []
    for c in changes {
      if c.vkVersion != keyset.vkVersion { throw VaultCoreError(.staleKey) }
      if let cur = records[c.id], cur.rev != c.baseRev {
        out.append(.conflict(id: c.id, current: cur))
        continue
      }
      recordRev += 1
      records[c.id] = EncryptedRecord(id: c.id, rev: recordRev, vkVersion: c.vkVersion, deleted: c.deleted, nonce: c.nonce, ct: c.ct)
      out.append(.ok(id: c.id, rev: recordRev))
    }
    return out
  }

  func pull(_ since: Int, limit: Int = 500) -> PullResponse {
    let rows = records.values.filter { $0.rev > since }.sorted { $0.rev < $1.rev }
    let page = Array(rows.prefix(limit))
    let hasMore = rows.count > limit
    var res = PullResponse(
      records: page, cursor: hasMore ? page.last!.rev : recordRev, hasMore: hasMore, fullResync: since > 0 && since < minValid, keyset: nil)
    if since == 0 || since < keysetRev { res.keyset = keyset }
    tamperPull?(&res)
    return res
  }

  func setKeyset(_ ks: Keyset) {
    keyset = ks
    recordRev += 1
    keysetRev = recordRev
  }

  func rotate(_ recs: [RotationRecord], _ ks: Keyset) -> Int {
    let base = recordRev
    for (i, r) in recs.sorted(by: { $0.id < $1.id }).enumerated() {
      records[r.id] = EncryptedRecord(id: r.id, rev: base + i + 1, vkVersion: ks.vkVersion, deleted: r.deleted, nonce: r.nonce, ct: r.ct)
    }
    recordRev = base + recs.count
    keysetRev = recordRev
    minValid = base + 1
    keyset = ks
    return recordRev
  }
}

@discardableResult
func syncOnce(_ e: VaultEngine, _ s: FakeServer) async throws -> Bool {
  while true {
    let changes = try await e.getPendingChanges(100)
    if changes.isEmpty { break }
    _ = try await e.applyPushResults(try s.push(changes))
  }
  var needs = false
  var cursor = try await e.getSyncState()["cursor"]!.intValue!
  var restarting = false
  while true {
    var res = s.pull(cursor)
    if res.fullResync && !restarting {
      restarting = true
      cursor = 0
      continue
    }
    if restarting { res.fullResync = true }
    let r = try await e.applyPulled(records: res.records, cursor: res.cursor, keyset: res.keyset?.json, fullResync: res.fullResync, hasMore: res.hasMore)
    if r.needsMasterPassword { needs = true }
    cursor = res.cursor
    if !res.hasMore { break }
  }
  return needs
}

@discardableResult
func setup(_ s: FakeServer, _ p: Phone, name: String = "alice") async throws -> String {
  let (req, rk) = try await p.e.createAccount(serverUrl: "https://vault.test", accountName: name, masterPassword: PW, inviteCode: "x")
  s.accountId = req.body!["accountId"]!.stringValue!
  s.accountName = req.body!["accountName"]!.stringValue!
  s.keyset = try Keyset(json: req.body!["keyset"]!)
  try await p.e.commitAccount()
  try await syncOnce(p.e, s)
  return rk
}

func restoreOn(_ s: FakeServer, _ p: Phone, _ rk: String, password: String = PW) async throws {
  let authKey = try await p.e.deriveAuthKey(accountId: s.accountId, kdf: s.keyset.kdf, masterPassword: password, recoveryKey: rk)
  _ = try await p.e.buildRecoverRequest(accountName: s.accountName, authKey: authKey)
  try await p.e.restoreAccount(
    serverUrl: "https://vault.test", accountName: s.accountName, accountId: s.accountId, keyset: s.keyset.json, masterPassword: password,
    recoveryKey: rk)
  try await syncOnce(p.e, s)
}

func item(_ title: String, id: String? = nil, password: String? = nil, notes: String = "", favorite: Bool = false) -> ItemInput {
  ItemInput(
    id: id, title: title, username: "\(title)-user", password: password ?? "\(title)-pass",
    urls: [UrlEntry(url: "https://\(title.lowercased()).example.com/login", match: "domain")], notes: notes, favorite: favorite)
}

func assertThrowsCode<T>(_ code: VaultCoreErrorCode, file: StaticString = #filePath, line: UInt = #line, _ body: () async throws -> T) async {
  do {
    _ = try await body()
    XCTFail("expected \(code.rawValue)", file: file, line: line)
  } catch let e as VaultCoreError {
    XCTAssertEqual(e.code, code, e.message, file: file, line: line)
  } catch {
    XCTFail("unexpected \(error)", file: file, line: line)
  }
}

extension JSONValue {
  var s: String? { stringValue }
}

// Async assertions: XCTest's autoclosures cannot `await`.
func aEq<T: Equatable>(_ a: @autoclosure () async throws -> T, _ b: @autoclosure () async throws -> T, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) async {
  do {
    let x = try await a(), y = try await b()
    XCTAssertEqual(x, y, msg, file: file, line: line)
  } catch { XCTFail("threw \(error) \(msg)", file: file, line: line) }
}

func aTrue(_ a: @autoclosure () async throws -> Bool, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) async {
  do { let x = try await a(); XCTAssertTrue(x, msg, file: file, line: line) } catch { XCTFail("threw \(error) \(msg)", file: file, line: line) }
}

func aFalse(_ a: @autoclosure () async throws -> Bool, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) async {
  do { let x = try await a(); XCTAssertFalse(x, msg, file: file, line: line) } catch { XCTFail("threw \(error) \(msg)", file: file, line: line) }
}

func aNotNil<T>(_ a: @autoclosure () async throws -> T?, _ msg: String = "", file: StaticString = #filePath, line: UInt = #line) async {
  do { let x = try await a(); XCTAssertNotNil(x, msg, file: file, line: line) } catch { XCTFail("threw \(error) \(msg)", file: file, line: line) }
}
