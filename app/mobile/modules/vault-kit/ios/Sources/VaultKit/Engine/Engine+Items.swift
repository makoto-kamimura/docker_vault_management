// Items, clipboard, generator and settings (engine.ts "items" / "settings").
import Foundation

public struct ItemInput: Sendable {
  public var id: String?
  public var title: String
  public var username: String
  /// nil = keep the current password.
  public var password: String?
  public var urls: [UrlEntry]
  public var notes: String
  public var favorite: Bool

  public init(id: String? = nil, title: String, username: String, password: String?, urls: [UrlEntry], notes: String, favorite: Bool) {
    self.id = id; self.title = title; self.username = username; self.password = password; self.urls = urls
    self.notes = notes; self.favorite = favorite
  }
}

extension VaultEngine {
  func summary(_ id: String, _ p: RecordPlain, _ data: LoginData) -> JSONValue {
    var hosts: [String] = []
    for u in data.urls { if let h = Matcher.hostOfStoredUrl(u.url), !hosts.contains(h) { hosts.append(h) } }
    return .obj([
      ("id", .string(id)), ("title", .string(data.title)), ("username", .string(data.username)),
      ("hosts", .array(hosts.map(JSONValue.string))), ("favorite", .bool(data.favorite)), ("updatedAt", .string(p.updatedAt)),
      ("lastUsedAt", .str(session?.usage[id]?.lastUsedAt)), ("isConflictCopy", .bool(data.conflictOf != nil)),
      ("trashedAt", .str(data.trashedAt)),
    ])
  }

  public func listItems(includeTrashed: Bool = false) throws -> [JSONValue] {
    let s = try sess()
    return s.plains.entries.compactMap { id, p in
      guard let l = p.login, includeTrashed || l.trashedAt == nil else { return nil }
      return summary(id, p, l)
    }
  }

  public func searchItems(_ query: String) throws -> [JSONValue] {
    try listItems().filter { i in
      let hay = [i["title"]?.stringValue ?? "", i["username"]?.stringValue ?? ""] + (i["hosts"]?.arrayValue ?? []).compactMap(\.stringValue)
      return Search.matches(query, hay)
    }
  }

  public func getItem(_ id: String) throws -> JSONValue {
    let (p, l) = try loginOf(id)
    var kv = summary(id, p, l).objectValue!
    kv += [
      ("urls", .array(l.urls.map(\.json))), ("androidApps", .array(l.androidApps.map(\.json))), ("notes", .string(l.notes)),
      ("createdAt", .string(l.createdAt)), ("conflictOf", .str(l.conflictOf)), ("hasPassword", .bool(!l.password.isEmpty)),
    ]
    return .object(kv)
  }

  public func revealPassword(_ id: String) throws -> String { try loginOf(id).data.password }

  public func saveItem(_ input: ItemInput) throws -> JSONValue {
    let (_, l, _) = try unlocked()
    let now = nowIso
    let ex = try input.id.map { try loginOf($0).data }
    let id = try input.id ?? newId()
    var history = ex?.history ?? []
    let password = input.password ?? ex?.password ?? ""
    if let ex, let pw = input.password, pw != ex.password, !ex.password.isEmpty {
      history = Array(([PasswordHistoryEntry(password: ex.password, changedAt: now)] + history).prefix(Field.passwordHistoryMax))
    }
    let data = LoginData(
      title: input.title, username: input.username, password: password, urls: input.urls, androidApps: ex?.androidApps ?? [],
      notes: input.notes, favorite: input.favorite, createdAt: ex?.createdAt ?? now, trashedAt: ex?.trashedAt, conflictOf: ex?.conflictOf,
      passwordHistory: history)
    try putLocal(id, RecordPlain(data: .login(data), updatedAt: now, updatedBy: l.deviceId))
    try save()
    return try getItem(id)
  }

  func editLogin(_ id: String, _ f: (inout LoginData) -> Void) throws {
    let (_, l, _) = try unlocked()
    var data = try loginOf(id).data
    f(&data)
    try putLocal(id, RecordPlain(data: .login(data), updatedAt: nowIso, updatedBy: l.deviceId))
    try save()
  }

  public func trashItem(_ id: String) throws { let t = nowIso; try editLogin(id) { $0.trashedAt = t } }
  public func restoreItem(_ id: String) throws { try editLogin(id) { $0.trashedAt = nil } }

  public func purgeItem(_ id: String) throws {
    _ = try loginOf(id)
    try putTombstone(id)
    try save()
  }

  /// Trash older than 30 days becomes real deletions (§7.6).
  public func purgeExpiredTrash() async throws -> Int {
    guard let s = session else { return 0 }
    let cutoff = nowMs - Double(TTLSec.trash) * 1000
    var n = 0
    for (id, p) in s.plains.entries {
      if let l = p.login, let t = l.trashedAt, let ms = ISODate.millis(t), ms <= cutoff {
        try putTombstone(id)
        n += 1
      }
    }
    if n > 0 { try save() }
    return n
  }

  public func resolveConflict(copyId: String, keep: String) throws {
    let copy = try loginOf(copyId).data
    guard let originalId = copy.conflictOf else { throw VaultCoreError(.invalidInput, "not a conflict copy") }
    let t = nowIso
    if keep == "original" {
      try editLogin(copyId) { $0.trashedAt = t }
      return
    }
    let orig = session?.plains[originalId]
    try editLogin(copyId) { $0.conflictOf = nil }
    if orig?.login != nil { try editLogin(originalId) { $0.trashedAt = t } }
  }

  public func unlinkAndroidApp(_ id: String, packageName: String) throws {
    try editLogin(id) { $0.androidApps.removeAll { $0.packageName == packageName } }
  }

  public func getPasswordHistory(_ id: String) throws -> [JSONValue] {
    try loginOf(id).data.history.enumerated().map { .obj([("index", .int($0.offset)), ("changedAt", .string($0.element.changedAt))]) }
  }

  func historic(_ id: String, _ index: Int) throws -> String {
    let h = try loginOf(id).data.history
    guard index >= 0, index < h.count else { throw VaultCoreError(.notFound, "no such history entry") }
    return h[index].password
  }

  public func revealHistoricPassword(_ id: String, index: Int) throws -> String { try historic(id, index) }
  public func copyHistoricPassword(_ id: String, index: Int) async throws -> String? { try await toClipboard(try historic(id, index)) }
  public func clearPasswordHistory(_ id: String) throws { try editLogin(id) { $0.passwordHistory = [] } }

  /// Returns `clearsAt` (ISO) or nil when the clipboard is never cleared.
  func toClipboard(_ text: String) async throws -> String? {
    let (_, l) = try acct()
    let ttl = l.clipboardClearSec
    try await d.clipboard.setSensitive(text, ttlSec: ttl)
    return ttl.map { ISODate.string(now.addingTimeInterval(Double($0))) }
  }

  public func copyText(_ text: String) async throws -> String? {
    try unlocked()
    return try await toClipboard(text)
  }

  public func copy(_ id: String, field: String) async throws -> String? {
    let l = try loginOf(id).data
    let r = try await toClipboard(field == "password" ? l.password : l.username)
    let u = session!.usage[id]
    session!.usage[id] = (nowIso, (u?.count ?? 0) + 1)
    try saveUsage()
    return r
  }

  public func generatePassword(_ o: GeneratorOptions) throws -> String { try Generator.generate(d.crypto, o) }

  // MARK: settings

  public func getSettings() throws -> JSONValue {
    ensureLoaded()
    let (_, l) = try acct()
    return .obj([
      ("autoLockSec", .int(l.autoLockSec)), ("clipboardClearSec", l.clipboardClearSec.map(JSONValue.int) ?? .null),
      ("showUsernameBeforeAuth", .bool(l.showUsernameBeforeAuth)), ("pcSessionMaxSec", .int(l.pcSessionMaxSec)),
      ("biometricsEnabled", .bool(l.biometricsEnabled)),
    ])
  }

  /// `patch` keys: autoLockSec, clipboardClearSec (null = never), showUsernameBeforeAuth, pcSessionMaxSec.
  public func updateSettings(_ patch: JSONValue) throws {
    _ = try acct()
    if let v = patch["autoLockSec"]?.intValue { local!.autoLockSec = v }
    if let v = patch["clipboardClearSec"] { local!.clipboardClearSec = v.intValue }
    if let v = patch["showUsernameBeforeAuth"]?.boolValue { local!.showUsernameBeforeAuth = v }
    if let v = patch["pcSessionMaxSec"]?.intValue, v != local!.pcSessionMaxSec {
      try sess()
      guard let m = meta() else { throw VaultCoreError(.notFound, "meta record missing") }
      local!.pcSessionMaxSec = v
      var data = m.data
      data.pcSessionMaxSec = v
      try putLocal(metaRecordId, RecordPlain(data: .meta(data), updatedAt: nowIso, updatedBy: local!.deviceId))
      try save()
    }
    try persistLocal()
  }

  public func getBackupInfo() throws -> String? {
    ensureLoaded()
    return try acct().local.lastExportAt
  }
}
