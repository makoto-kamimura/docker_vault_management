// Password generator (FR-23), attempt throttle (FR-12) and list search (FR-22).
// Ports of core/src/generator.ts, throttle.ts and search.ts.
import Foundation

public struct GeneratorOptions: Sendable, Equatable {
  public var length: Int
  public var upper: Bool
  public var lower: Bool
  public var digits: Bool
  public var symbols: Bool
  /// Exclude look-alike characters (`Il1|O0o`).
  public var excludeAmbiguous: Bool

  public init(length: Int = 20, upper: Bool = true, lower: Bool = true, digits: Bool = true, symbols: Bool = true, excludeAmbiguous: Bool = false) {
    self.length = length; self.upper = upper; self.lower = lower; self.digits = digits
    self.symbols = symbols; self.excludeAmbiguous = excludeAmbiguous
  }
}

public enum Generator {
  public static let minLength = 8
  public static let maxLength = 64
  static let classes: [(KeyPath<GeneratorOptions, Bool>, String)] = [
    (\.upper, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"), (\.lower, "abcdefghijklmnopqrstuvwxyz"),
    (\.digits, "0123456789"), (\.symbols, "!@#$%^&*()-_=+[]{};:,.?"),
  ]
  static let ambiguous = "Il1|O0o"

  static func alphabets(_ o: GeneratorOptions) -> [[Character]] {
    classes.filter { o[keyPath: $0.0] }.map { k in
      Array(o.excludeAmbiguous ? k.1.filter { !ambiguous.contains($0) } : k.1)
    }.filter { !$0.isEmpty }
  }

  /// Uniform integers in [0, n) without modulo bias (rejection sampling over random bytes).
  final class Uniform {
    let p: CryptoProvider
    var buf: Bytes = []
    var pos = 0
    init(_ p: CryptoProvider) { self.p = p }

    func byte() throws -> Int {
      if pos >= buf.count { buf = try p.randomBytes(256); pos = 0 }
      defer { pos += 1 }
      return Int(buf[pos])
    }

    func below(_ n: Int) throws -> Int {
      let limit = 256 - (256 % n)
      while true {
        let b = try byte()
        if b < limit { return b % n }
      }
    }
  }

  public static func generate(_ p: CryptoProvider, _ o: GeneratorOptions) throws -> String {
    guard o.length >= minLength, o.length <= maxLength else { throw VaultCoreError(.invalidInput, "password length must be 8-64") }
    let alphas = alphabets(o)
    guard !alphas.isEmpty else { throw VaultCoreError(.invalidInput, "select at least one class") }
    let all = alphas.flatMap { $0 }
    let rnd = Uniform(p)
    var chars: [Character] = []
    for a in alphas { chars.append(a[try rnd.below(a.count)]) }
    while chars.count < o.length { chars.append(all[try rnd.below(all.count)]) }
    var i = chars.count - 1
    while i > 0 {
      let j = try rnd.below(i + 1)
      chars.swapAt(i, j)
      i -= 1
    }
    return String(chars)
  }
}

public enum Throttle {
  public static let freeAttempts = 5
  public static let baseSec = 30
  public static let maxSec = 15 * 60

  /// 5 failures -> 30 s; each further failure doubles, capped at 15 min.
  public static func waitSec(_ failedCount: Int) -> Int {
    guard failedCount >= freeAttempts else { return 0 }
    let d = min(failedCount - freeAttempts, 10)
    return min(baseSec * (1 << d), maxSec)
  }

  public static func attemptsBeforeThrottle(_ failedCount: Int) -> Int { max(0, freeAttempts - failedCount) }

  public static func state(failedCount: Int, lastFailureAtMs: Double?, nowMs: Double) -> (failedCount: Int, retryAfterSec: Int) {
    let wait = waitSec(failedCount)
    guard wait > 0, let last = lastFailureAtMs else { return (failedCount, 0) }
    let remainingMs = last + Double(wait * 1000) - nowMs
    return (failedCount, max(0, Int((remainingMs / 1000).rounded(.up))))
  }
}

public enum Search {
  /// NFKC folds full-width forms to half-width; then lower-case.
  public static func normalize(_ s: String) -> String { s.nfkc.lowercased() }

  /// Every whitespace-separated token of `query` must appear in at least one haystack.
  public static func matches(_ query: String, _ haystacks: [String]) -> Bool {
    let tokens = normalize(query).unicodeScalars.split(whereSeparator: Crockford.isJSWhitespace).map { String(String.UnicodeScalarView($0)) }
      .filter { !$0.isEmpty }
    if tokens.isEmpty { return true }
    let hs = haystacks.map(normalize)
    // JS `includes` compares UTF-16 code units; `.literal` does the same (no grapheme folding).
    return tokens.allSatisfy { t in hs.contains { $0.range(of: t, options: .literal) != nil } }
  }
}
