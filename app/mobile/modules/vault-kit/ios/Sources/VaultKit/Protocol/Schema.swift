// Minimal schema checking equivalent to the zod schemas of @localvault/protocol (strict objects:
// unknown keys are rejected). A failure is `SchemaError`; callers map it to E_INVALID_INPUT or
// E_CORRUPTED exactly where the TS reference does.

public struct SchemaError: Error, Sendable, CustomStringConvertible {
  public let path: String
  public init(_ path: String) { self.path = path }
  public var description: String { "schema: \(path)" }
}

/// Reader over one strict JSON object.
public struct StrictObject {
  let kv: [(String, JSONValue)]
  let path: String

  public init(_ v: JSONValue?, allowed: [String], path: String = "") throws {
    guard let v, case let .object(kv) = v else { throw SchemaError(path + " (object)") }
    for (k, _) in kv where !allowed.contains(k) { throw SchemaError(path + "." + k + " (unknown key)") }
    self.kv = kv
    self.path = path
  }

  public func has(_ k: String) -> Bool { kv.contains { $0.0 == k } }
  public func raw(_ k: String) -> JSONValue? { kv.first { $0.0 == k }?.1 }

  func fail(_ k: String) -> SchemaError { SchemaError(path + "." + k) }

  public func string(_ k: String, min: Int = 0, max: Int = .max) throws -> String {
    guard let s = raw(k)?.stringValue else { throw fail(k) }
    let n = s.utf16.count
    guard n >= min, n <= max else { throw fail(k) }
    return s
  }

  public func nullableString(_ k: String, check: (String) -> Bool) throws -> String? {
    guard let v = raw(k) else { throw fail(k) }
    if v.isNull { return nil }
    guard let s = v.stringValue, check(s) else { throw fail(k) }
    return s
  }

  public func string(_ k: String, where check: (String) -> Bool) throws -> String {
    guard let s = raw(k)?.stringValue, check(s) else { throw fail(k) }
    return s
  }

  public func int(_ k: String, min: Int = Int.min, max: Int = Int.max) throws -> Int {
    guard let n = raw(k)?.intValue, n >= min, n <= max else { throw fail(k) }
    return n
  }

  public func oneOf(_ k: String, _ values: [Int]) throws -> Int {
    let n = try int(k)
    guard values.contains(n) else { throw fail(k) }
    return n
  }

  public func bool(_ k: String) throws -> Bool {
    guard let b = raw(k)?.boolValue else { throw fail(k) }
    return b
  }

  public func literal(_ k: String, _ value: String) throws {
    guard raw(k)?.stringValue == value else { throw fail(k) }
  }

  public func literal(_ k: String, _ value: Int) throws {
    guard raw(k)?.intValue == value else { throw fail(k) }
  }

  public func enumString(_ k: String, _ values: [String]) throws -> String {
    guard let s = raw(k)?.stringValue, values.contains(s) else { throw fail(k) }
    return s
  }

  public func array(_ k: String, max: Int = .max, min: Int = 0) throws -> [JSONValue] {
    guard let a = raw(k)?.arrayValue, a.count >= min, a.count <= max else { throw fail(k) }
    return a
  }

  public func object(_ k: String) throws -> JSONValue {
    guard let v = raw(k), v.objectValue != nil else { throw fail(k) }
    return v
  }
}

/// Field validators shared by the schemas.
public enum Check {
  public static func uuid(_ s: String) -> Bool { UUIDBytes.isValid(s) }
  public static func iso(_ s: String) -> Bool { ISODate.isDateTime(s) }
  public static func b64(_ n: Int) -> (String) -> Bool { { Base64Url.isValid($0, byteLength: n) } }
  /// base64url decoding to 1...max bytes.
  public static func b64Max(_ max: Int) -> (String) -> Bool {
    { s in
      guard let d = try? Base64Url.decode(s) else { return false }
      return d.count >= 1 && d.count <= max
    }
  }
  public static let nonce = b64(ByteSize.nonce)
  public static let ciphertext = b64Max(Limits.maxCiphertextBytes)
  public static let signPub = b64(ByteSize.signPub)
  public static let sig = b64(ByteSize.sig)

  /// `LV2(-XXXX){7}` with Crockford characters.
  public static func recoveryKey(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count == 3 + 7 * 5, Array(u[0..<3]) == Array("LV2".utf8) else { return false }
    for g in 0..<7 {
      let base = 3 + g * 5
      guard u[base] == 0x2D else { return false }
      for i in 1...4 where !Crockford.alphabet.contains(u[base + i]) { return false }
    }
    return true
  }

  /// `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`, max 255.
  public static func packageName(_ s: String) -> Bool {
    guard s.utf16.count <= 255 else { return false }
    let parts = s.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count >= 2 else { return false }
    for p in parts {
      let u = Array(p.utf8)
      guard let f = u.first, (0x41...0x5A).contains(f) || (0x61...0x7A).contains(f) else { return false }
      for c in u where !((0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || (0x30...0x39).contains(c) || c == 0x5F) {
        return false
      }
    }
    return true
  }

  /// `^[0-9A-F]{64}$`
  public static func certSha256(_ s: String) -> Bool {
    let u = Array(s.utf8)
    return u.count == 64 && u.allSatisfy { (0x30...0x39).contains($0) || (0x41...0x46).contains($0) }
  }
}
