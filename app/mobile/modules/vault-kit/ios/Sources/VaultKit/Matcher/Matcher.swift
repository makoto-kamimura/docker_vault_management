// Host normalisation, Public Suffix List and candidate matching — spec §9.1.
// Ports of core/src/matcher/punycode.ts, psl.ts and match.ts.
import Foundation

public enum Punycode {
  static let base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700, initialBias = 72, initialN = 128

  static func adapt(_ delta: Int, _ numPoints: Int, _ first: Bool) -> Int {
    var d = first ? delta / damp : delta >> 1
    d += d / numPoints
    var k = 0
    while d > ((base - tMin) * tMax) >> 1 {
      d /= base - tMin
      k += base
    }
    return k + ((base - tMin + 1) * d) / (d + skew)
  }

  static func digit(_ d: Int) -> Character { Character(Unicode.Scalar(UInt8(d < 26 ? 97 + d : 22 + d))) }

  /// RFC 3492 encoding of one label (without the `xn--` prefix).
  public static func encode(_ input: String) -> String {
    let cps = input.unicodeScalars.map { Int($0.value) }
    var out = ""
    for c in cps where c < initialN { out.append(Character(Unicode.Scalar(UInt8(c)))) }
    let basic = out.count
    var h = basic
    if basic > 0 { out.append("-") }
    var n = initialN, delta = 0, bias = initialBias
    while h < cps.count {
      var m = Int.max
      for c in cps where c >= n && c < m { m = c }
      delta += (m - n) * (h + 1)
      n = m
      for c in cps {
        if c < n { delta += 1 }
        if c == n {
          var q = delta
          var k = base
          while true {
            let t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias
            if q < t { break }
            out.append(digit(t + (q - t) % (base - t)))
            q = (q - t) / (base - t)
            k += base
          }
          out.append(digit(q))
          bias = adapt(delta, h + 1, h == basic)
          delta = 0
          h += 1
        }
      }
      delta += 1
      n += 1
    }
    return out
  }

  static let delimiters: Set<Character> = ["/", "\\", "?", "#", "@", ":", "%", "[", "]"]

  static func hasForbiddenChar(_ label: String) -> Bool {
    for u in label.unicodeScalars {
      if u.value <= 0x20 || u.value == 0x7F || delimiters.contains(Character(u)) || Crockford.isJSWhitespace(u) { return true }
    }
    return false
  }

  /// Lower-case ASCII (Punycode) host, or nil if it is not a plausible host. One trailing dot is
  /// removed; ideographic full stops count as dots; ports are NOT handled here.
  public static func toAsciiHost(_ host: String) -> String? {
    var h = host.nfkc.lowercased().replacingOccurrences(of: "。", with: ".")
    if h.hasSuffix(".") { h.removeLast() }
    if h.isEmpty { return nil }
    var labels: [String] = []
    for label in h.split(separator: ".", omittingEmptySubsequences: false).map(String.init) {
      if label.isEmpty || hasForbiddenChar(label) { return nil }
      let ascii = label.utf8.allSatisfy({ $0 < 0x80 }) ? label : "xn--" + encode(label)
      let ok = ascii.utf8.allSatisfy { (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x5F || $0 == 0x2D }
      if !ok || ascii.utf8.count > 63 { return nil }
      labels.append(ascii)
    }
    let r = labels.joined(separator: ".")
    return r.utf8.count > 253 ? nil : r
  }
}

public final class PublicSuffixList: @unchecked Sendable {
  private var normal = Set<String>()
  private var wildcard = Set<String>()
  private var exception = Set<String>()

  public static let shared: PublicSuffixList = .fromCompact(PSLData.compact)

  public static func fromRules<S: Sequence>(_ rules: S) -> PublicSuffixList where S.Element == String {
    let p = PublicSuffixList()
    for r in rules { p.add(r) }
    return p
  }

  public static func fromCompact(_ compact: String) -> PublicSuffixList {
    fromRules(compact.split(separator: " ").map(String.init).filter { !$0.isEmpty })
  }

  private func add(_ rule: String) {
    var body = rule
    var kind = 0
    if body.hasPrefix("!") { kind = 2; body.removeFirst() } else if body.hasPrefix("*.") { kind = 1; body.removeFirst(2) }
    guard let ascii = Punycode.toAsciiHost(body) else { return }
    switch kind {
    case 0: normal.insert(ascii)
    case 1: wildcard.insert(ascii)
    default: exception.insert(ascii)
    }
  }

  public var size: Int { normal.count + wildcard.count + exception.count }

  private func suffixLabelCount(_ labels: [Substring]) -> Int? {
    let n = labels.count
    var best = 0
    for i in 0..<n {
      let suffix = labels[i...].joined(separator: ".")
      if exception.contains(suffix) { return n - i - 1 }
      if normal.contains(suffix) { best = max(best, n - i) }
      if i + 1 < n && wildcard.contains(labels[(i + 1)...].joined(separator: ".")) { best = max(best, n - i) }
    }
    return best > 0 ? best : nil
  }

  /// eTLD+1 of a normalised ASCII host; nil for IPs, unknown TLDs and public suffixes themselves.
  public func registrableDomain(_ host: String) -> String? {
    if Matcher.isIpHost(host) { return nil }
    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    guard let count = suffixLabelCount(labels), labels.count > count else { return nil }
    return labels[(labels.count - count - 1)...].joined(separator: ".")
  }
}

public struct ParsedUrl: Sendable, Equatable {
  public var scheme: String
  public var host: String
}

public enum MatchRank: String, Sendable { case host, domain }

public struct MatchCandidate: Sendable, Equatable {
  public var id: String
  public var rank: MatchRank
  public var urlIndex: Int
  public var requestHost: String
}

public struct MatchEntry: Sendable {
  public var id: String
  public var urls: [UrlEntry]
  public var lastUsedAt: String?
  public var trashedAt: String?
  public init(id: String, urls: [UrlEntry], lastUsedAt: String? = nil, trashedAt: String? = nil) {
    self.id = id; self.urls = urls; self.lastUsedAt = lastUsedAt; self.trashedAt = trashedAt
  }
}

public enum Matcher {
  /// IPv4 literal or bracketed IPv6 literal.
  public static func isIpHost(_ host: String) -> Bool {
    if host.hasPrefix("[") && host.hasSuffix("]") { return true }
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return false }
    for p in parts {
      // (25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d) — no leading zeros, 0...255.
      guard !p.isEmpty, p.count <= 3, p.utf8.allSatisfy({ (0x30...0x39).contains($0) }) else { return false }
      if p.count > 1 && p.hasPrefix("0") { return false }
      guard let v = Int(p), v <= 255 else { return false }
    }
    return true
  }

  /// Index of the ":" of a leading `^[a-z][a-z0-9+.-]*://` (case-insensitive), or nil.
  static func schemeEnd(_ s: String) -> String.Index? {
    let u = Array(s.utf8)
    func alpha(_ c: UInt8) -> Bool { (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) }
    guard let f = u.first, alpha(f) else { return nil }
    var i = 1
    while i < u.count, alpha(u[i]) || (0x30...0x39).contains(u[i]) || u[i] == 0x2B || u[i] == 0x2E || u[i] == 0x2D { i += 1 }
    guard i + 2 < u.count, u[i] == 0x3A, u[i + 1] == 0x2F, u[i + 2] == 0x2F else { return nil }
    return s.utf8.index(s.utf8.startIndex, offsetBy: i)
  }

  static func hasScheme(_ s: String) -> Bool { schemeEnd(s) != nil }

  /// Scheme (lower-case) and normalised host; port, path and credentials are dropped.
  public static func parseUrl(_ input: String) -> ParsedUrl? {
    let t = input.jsTrimmed
    guard let colon = schemeEnd(t) else { return nil }
    let scheme = String(t[..<colon]).lowercased()
    let afterSlashes = t.utf8.index(colon, offsetBy: 3)
    var authority = String(t[afterSlashes...].prefix { $0 != "/" && $0 != "?" && $0 != "#" })
    if let at = authority.lastIndex(of: "@") { authority = String(authority[authority.index(after: at)...]) }
    if authority.hasPrefix("[") {
      guard let end = authority.firstIndex(of: "]") else { return nil }
      let port = authority[authority.index(after: end)...]
      if !port.isEmpty {
        guard port.hasPrefix(":"), port.dropFirst().utf8.allSatisfy({ (0x30...0x39).contains($0) }) else { return nil }
      }
      return ParsedUrl(scheme: scheme, host: String(authority[...end]).lowercased())
    }
    var hostPart = authority
    if let c = authority.lastIndex(of: ":") {
      guard authority[authority.index(after: c)...].utf8.allSatisfy({ (0x30...0x39).contains($0) }) else { return nil }
      hostPart = String(authority[..<c])
    }
    guard let host = Punycode.toAsciiHost(hostPart) else { return nil }
    return ParsedUrl(scheme: scheme, host: host)
  }

  /// Host of a stored URL entry; a missing scheme is read as https.
  public static func hostOfStoredUrl(_ url: String) -> String? {
    let t = url.jsTrimmed
    return parseUrl(hasScheme(t) ? url : "https://" + t)?.host
  }

  /// Ranked candidates; only https requests match. Exact hosts first, then registrable domains,
  /// then most recently used, then input order.
  public static func match(_ psl: PublicSuffixList, requestUrl: String, entries: [MatchEntry]) -> [MatchCandidate] {
    guard let req = parseUrl(requestUrl), req.scheme == "https" else { return [] }
    let reqDomain = isIpHost(req.host) ? nil : psl.registrableDomain(req.host)
    var found: [(c: MatchCandidate, lastUsed: String, order: Int)] = []
    for (order, e) in entries.enumerated() {
      if let t = e.trashedAt, !t.isEmpty { continue }
      var best: MatchCandidate?
      for (i, u) in e.urls.enumerated() {
        guard let host = hostOfStoredUrl(u.url) else { continue }
        var rank: MatchRank?
        if host == req.host {
          rank = .host
        } else if u.match == "domain", let rd = reqDomain, psl.registrableDomain(host) == rd {
          rank = .domain
        }
        guard let r = rank else { continue }
        if best == nil || (r == .host && best!.rank == .domain) {
          best = MatchCandidate(id: e.id, rank: r, urlIndex: i, requestHost: req.host)
        }
      }
      if let b = best { found.append((b, e.lastUsedAt ?? "", order)) }
    }
    found.sort { a, b in
      if a.c.rank != b.c.rank { return a.c.rank == .host }
      if a.lastUsed != b.lastUsed { return a.lastUsed > b.lastUsed }
      return a.order < b.order
    }
    return found.map(\.c)
  }
}
