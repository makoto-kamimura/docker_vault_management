// Conflict resolution — spec §7.4 (port of core/src/conflict.ts). nil stands for a tombstone.
import Foundation

public struct NewRecord: Sendable, Equatable {
  public var id: String
  public var plain: RecordPlain
}

public enum ConflictOutcome: Sendable, Equatable {
  /// Keep the server's version; `notify` when a deletion was undone.
  case useServer(notify: Bool)
  /// Keep the server's version AND add the local edit as a "conflict copy" item.
  case useServerAndCopy(copy: NewRecord)
  /// The server deleted it but we edited it: restore the edit as a NEW item.
  case restoreAsNew(record: NewRecord)
  /// Singleton records (device / meta): send this content for the same id.
  case push(record: RecordPlain)
}

public enum Conflict {
  static let copyPrefix = "（競合コピー "
  static let copySuffix = "）"

  /// `<title>（競合コピー YYYY-MM-DD）`, shortened to respect the 100 UTF-16 unit limit.
  public static func copyTitle(_ title: String, now: Date) -> String {
    let suffix = copyPrefix + String(ISODate.string(now).prefix(10)) + copySuffix
    let budget = Field.titleMax - suffix.utf16.count
    var kept = ""
    var used = 0
    for ch in title.unicodeScalars {
      let n = String(ch).utf16.count
      if used + n > budget { break }
      kept.unicodeScalars.append(ch)
      used += n
    }
    return kept + suffix
  }

  public static func resolve(
    id: String, local: RecordPlain?, server: RecordPlain?, now: Date, deviceId: String, newId: () throws -> String
  ) throws -> ConflictOutcome {
    guard let local, let server else {
      if local == nil && server == nil { return .useServer(notify: false) }
      if local == nil { return .useServer(notify: server?.kind == "login") }
      // The server deleted, we edited.
      guard let l = local, case let .login(d) = l.data else { return .push(record: local!) }
      var data = d
      data.passwordHistory = d.history
      return .restoreAsNew(record: NewRecord(
        id: try newId(), plain: RecordPlain(data: .login(data), updatedAt: ISODate.string(now), updatedBy: deviceId)))
    }
    if local.kind != server.kind { return .useServer(notify: false) }
    switch (local.data, server.data) {
    case let (.login(l), .login(s)):
      if sameLoginData(l, s) { return .useServer(notify: false) }
      var data = l
      data.title = copyTitle(l.title, now: now)
      data.conflictOf = id
      data.passwordHistory = l.history
      return .useServerAndCopy(copy: NewRecord(
        id: try newId(), plain: RecordPlain(data: .login(data), updatedAt: ISODate.string(now), updatedBy: deviceId)))
    case let (.device(l), .device(s)):
      // The newer updatedAt wins, but revokedAt once set is never cleared.
      var merged = local.updatedAt > server.updatedAt ? l : s
      merged.revokedAt = s.revokedAt ?? l.revokedAt
      if canonical(merged.json) == canonical(s.json) { return .useServer(notify: false) }
      if canonical(merged.json) == canonical(l.json) { return .push(record: local) }
      return .push(record: RecordPlain(data: .device(merged), updatedAt: ISODate.string(now), updatedBy: deviceId))
    case (.meta, .meta):
      return local.updatedAt > server.updatedAt ? .push(record: local) : .useServer(notify: false)
    default:
      return .useServer(notify: false)
    }
  }

  static func sameLoginData(_ a: LoginData, _ b: LoginData) -> Bool {
    var x = a, y = b
    x.passwordHistory = a.history
    y.passwordHistory = b.history
    return canonical(x.json) == canonical(y.json)
  }

  /// JSON with object keys sorted (UTF-16 order, like JS `sort()`), so key order does not matter.
  public static func canonical(_ v: JSONValue) -> String {
    switch v {
    case let .array(a): return "[" + a.map(canonical).joined(separator: ",") + "]"
    case let .object(kv):
      let sorted = kv.sorted { Array($0.0.utf16).lexicographicallyPrecedes(Array($1.0.utf16)) }
      return "{" + sorted.map { JSONValue.string($0.0).stringify() + ":" + canonical($0.1) }.joined(separator: ",") + "}"
    default: return v.stringify()
    }
  }
}
