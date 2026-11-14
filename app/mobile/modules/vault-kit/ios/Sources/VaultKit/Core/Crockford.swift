// Crockford Base32, recovery key (§5.5). Port of core/src/crockford.ts and recovery-key.ts.

public enum Crockford {
  public static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".utf8)

  /// MSB-first; the final partial group is zero-padded. 16 bytes -> 26 chars.
  public static func encode(_ bytes: Bytes) -> String {
    var out = [UInt8]()
    var acc = 0
    var bits = 0
    for b in bytes {
      acc = (acc << 8) | Int(b)
      bits += 8
      while bits >= 5 {
        bits -= 5
        out.append(alphabet[(acc >> bits) & 31])
      }
      acc &= (1 << bits) - 1
    }
    if bits > 0 { out.append(alphabet[(acc << (5 - bits)) & 31]) }
    return String(decoding: out, as: UTF8.self)
  }

  /// Canonical characters into exactly `byteLength` bytes; nil for a bad character, length or
  /// non-zero padding bits.
  public static func decode(_ text: String, byteLength: Int) -> Bytes? {
    let u = Array(text.utf8)
    guard u.count == (byteLength * 8 + 4) / 5, text.utf16.count == u.count else { return nil }
    var out = Bytes()
    out.reserveCapacity(byteLength)
    var acc = 0
    var bits = 0
    for c in u {
      guard let v = alphabet.firstIndex(of: c) else { return nil }
      acc = (acc << 5) | v
      bits += 5
      if bits >= 8 {
        bits -= 8
        out.append(UInt8((acc >> bits) & 0xFF))
        acc &= (1 << bits) - 1
      }
    }
    return acc == 0 ? out : nil
  }

  /// Two check characters from the first 10 bits of SHA-256(secret).
  public static func checkChars(_ p: CryptoProvider, _ secret: Bytes) -> String {
    let h = p.sha256(secret)
    return String(decoding: [alphabet[Int(h[0] >> 3)], alphabet[Int((h[0] & 7) << 2 | h[1] >> 6)]], as: UTF8.self)
  }

  /// Lenient reading: case-insensitive, hyphens and whitespace ignored, I/L -> 1, O -> 0. The
  /// `prefix` (e.g. "LV2") is removed BEFORE the letter mapping because it contains an L.
  public static func normalize(_ input: String, prefix: String, bodyLength: Int) -> String? {
    var s = String(input.uppercased().unicodeScalars.filter { !isJSWhitespace($0) && $0 != "-" })
    if s.utf16.count == prefix.utf16.count + bodyLength && s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
    s = s.replacingOccurrences(of: "I", with: "1").replacingOccurrences(of: "L", with: "1")
      .replacingOccurrences(of: "O", with: "0")
    return s.utf8.allSatisfy({ alphabet.contains($0) }) && s.utf8.count == s.utf16.count ? s : nil
  }

  public static func groupBy(_ text: String, _ size: Int) -> String {
    let c = Array(text)
    return stride(from: 0, to: c.count, by: size).map { String(c[$0..<min($0 + size, c.count)]) }.joined(separator: "-")
  }

  /// JS `\s` (WhiteSpace + LineTerminator).
  static func isJSWhitespace(_ u: Unicode.Scalar) -> Bool {
    switch u.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
      return true
    default:
      return false
    }
  }
}

public enum RecoveryKey {
  static let dataChars = 26
  static let totalChars = 28
  static let prefix = "LV2"

  public static func generate(_ p: CryptoProvider) throws -> Bytes { try p.randomBytes(ByteSize.uuid) }

  /// `LV2-XXXX-…` display form of 16 key bytes.
  public static func format(_ p: CryptoProvider, _ sk: Bytes) throws -> String {
    guard sk.count == ByteSize.uuid else { throw VaultCoreError(.invalidInput, "recovery key must be 16 bytes") }
    return prefix + "-" + Crockford.groupBy(Crockford.encode(sk) + Crockford.checkChars(p, sk), 4)
  }

  /// Lenient parse; `E_INVALID_RECOVERY_KEY` for any malformed input or check mismatch.
  public static func parse(_ p: CryptoProvider, _ input: String) throws -> Bytes {
    let invalid = VaultCoreError(.invalidRecoveryKey, "recovery key is not valid")
    guard let body = Crockford.normalize(input, prefix: prefix, bodyLength: totalChars), body.count == totalChars
    else { throw invalid }
    guard let sk = Crockford.decode(String(body.prefix(dataChars)), byteLength: ByteSize.uuid) else { throw invalid }
    guard Crockford.checkChars(p, sk) == String(body.suffix(totalChars - dataChars)) else { throw invalid }
    return sk
  }
}
