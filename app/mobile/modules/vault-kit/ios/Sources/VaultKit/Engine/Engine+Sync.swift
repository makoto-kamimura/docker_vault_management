// Sync: pending changes, push results, pulled records, conflicts, rollback detection (§7).
import Foundation

extension VaultEngine {
  func collectPending(_ limit: Int) -> [RecordChange] {
    var out: [RecordChange] = []
    for r in recs.values where r.dirty {
      if out.count >= limit { break }
      inflight[r.id] = r.nonce ?? "tombstone"
      out.append(RecordChange(id: r.id, baseRev: r.baseRev, vkVersion: r.vkVersion, deleted: r.deleted, nonce: r.nonce, ct: r.ct))
    }
    return out
  }

  func syncGuard() throws -> (file: VaultFile, local: LocalState) {
    let a = try acct()
    if a.local.revoked { throw VaultCoreError(.deviceRevoked) }
    if a.local.rollbackDetected { throw VaultCoreError(.rollbackDetected) }
    return a
  }

  public func getSyncState() throws -> JSONValue {
    ensureLoaded()
    let (f, _) = try acct()
    return .obj([
      ("cursor", .int(f.sync.cursor)), ("maxSeenRev", .int(f.sync.maxSeenRev)), ("lastSyncedAt", .str(f.sync.lastSyncedAt)),
      ("pendingCount", .int(recs.values.filter(\.dirty).count)),
    ])
  }

  public func getPendingChanges(_ limit: Int) async throws -> [RecordChange] {
    ensureLoaded()
    let (_, l) = try syncGuard()
    if l.pendingRotation != nil { return [] }
    _ = try await purgeExpiredTrash()
    return collectPending(limit)
  }

  func rollback() throws -> Never {
    local?.rollbackDetected = true
    try persistLocal()
    throw VaultCoreError(.rollbackDetected, "server state went backwards")
  }

  func setServerRecord(_ rec: EncryptedRecord, _ plain: RecordPlain?) {
    recs[rec.id] = VaultFileRecord(
      id: rec.id, rev: rec.rev, vkVersion: rec.vkVersion, deleted: rec.deleted, nonce: rec.nonce, ct: rec.ct, dirty: false, baseRev: rec.rev)
    session?.plains[rec.id] = plain
  }

  func decryptServer(_ rec: EncryptedRecord) throws -> RecordPlain? {
    if rec.deleted { return nil }
    let (f, _) = try acct()
    do {
      return try Records.decrypt(
        d.crypto, vk: try sess().vk, locator: RecordLocator(accountId: f.accountId, recordId: rec.id, vkVersion: rec.vkVersion),
        payload: EncryptedPayload(nonce: rec.nonce ?? "", ct: rec.ct ?? ""))
    } catch let e as VaultCoreError where e.code == .locked {
      throw e
    } catch {
      throw VaultCoreError(.corrupted, "a record from the server failed authentication")
    }
  }

  /// Resolves one conflict between our dirty record and the server's (§7.4). True if counted.
  func resolve(_ rec: EncryptedRecord, _ serverPlain: RecordPlain?) throws -> Bool {
    let (_, l) = try acct()
    let s = try sess()
    let mine = recs[rec.id]
    let localPlain = (mine != nil && !mine!.deleted) ? s.plains[rec.id] : nil
    let ids = [try newId(), try newId()]
    var n = 0
    let out = try Conflict.resolve(id: rec.id, local: localPlain, server: serverPlain, now: now, deviceId: l.deviceId) {
      defer { n += 1 }
      return ids[n]
    }
    setServerRecord(rec, serverPlain)
    switch out {
    case let .useServer(notify):
      if notify { self.notify(.serverEditWon(id: rec.id)) }
      return notify
    case let .useServerAndCopy(copy):
      try putLocal(copy.id, copy.plain)
      return true
    case let .restoreAsNew(record):
      try putLocal(record.id, record.plain)
      notify(.restoredAsNew(id: record.id, originalId: rec.id))
      return true
    case let .push(record):
      try putLocal(rec.id, record)
      return false
    }
  }

  public func applyPushResults(_ results: [PushResult]) async throws -> Int {
    let (f, _) = try syncGuard()
    try sess()
    var conflicts = 0
    for r in results {
      switch r {
      case let .ok(id, rev):
        file!.sync.maxSeenRev = max(file!.sync.maxSeenRev, rev)
        guard var mine = recs[id] else { continue }
        let same = inflight[id] == (mine.nonce ?? "tombstone")
        inflight[id] = nil
        if mine.deleted && same {
          // Keep the tombstone: rotations must include every id the server still holds.
          mine.rev = rev
          mine.baseRev = rev
          mine.dirty = false
        } else {
          mine.rev = same ? rev : mine.rev
          mine.baseRev = rev
          mine.dirty = !same
        }
        recs[id] = mine
      case let .conflict(id, cur):
        if cur.vkVersion != f.keyset.vkVersion { throw VaultCoreError(.staleKey) }
        file!.sync.maxSeenRev = max(file!.sync.maxSeenRev, cur.rev)
        inflight[id] = nil
        let sp = try decryptServer(cur)
        if try resolve(cur, sp) { conflicts += 1 }
      }
    }
    try await adoptMeta()
    try saveSynced()
    return conflicts
  }

  public func applyPulled(records: [EncryptedRecord], cursor: Int, keyset: JSONValue?, fullResync: Bool, hasMore: Bool) async throws -> (conflicts: Int, needsMasterPassword: Bool) {
    ensureLoaded()
    let (f, l) = try syncGuard()
    try sess()
    let last = !hasMore

    var keysetUpdate: Keyset?
    if let kj = keyset, !kj.isNull {
      let k: Keyset
      do { k = try Keyset(json: kj) } catch { throw VaultCoreError(.corrupted, "malformed keyset") }
      if !l.allowDowngrade && (k.keysetVersion < f.keyset.keysetVersion || k.vkVersion < f.keyset.vkVersion) { try rollback() }
      if k.vkVersion != f.keyset.vkVersion {
        local!.pendingRotation = k
        local!.allowDowngrade = false
        try persistLocal()
      } else if k.keysetVersion != f.keyset.keysetVersion {
        keysetUpdate = k
      }
    }
    if local!.pendingRotation != nil { return (0, true) }

    if !fullResync && cursor < f.sync.cursor { try rollback() }
    if last && cursor < f.sync.maxSeenRev { try rollback() }
    var maxRev = cursor
    for r in records {
      if r.rev > cursor { try rollback() }
      if r.vkVersion < f.keyset.vkVersion { try rollback() }
      maxRev = max(maxRev, r.rev)
      if let mine = recs[r.id], !mine.dirty, mine.rev > r.rev { try rollback() }
    }
    if records.contains(where: { $0.vkVersion > f.keyset.vkVersion }) { return (0, true) }

    // Authenticate everything before touching state.
    var plains: [String: RecordPlain?] = [:]
    for r in records { plains[r.id] = try decryptServer(r) }

    var conflicts = 0
    if fullResync && resyncSeen == nil { resyncSeen = [] }
    if !fullResync { resyncSeen = nil }
    for r in records {
      resyncSeen?.insert(r.id)
      let sp = plains[r.id] ?? nil
      if let mine = recs[r.id], mine.dirty {
        if r.rev > mine.baseRev, try resolve(r, sp) { conflicts += 1 }
      } else {
        setServerRecord(r, sp)
      }
    }
    if let k = keysetUpdate {
      file!.keyset = k
      local!.allowDowngrade = false
    }
    if last, let seen = resyncSeen {
      for (id, r) in recs.entries where !r.dirty && !seen.contains(id) {
        recs[id] = nil
        session?.plains[id] = nil
      }
      resyncSeen = nil
    }
    file!.sync.cursor = cursor
    file!.sync.maxSeenRev = max(file!.sync.maxSeenRev, maxRev)
    if last { file!.sync.lastSyncedAt = nowIso }
    try await adoptMeta()
    try persistLocal()
    try saveSynced()
    return (conflicts, false)
  }

  /// Picks up a reissued recovery key / PC session length from the synced meta record (§7.7).
  func adoptMeta() async throws {
    guard let m = meta(), local != nil else { return }
    if local!.pcSessionMaxSec != m.data.pcSessionMaxSec {
      local!.pcSessionMaxSec = m.data.pcSessionMaxSec
      try persistLocal()
    }
    if let sk = try? RecoveryKey.parse(d.crypto, m.data.recoveryKey) {
      let cur = try await d.keystore.read(.sk, auth: nil)
      if cur == nil || !constantTimeEqual(cur!, sk) { try await d.keystore.write(.sk, sk) }
    }
  }

  public func acceptServerState() throws {
    _ = try acct()
    local!.rollbackDetected = false
    local!.allowDowngrade = true
    file!.sync.cursor = 0
    file!.sync.maxSeenRev = 0
    for (id, r) in recs.entries where !r.dirty { recs[id] = nil }
    if let s = session {
      for id in s.plains.keys where !recs.has(id) { session!.plains[id] = nil }
    }
    try persistLocal()
    try persistFile()
  }
}
