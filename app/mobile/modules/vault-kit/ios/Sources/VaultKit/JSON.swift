// Order-preserving JSON value with a strict parser and a serializer that matches JS
// `JSON.stringify` byte for byte (record padding and the crypto vectors depend on it).
import Foundation

public enum JSONValue: Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  /// Key order is insertion order, as in JS objects with non-numeric keys.
  case object([(String, JSONValue)])

  public static func == (a: JSONValue, b: JSONValue) -> Bool {
    switch (a, b) {
    case (.null, .null): return true
    case let (.bool(x), .bool(y)): return x == y
    case let (.number(x), .number(y)): return x == y
    case let (.string(x), .string(y)): return x == y
    case let (.array(x), .array(y)): return x == y
    case let (.object(x), .object(y)):
      return x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    default: return false
    }
  }

  // MARK: accessors

  public subscript(key: String) -> JSONValue? {
    if case let .object(kv) = self { return kv.first { $0.0 == key }?.1 }
    return nil
  }

  public var stringValue: String? { if case let .string(s) = self { return s }; return nil }
  public var boolValue: Bool? { if case let .bool(b) = self { return b }; return nil }
  public var doubleValue: Double? { if case let .number(n) = self { return n }; return nil }
  public var arrayValue: [JSONValue]? { if case let .array(a) = self { return a }; return nil }
  public var objectValue: [(String, JSONValue)]? { if case let .object(o) = self { return o }; return nil }
  public var isNull: Bool { if case .null = self { return true }; return false }

  /// Safe integer (as zod's `z.int()`): finite, integral, |n| <= 2^53 - 1.
  public var intValue: Int? {
    guard case let .number(n) = self, n.isFinite, n == n.rounded(), abs(n) <= 9_007_199_254_740_991
    else { return nil }
    return Int(n)
  }

  public var keys: [String] { objectValue?.map(\.0) ?? [] }

  // MARK: builders

  public static func obj(_ pairs: [(String, JSONValue)]) -> JSONValue { .object(pairs) }
  public static func int(_ n: Int) -> JSONValue { .number(Double(n)) }
  public static func str(_ s: String?) -> JSONValue { s.map(JSONValue.string) ?? .null }

  /// Returns a copy with `key` set (replaced in place, or appended).
  public func setting(_ key: String, _ value: JSONValue) -> JSONValue {
    guard case var .object(kv) = self else { return self }
    if let i = kv.firstIndex(where: { $0.0 == key }) { kv[i].1 = value } else { kv.append((key, value)) }
    return .object(kv)
  }

  public func removing(_ key: String) -> JSONValue {
    guard case let .object(kv) = self else { return self }
    return .object(kv.filter { $0.0 != key })
  }
}

// MARK: - serializer (JS JSON.stringify)

extension JSONValue {
  public func stringify() -> String {
    var out = ""
    write(into: &out)
    return out
  }

  public func utf8() -> Bytes { Array(stringify().utf8) }

  private func write(into out: inout String) {
    switch self {
    case .null: out += "null"
    case let .bool(b): out += b ? "true" : "false"
    case let .number(n): out += JSONValue.jsNumber(n)
    case let .string(s): JSONValue.quote(s, into: &out)
    case let .array(a):
      out += "["
      for (i, v) in a.enumerated() {
        if i > 0 { out += "," }
        v.write(into: &out)
      }
      out += "]"
    case let .object(kv):
      out += "{"
      for (i, (k, v)) in kv.enumerated() {
        if i > 0 { out += "," }
        JSONValue.quote(k, into: &out)
        out += ":"
        v.write(into: &out)
      }
      out += "}"
    }
  }

  static func quote(_ s: String, into out: inout String) {
    out += "\""
    for u in s.unicodeScalars {
      switch u {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if u.value < 0x20 {
          let h = String(u.value, radix: 16)
          out += "\\u" + String(repeating: "0", count: 4 - h.count) + h
        } else {
          out.unicodeScalars.append(u)
        }
      }
    }
    out += "\""
  }

  /// ECMAScript Number::toString for finite numbers; non-finite serialize as null.
  static func jsNumber(_ n: Double) -> String {
    guard n.isFinite else { return "null" }
    if n == 0 { return "0" }
    if n == n.rounded(), abs(n) < 1e21 {
      return String(format: "%.0f", n)
    }
    // Shortest round-trip digits from Swift, re-laid out by the JS rules.
    let neg = n < 0
    var d = "\(abs(n))"  // e.g. "0.1", "1e-07", "1.5e+22", "123.45"
    var exp = 0
    if let e = d.firstIndex(where: { $0 == "e" || $0 == "E" }) {
      exp = Int(d[d.index(after: e)...]) ?? 0
      d = String(d[..<e])
    }
    var intPart = d
    var frac = ""
    if let dot = d.firstIndex(of: ".") {
      intPart = String(d[..<dot])
      frac = String(d[d.index(after: dot)...])
    }
    var digits = intPart + frac
    var pointPos = intPart.count + exp  // decimal point position relative to `digits`
    while digits.hasPrefix("0") && digits.count > 1 {
      digits.removeFirst()
      pointPos -= 1
    }
    while digits.hasSuffix("0") && digits.count > 1 { digits.removeLast() }
    let k = digits.count
    let nExp = pointPos  // value = 0.digits × 10^nExp
    var s: String
    if k <= nExp && nExp <= 21 {
      s = digits + String(repeating: "0", count: nExp - k)
    } else if 0 < nExp && nExp <= 21 {
      let i = digits.index(digits.startIndex, offsetBy: nExp)
      s = String(digits[..<i]) + "." + String(digits[i...])
    } else if -6 < nExp && nExp <= 0 {
      s = "0." + String(repeating: "0", count: -nExp) + digits
    } else {
      let e = nExp - 1
      let sign = e < 0 ? "-" : "+"
      let first = String(digits.prefix(1))
      let rest = String(digits.dropFirst())
      s = first + (rest.isEmpty ? "" : "." + rest) + "e" + sign + String(abs(e))
    }
    return neg ? "-" + s : s
  }
}

// MARK: - parser (JSON.parse, strict RFC 8259)

public struct JSONParseError: Error, Sendable {}

extension JSONValue {
  public static func parse(_ text: String) throws -> JSONValue {
    try parse(Array(text.utf8))
  }

  public static func parse(_ bytes: Bytes) throws -> JSONValue {
    var p = Parser(b: bytes)
    p.ws()
    let v = try p.value(depth: 0)
    p.ws()
    guard p.i == p.b.count else { throw JSONParseError() }
    return v
  }

  private struct Parser {
    let b: Bytes
    var i = 0

    mutating func ws() {
      while i < b.count, b[i] == 0x20 || b[i] == 0x0A || b[i] == 0x0D || b[i] == 0x09 { i += 1 }
    }

    mutating func value(depth: Int) throws -> JSONValue {
      guard depth < 512, i < b.count else { throw JSONParseError() }
      switch b[i] {
      case 0x7B: return try object(depth: depth)
      case 0x5B: return try array(depth: depth)
      case 0x22: return .string(try string())
      case 0x74: try literal("true"); return .bool(true)
      case 0x66: try literal("false"); return .bool(false)
      case 0x6E: try literal("null"); return .null
      default: return .number(try number())
      }
    }

    mutating func literal(_ s: String) throws {
      let u = Array(s.utf8)
      guard i + u.count <= b.count, Array(b[i..<i + u.count]) == u else { throw JSONParseError() }
      i += u.count
    }

    mutating func object(depth: Int) throws -> JSONValue {
      i += 1
      var kv: [(String, JSONValue)] = []
      ws()
      if i < b.count, b[i] == 0x7D { i += 1; return .object(kv) }
      while true {
        ws()
        guard i < b.count, b[i] == 0x22 else { throw JSONParseError() }
        let k = try string()
        ws()
        guard i < b.count, b[i] == 0x3A else { throw JSONParseError() }
        i += 1
        ws()
        let v = try value(depth: depth + 1)
        // JS: a duplicate key keeps its first position and takes the last value.
        if let j = kv.firstIndex(where: { $0.0 == k }) { kv[j].1 = v } else { kv.append((k, v)) }
        ws()
        guard i < b.count else { throw JSONParseError() }
        if b[i] == 0x2C { i += 1; continue }
        if b[i] == 0x7D { i += 1; return .object(kv) }
        throw JSONParseError()
      }
    }

    mutating func array(depth: Int) throws -> JSONValue {
      i += 1
      var a: [JSONValue] = []
      ws()
      if i < b.count, b[i] == 0x5D { i += 1; return .array(a) }
      while true {
        ws()
        a.append(try value(depth: depth + 1))
        ws()
        guard i < b.count else { throw JSONParseError() }
        if b[i] == 0x2C { i += 1; continue }
        if b[i] == 0x5D { i += 1; return .array(a) }
        throw JSONParseError()
      }
    }

    mutating func hex4() throws -> UInt32 {
      guard i + 4 <= b.count else { throw JSONParseError() }
      var v: UInt32 = 0
      for _ in 0..<4 {
        let c = b[i]
        let d: UInt32
        switch c {
        case 0x30...0x39: d = UInt32(c - 0x30)
        case 0x41...0x46: d = UInt32(c - 0x41 + 10)
        case 0x61...0x66: d = UInt32(c - 0x61 + 10)
        default: throw JSONParseError()
        }
        v = v << 4 | d
        i += 1
      }
      return v
    }

    mutating func string() throws -> String {
      i += 1
      var out = Bytes()
      while true {
        guard i < b.count else { throw JSONParseError() }
        let c = b[i]
        if c == 0x22 { i += 1; break }
        if c < 0x20 { throw JSONParseError() }
        if c != 0x5C { out.append(c); i += 1; continue }
        i += 1
        guard i < b.count else { throw JSONParseError() }
        let e = b[i]
        i += 1
        switch e {
        case 0x22: out.append(0x22)
        case 0x5C: out.append(0x5C)
        case 0x2F: out.append(0x2F)
        case 0x62: out.append(0x08)
        case 0x66: out.append(0x0C)
        case 0x6E: out.append(0x0A)
        case 0x72: out.append(0x0D)
        case 0x74: out.append(0x09)
        case 0x75:
          var cp = try hex4()
          if (0xD800...0xDBFF).contains(cp) {
            // A lone surrogate cannot live in a Swift String; treat it as malformed input.
            guard i + 6 <= b.count, b[i] == 0x5C, b[i + 1] == 0x75 else { throw JSONParseError() }
            i += 2
            let lo = try hex4()
            guard (0xDC00...0xDFFF).contains(lo) else { throw JSONParseError() }
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
          } else if (0xDC00...0xDFFF).contains(cp) {
            throw JSONParseError()
          }
          guard let s = Unicode.Scalar(cp) else { throw JSONParseError() }
          out.append(contentsOf: Array(String(Character(s)).utf8))
        default: throw JSONParseError()
        }
      }
      let s = String(decoding: out, as: UTF8.self)
      guard Array(s.utf8) == out else { throw JSONParseError() }
      return s
    }

    mutating func number() throws -> Double {
      let start = i
      if i < b.count, b[i] == 0x2D { i += 1 }
      guard i < b.count else { throw JSONParseError() }
      if b[i] == 0x30 {
        i += 1
      } else if (0x31...0x39).contains(b[i]) {
        while i < b.count, (0x30...0x39).contains(b[i]) { i += 1 }
      } else {
        throw JSONParseError()
      }
      if i < b.count, b[i] == 0x2E {
        i += 1
        guard i < b.count, (0x30...0x39).contains(b[i]) else { throw JSONParseError() }
        while i < b.count, (0x30...0x39).contains(b[i]) { i += 1 }
      }
      if i < b.count, b[i] == 0x65 || b[i] == 0x45 {
        i += 1
        if i < b.count, b[i] == 0x2B || b[i] == 0x2D { i += 1 }
        guard i < b.count, (0x30...0x39).contains(b[i]) else { throw JSONParseError() }
        while i < b.count, (0x30...0x39).contains(b[i]) { i += 1 }
      }
      guard let d = Double(String(decoding: b[start..<i], as: UTF8.self)) else { throw JSONParseError() }
      return d
    }
  }
}

// MARK: - Foundation bridge (Expo passes [String: Any] / [Any])

extension JSONValue {
  /// From JSONSerialization / Expo values. Dictionary key order is not preserved (sorted for
  /// determinism); callers that need an order rebuild the object through a typed model.
  public init(any: Any?) throws {
    switch any {
    case nil, is NSNull: self = .null
    case let n as NSNumber:
      if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
    case let b as Bool: self = .bool(b)
    case let s as String: self = .string(s)
    case let a as [Any?]: self = .array(try a.map { try JSONValue(any: $0) })
    case let d as [String: Any?]:
      self = .object(try d.keys.sorted().map { ($0, try JSONValue(any: d[$0] ?? nil)) })
    default: throw VaultCoreError(.invalidInput, "unsupported value")
    }
  }

  /// To Foundation values for Expo (objects become dictionaries).
  public var anyValue: Any {
    switch self {
    case .null: return NSNull()
    case let .bool(b): return b
    case let .number(n): return n == n.rounded() && abs(n) <= 9_007_199_254_740_991 ? Int(n) as Any : n
    case let .string(s): return s
    case let .array(a): return a.map(\.anyValue)
    case let .object(kv):
      var d: [String: Any] = [:]
      for (k, v) in kv { d[k] = v.anyValue }
      return d
    }
  }
}
