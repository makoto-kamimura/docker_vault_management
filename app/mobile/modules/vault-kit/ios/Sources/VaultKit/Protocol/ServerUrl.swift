// Server URL policy and QR codecs (port of protocol/src/qr.ts).

public enum ServerUrlFailure: String, Error, Sendable { case invalid, notHttps = "not_https", hasPath = "has_path", hasCredentials = "has_credentials" }

public enum ServerUrl {
  /// G11: development builds may use http on these hosts.
  public static let insecureAllowedHosts = ["localhost", "127.0.0.1", "10.0.2.2"]

  static func isHostLabelChar(_ c: UInt8) -> Bool { (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || (0x30...0x39).contains(c) }

  /// `^(?:\[[0-9a-fA-F:.]+\]|label(\.label)*)$`, label = `[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?`
  static func validHost(_ h: String) -> Bool {
    let u = Array(h.utf8)
    guard !u.isEmpty else { return false }
    if u.first == 0x5B {
      guard u.count >= 3, u.last == 0x5D else { return false }
      return u[1..<(u.count - 1)].allSatisfy { (0x30...0x39).contains($0) || (0x41...0x46).contains($0) || (0x61...0x66).contains($0) || $0 == 0x3A || $0 == 0x2E }
    }
    for label in h.split(separator: ".", omittingEmptySubsequences: false) {
      let l = Array(label.utf8)
      guard let f = l.first, let last = l.last, isHostLabelChar(f), isHostLabelChar(last) else { return false }
      guard l.allSatisfy({ isHostLabelChar($0) || $0 == 0x2D }) else { return false }
    }
    return true
  }

  /// Normalised origin (lower-case host, default port removed, no trailing slash) or a reason.
  public static func parse(_ input: String, allowInsecureLocalhost: Bool = false) -> Result<String, ServerUrlFailure> {
    guard let colon = Matcher.schemeEnd(input) else { return .failure(.invalid) }
    let scheme = String(input[..<colon]).lowercased()
    let after = input[input.utf8.index(colon, offsetBy: 3)...]
    let authority = String(after.prefix { $0 != "/" && $0 != "?" && $0 != "#" })
    let rest = String(after.dropFirst(authority.count))
    guard scheme == "https" || scheme == "http" else { return .failure(.notHttps) }
    if authority.contains("@") { return .failure(.hasCredentials) }
    if !rest.isEmpty && rest != "/" { return .failure(.hasPath) }
    // ^(\[[^\]]*\]|[^:]*)(?::(\d{1,5}))?$
    var hostPart = authority
    var portStr: String?
    if authority.hasPrefix("[") {
      guard let close = authority.firstIndex(of: "]") else { return .failure(.invalid) }
      hostPart = String(authority[...close])
      let tail = authority[authority.index(after: close)...]
      if !tail.isEmpty {
        guard tail.hasPrefix(":") else { return .failure(.invalid) }
        portStr = String(tail.dropFirst())
      }
    } else if let c = authority.firstIndex(of: ":") {
      hostPart = String(authority[..<c])
      portStr = String(authority[authority.index(after: c)...])
    }
    if let p = portStr {
      guard (1...5).contains(p.utf8.count), p.utf8.allSatisfy({ (0x30...0x39).contains($0) }) else { return .failure(.invalid) }
    }
    let host = hostPart.lowercased()
    guard !host.isEmpty, host.utf8.allSatisfy({ $0 < 0x80 }), validHost(host) else { return .failure(.invalid) }
    var port: Int?
    if let p = portStr {
      port = Int(p)
      guard let v = port, v >= 1, v <= 65535 else { return .failure(.invalid) }
    }
    if scheme == "http" {
      guard allowInsecureLocalhost, insecureAllowedHosts.contains(host) else { return .failure(.notHttps) }
    }
    let defaultPort = scheme == "https" ? 443 : 80
    let hostPort = port == nil || port == defaultPort ? host : "\(host):\(port!)"
    return .success("\(scheme)://\(hostPort)")
  }
}

public struct QrParseError: Error, Sendable { public let message: String }

public enum QrCodec {
  static func parseQuery(_ prefix: String, _ input: String, keys: [String]) throws -> [String: String] {
    guard input.hasPrefix(prefix) else { throw QrParseError(message: "wrong scheme or version") }
    var out: [String: String] = [:]
    for part in input.dropFirst(prefix.count).components(separatedBy: "&") {
      guard let eq = part.firstIndex(of: "="), eq != part.startIndex else { throw QrParseError(message: "malformed query") }
      let k = String(part[..<eq])
      let v = String(part[part.index(after: eq)...])
      guard keys.contains(k) else { throw QrParseError(message: "unexpected key \(k)") }
      guard out[k] == nil else { throw QrParseError(message: "duplicate key \(k)") }
      guard !v.isEmpty else { throw QrParseError(message: "empty value for \(k)") }
      out[k] = v
    }
    for k in keys where out[k] == nil { throw QrParseError(message: "missing key \(k)") }
    return out
  }

  static func encodeServer(_ origin: String, insecure: Bool) throws -> String {
    guard case let .success(o) = ServerUrl.parse(origin, allowInsecureLocalhost: insecure) else { throw QrParseError(message: "invalid server url") }
    return Base64Url.encode(Array(o.utf8))
  }

  static func decodeServer(_ s: String, insecure: Bool) throws -> String {
    guard let b = try? Base64Url.decode(s), let url = try? UTF8Bytes.decode(b) else { throw QrParseError(message: "invalid server field") }
    guard case let .success(o) = ServerUrl.parse(url, allowInsecureLocalhost: insecure) else { throw QrParseError(message: "invalid server url") }
    guard o == url else { throw QrParseError(message: "server url is not normalised") }
    return o
  }

  // lvpair (§8.3)
  public static func parsePair(_ input: String, insecure: Bool) throws -> (serverOrigin: String, pairingId: String, fingerprint: String) {
    let q = try parseQuery("lvpair:v1?", input, keys: ["s", "p", "f"])
    guard UUIDBytes.isValid(q["p"]!) else { throw QrParseError(message: "invalid pairing id") }
    guard Base64Url.isValid(q["f"]!, byteLength: ByteSize.fingerprint) else { throw QrParseError(message: "invalid fingerprint") }
    return (try decodeServer(q["s"]!, insecure: insecure), q["p"]!, q["f"]!)
  }

  // lvrc (§8.11.2)
  public static func formatRc(serverUrl: String, accountId: String, rc: String, insecure: Bool) throws -> String {
    guard UUIDBytes.isValid(accountId) else { throw QrParseError(message: "invalid account id") }
    guard Base64Url.isValid(rc, byteLength: ByteSize.rc) else { throw QrParseError(message: "invalid recovery code") }
    return "lvrc:v1?s=\(try encodeServer(serverUrl, insecure: insecure))&a=\(accountId)&c=\(rc)"
  }

  public static func parseRc(_ input: String, insecure: Bool) throws -> (serverUrl: String, accountId: String, rc: String) {
    let q = try parseQuery("lvrc:v1?", input, keys: ["s", "a", "c"])
    guard UUIDBytes.isValid(q["a"]!) else { throw QrParseError(message: "invalid account id") }
    guard Base64Url.isValid(q["c"]!, byteLength: ByteSize.rc) else { throw QrParseError(message: "invalid recovery code") }
    return (try decodeServer(q["s"]!, insecure: insecure), q["a"]!, q["c"]!)
  }
}
