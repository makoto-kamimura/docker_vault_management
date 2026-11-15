// Persistence helpers (port of vault-engine/src/store.ts) and an insertion-ordered map with JS
// `Map` semantics (set on an existing key keeps its position).

enum Store {
  /// ① write `<name>.tmp` ② rename the current file to `<name>.bak` ③ rename tmp to `<name>`.
  static func writeAtomic(_ s: VaultStorage, _ name: String, _ data: Bytes) throws {
    let tmp = name + ".tmp"
    try s.write(tmp, data)
    if s.exists(name) { try s.rename(name, name + ".bak") }
    try s.rename(tmp, name)
  }

  enum Source { case main, tmp, bak }

  /// Candidates in order: the file; the tmp file only when the main one is missing (a crash after
  /// step ②); the .bak. The first one that parses and validates wins.
  static func readWithRecovery<T>(_ s: VaultStorage, _ name: String, _ validate: (Bytes) -> T?) -> (loaded: (value: T, source: Source)?, anyFilePresent: Bool) {
    var order: [(Source, String)] = [(.main, name)]
    if !s.exists(name) { order.append((.tmp, name + ".tmp")) }
    order.append((.bak, name + ".bak"))
    var any = false
    for (source, file) in order {
      guard let bytes = try? s.read(file) else { continue }
      any = true
      if let v = validate(bytes) { return ((v, source), true) }
    }
    return (nil, any)
  }

  static func removeAll(_ s: VaultStorage, _ name: String) throws {
    for f in [name, name + ".tmp", name + ".bak"] where s.exists(f) { try s.remove(f) }
  }
}

struct OrderedMap<V> {
  private(set) var keys: [String] = []
  private var dict: [String: V] = [:]

  init() {}
  init(_ pairs: [(String, V)]) { for (k, v) in pairs { self[k] = v } }

  subscript(_ k: String) -> V? {
    get { dict[k] }
    set {
      if let v = newValue {
        if dict[k] == nil { keys.append(k) }
        dict[k] = v
      } else if dict.removeValue(forKey: k) != nil {
        keys.removeAll { $0 == k }
      }
    }
  }

  func has(_ k: String) -> Bool { dict[k] != nil }
  var values: [V] { keys.map { dict[$0]! } }
  var entries: [(String, V)] { keys.map { ($0, dict[$0]!) } }
  var count: Int { keys.count }
}
