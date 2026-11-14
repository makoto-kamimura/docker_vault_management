// Byte helpers (port of app/packages/core/src/bytes.ts and protocol/src/base64url.ts).
// Behaviour must match the TS reference exactly: strict unpadded base64url, lower-case hex.

public typealias Bytes = [UInt8]

public enum Hex {
  private static let digits = Array("0123456789abcdef".utf8)

  public static func encode(_ bytes: Bytes) -> String {
    var out = [UInt8]()
    out.reserveCapacity(bytes.count * 2)
    for b in bytes {
      out.append(digits[Int(b >> 4)])
      out.append(digits[Int(b & 15)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Lower-case only, even length; anything else is `E_INVALID_INPUT`.
  public static func decode(_ hex: String) throws -> Bytes {
    let u = Array(hex.utf8)
    guard u.count % 2 == 0 else { throw VaultCoreError(.invalidInput, "invalid hex") }
    func nib(_ c: UInt8) throws -> UInt8 {
      switch c {
      case 0x30...0x39: return c - 0x30
      case 0x61...0x66: return c - 0x61 + 10
      default: throw VaultCoreError(.invalidInput, "invalid hex")
      }
    }
    var out = Bytes()
    out.reserveCapacity(u.count / 2)
    var i = 0
    while i < u.count {
      out.append(try nib(u[i]) << 4 | nib(u[i + 1]))
      i += 2
    }
    return out
  }
}

public struct Base64UrlError: Error, Sendable, Equatable {
  public let message: String
}

public enum Base64Url {
  private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".utf8)
  private static let lookup: [Int8] = {
    var t = [Int8](repeating: -1, count: 128)
    for (i, c) in alphabet.enumerated() { t[Int(c)] = Int8(i) }
    return t
  }()

  /// Unpadded base64url.
  public static func encode(_ bytes: Bytes) -> String {
    var out = [UInt8]()
    out.reserveCapacity((bytes.count + 2) / 3 * 4)
    var i = 0
    while i + 2 < bytes.count {
      let n = Int(bytes[i]) << 16 | Int(bytes[i + 1]) << 8 | Int(bytes[i + 2])
      out.append(alphabet[(n >> 18) & 63])
      out.append(alphabet[(n >> 12) & 63])
      out.append(alphabet[(n >> 6) & 63])
      out.append(alphabet[n & 63])
      i += 3
    }
    let rest = bytes.count - i
    if rest == 1 {
      let n = Int(bytes[i]) << 16
      out.append(alphabet[(n >> 18) & 63])
      out.append(alphabet[(n >> 12) & 63])
    } else if rest == 2 {
      let n = Int(bytes[i]) << 16 | Int(bytes[i + 1]) << 8
      out.append(alphabet[(n >> 18) & 63])
      out.append(alphabet[(n >> 12) & 63])
      out.append(alphabet[(n >> 6) & 63])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Strict decoding: rejects padding, `+` `/`, whitespace, other characters, impossible lengths
  /// and non-canonical encodings (non-zero trailing bits). "" decodes to [].
  public static func decode(_ input: String) throws -> Bytes {
    let u = Array(input.utf8)
    if u.count % 4 == 1 { throw Base64UrlError(message: "invalid base64url length") }
    var out = Bytes()
    out.reserveCapacity(u.count * 6 / 8)
    var acc = 0
    var bits = 0
    for c in u {
      let v = c < 128 ? Int(lookup[Int(c)]) : -1
      if v < 0 { throw Base64UrlError(message: "invalid base64url character") }
      acc = (acc << 6) | v
      bits += 6
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((acc >> bits) & 0xFF))
        acc &= (1 << bits) - 1
      }
    }
    if acc != 0 { throw Base64UrlError(message: "non-canonical base64url (trailing bits)") }
    return out
  }

  public static func isValid(_ s: String, byteLength: Int? = nil) -> Bool {
    guard let d = try? decode(s) else { return false }
    return byteLength == nil || d.count == byteLength
  }
}

public enum UTF8Bytes {
  public static func encode(_ s: String) -> Bytes { Array(s.utf8) }

  /// Throws `E_INVALID_INPUT` on invalid UTF-8 (the TS decoder is `fatal: true`).
  public static func decode(_ b: Bytes) throws -> String {
    // String(decoding:) repairs invalid sequences with U+FFFD; a lossless round trip means valid.
    let s = String(decoding: b, as: UTF8.self)
    guard Array(s.utf8) == b else { throw VaultCoreError(.invalidInput, "invalid utf-8") }
    return s
  }
}

public func concatBytes(_ parts: Bytes...) -> Bytes {
  var out = Bytes()
  out.reserveCapacity(parts.reduce(0) { $0 + $1.count })
  for p in parts { out.append(contentsOf: p) }
  return out
}

/// Constant-time comparison for equal-length secrets.
public func constantTimeEqual(_ a: Bytes, _ b: Bytes) -> Bool {
  guard a.count == b.count else { return false }
  var diff: UInt8 = 0
  for i in 0..<a.count { diff |= a[i] ^ b[i] }
  return diff == 0
}

/// Best-effort wipe of secret buffers.
public func wipe(_ buffers: inout Bytes) {
  for i in buffers.indices { buffers[i] = 0 }
}

public enum UUIDBytes {
  /// Lower-case UUID v4, exactly the protocol's uuidSchema:
  /// `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
  public static func isValid(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count == 36 else { return false }
    for (i, c) in u.enumerated() {
      if i == 8 || i == 13 || i == 18 || i == 23 {
        if c != 0x2D { return false }
      } else if !((0x30...0x39).contains(c) || (0x61...0x66).contains(c)) {
        return false
      }
    }
    return u[14] == 0x34 && [0x38, 0x39, 0x61, 0x62].contains(u[19])
  }

  public static func toBytes(_ uuid: String) throws -> Bytes {
    guard isValid(uuid) else { throw VaultCoreError(.invalidInput, "invalid uuid") }
    return try Hex.decode(uuid.replacingOccurrences(of: "-", with: ""))
  }

  public static func fromBytes(_ b: Bytes) throws -> String {
    guard b.count == 16 else { throw VaultCoreError(.invalidInput, "uuid needs 16 bytes") }
    let h = Array(Hex.encode(b))
    return String(h[0..<8]) + "-" + String(h[8..<12]) + "-" + String(h[12..<16]) + "-"
      + String(h[16..<20]) + "-" + String(h[20...])
  }

  /// Fix the version/variant bits of 16 random bytes and format as a UUID v4.
  public static func v4(fromRandom random: Bytes) throws -> String {
    guard random.count == 16 else { throw VaultCoreError(.invalidInput, "uuid needs 16 bytes") }
    var b = random
    b[6] = (b[6] & 0x0F) | 0x40
    b[8] = (b[8] & 0x3F) | 0x80
    return try fromBytes(b)
  }
}

extension String {
  /// JS `String#trim()`: strips WhiteSpace and LineTerminator code points (incl. U+FEFF).
  public var jsTrimmed: String {
    let scalars = unicodeScalars
    guard let first = scalars.firstIndex(where: { !Crockford.isJSWhitespace($0) }) else { return "" }
    let last = scalars.lastIndex(where: { !Crockford.isJSWhitespace($0) })!
    return String(scalars[first...last])
  }
}

extension String {
  /// Unicode NFKC as JS `normalize('NFKC')` produces it. Foundation's compatibility mapping can
  /// leave a canonical composition undone (e.g. half-width "ｶﾞ" stays U+30AB U+3099 instead of
  /// U+30AC), so canonical composition (NFC) is applied afterwards; NFC(NFKC(x)) == NFKC(x).
  /// This feeds the master-password KDF, so it must match the TS reference exactly.
  public var nfkc: String { precomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping }
}
