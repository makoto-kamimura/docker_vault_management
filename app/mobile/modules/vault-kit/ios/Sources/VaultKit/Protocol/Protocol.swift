// Constants and exact string builders of @localvault/protocol (limits.ts, strings.ts,
// account-name.ts). Every value here must stay identical to the TS package.
import Foundation

public enum Limits {
  public static let maxRecordsPerAccount = 10_000
  public static let maxCiphertextBytes = 64 * 1024
  public static let maxRecordsPerBatch = 100
  public static let maxRecordsPerRotationChunk = 100
  public static let kdfMinIterations = 600_000
  public static let kdfMaxIterations = 10_000_000
  public static let rcWaitSec = [86_400, 172_800, 259_200]
  public static let rcWaitDefaultSec = 172_800
  public static let pcSessionMaxSec = [0, 900, 3600, 28_800]
  public static let pcSessionDefaultSec = 3600
  public static let unlockCodeMin = 10
  public static let unlockCodeMax = 99
  public static let unlockCodeMaxAttempts = 3
}

/// §6.1 field limits. Lengths are UTF-16 code units (JS `string.length`).
public enum Field {
  public static let titleMin = 1
  public static let titleMax = 100
  public static let usernameMax = 256
  public static let passwordMax = 1024
  public static let urlsMax = 20
  public static let urlMax = 2048
  public static let androidAppsMax = 20
  public static let androidCertsMax = 10
  public static let androidLabelMax = 100
  public static let notesMax = 10_000
  public static let deviceNameMin = 1
  public static let deviceNameMax = 64
  public static let passwordHistoryMax = 5
  public static let accountNameMin = 3
  public static let accountNameMax = 32
  public static let masterPasswordMin = 10
  public static let exportPasswordMin = 10
  public static let inviteCodeMax = 128
}

/// Sizes in bytes of binary fields.
public enum ByteSize {
  public static let uuid = 16
  public static let nonce = 12
  public static let gcmTag = 16
  public static let vk = 32
  public static let authKey = 32
  public static let verifier = 32
  public static let challenge = 32
  public static let kdfSalt = 16
  public static let signPub = 65
  public static let ephPub = 65
  public static let sig = 64
  public static let requestNonce = 16
  public static let adminNonce = 16
  public static let pollToken = 32
  public static let claimToken = 32
  public static let rcId = 16
  public static let rc = 32
  public static let authRC = 32
  public static let wrappedVkCt = 48
  public static let fingerprint = 32
}

public enum TTLSec {
  public static let pairing = 5 * 60
  public static let unlockRequest = 120
  public static let authChallenge = 60
  public static let unlockIssuedAtWindow = 5 * 60
  public static let unlockNonceMemory = 24 * 3600
  public static let trash = 30 * 86_400
  public static let clockSkewWindow = 5 * 60
  public static let adminTsWindow = 5 * 60
}

/// Fixed id of the singleton meta record (§6.2).
public let metaRecordId = "00000000-0000-4000-8000-000000000001"

public enum Strings {
  public static let authSignTag = "lv-auth-v2"
  public static let unlockSignTag = "lv-unlock-v2"
  public static let adminSignTag = "lv-admin-v2"

  public enum HKDFInfo {
    public static let kek = "localvault/v2/kek"
    public static let auth = "localvault/v2/auth"
    public static let rcId = "localvault/v2/rc-id"
    public static let rcKek = "localvault/v2/rc-kek"
    public static let rcAuth = "localvault/v2/rc-auth"
  }

  public static func sealHkdfInfo(_ ctx: String) -> String { "localvault/v2/seal|\(ctx)" }
  public static func sealContextPair(_ pairingId: String) -> String { "pair|\(pairingId)" }
  public static func sealContextUnlock(_ requestId: String) -> String { "unlock|\(requestId)" }

  public static func vkAad(_ accountId: String, _ keysetVersion: Int) -> String {
    "lv|v2|vk|\(accountId)|\(keysetVersion)"
  }
  public static func recordAad(_ accountId: String, _ recordId: String, _ vkVersion: Int) -> String {
    "lv|v2|rec|\(accountId)|\(recordId)|\(vkVersion)"
  }
  public static func sealAad(_ ctx: String) -> String { "lv|v2|seal|\(ctx)" }
  public static func rcAad(_ accountId: String, _ rcId: String, _ vkVersion: Int) -> String {
    "lv|v2|rc|\(accountId)|\(rcId)|\(vkVersion)"
  }
  public static let exportAadKey = "lv-export|1|key"
  public static let exportAadPayload = "lv-export|1|payload"

  public static func authSignString(deviceId: String, challenge: String) -> String {
    "\(authSignTag)\n\(deviceId)\n\(challenge)"
  }

  public struct UnlockSignFields: Sendable, Equatable {
    public var accountId, deviceId, requestNonce, ephPub, code, issuedAt: String
    public init(accountId: String, deviceId: String, requestNonce: String, ephPub: String, code: String, issuedAt: String) {
      self.accountId = accountId; self.deviceId = deviceId; self.requestNonce = requestNonce
      self.ephPub = ephPub; self.code = code; self.issuedAt = issuedAt
    }
  }

  public static func unlockSignString(_ f: UnlockSignFields) -> String {
    [unlockSignTag, f.accountId, f.deviceId, f.requestNonce, f.ephPub, f.code, f.issuedAt].joined(separator: "\n")
  }

  public struct AdminSignFields: Sendable, Equatable {
    public var method: String
    /// Request path exactly as sent, including the query string.
    public var path: String
    /// base64url(SHA-256(raw body bytes)); the hash of "" when there is no body.
    public var bodyHash: String
    /// UNIX seconds
    public var ts: Int
    public var nonce: String
    public init(method: String, path: String, bodyHash: String, ts: Int, nonce: String) {
      self.method = method; self.path = path; self.bodyHash = bodyHash; self.ts = ts; self.nonce = nonce
    }
  }

  public static func adminSignString(_ f: AdminSignFields) -> String {
    [adminSignTag, f.method, f.path, f.bodyHash, String(f.ts), f.nonce].joined(separator: "\n")
  }
}

// MARK: - account name (FR-02)

public enum AccountNameError: String, Error, Sendable { case tooShort = "too_short", tooLong = "too_long", badChars = "bad_chars", badEdge = "bad_edge" }

public enum AccountName {
  /// Strict check: 3-32 chars of [a-z0-9._-], must start and end with [a-z0-9].
  public static func validate(_ name: String) -> Result<String, AccountNameError> {
    let n = name.utf16.count
    if n < Field.accountNameMin { return .failure(.tooShort) }
    if n > Field.accountNameMax { return .failure(.tooLong) }
    let allowed: (UInt8) -> Bool = { (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2E || $0 == 0x5F || $0 == 0x2D }
    let u = Array(name.utf8)
    guard u.count == n, u.allSatisfy(allowed) else { return .failure(.badChars) }
    let edge: (UInt8) -> Bool = { (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) }
    guard edge(u.first!), edge(u.last!) else { return .failure(.badEdge) }
    return .success(name)
  }

  /// NFKC + lower-case (whitespace NOT trimmed), then validate. "Alice" and "alice" are the same.
  public static func normalize(_ input: String) -> Result<String, AccountNameError> {
    validate(input.nfkc.lowercased())
  }
}

// MARK: - ISO 8601

public enum ISODate {
  /// zod v4 `z.iso.datetime()` exactly: UTC `Z`, seconds required, any fractional precision,
  /// real calendar dates (leap years included).
  private static let datetime = try! NSRegularExpression(
    pattern: #"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$"#)
  private static let seconds = try! NSRegularExpression(pattern: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"#)

  private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
    // `\d` must mean ASCII digits only, as in JS without the `u` flag.
    guard s.utf8.allSatisfy({ $0 < 0x80 }) else { return false }
    return re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
  }

  public static func isDateTime(_ s: String) -> Bool { matches(datetime, s) }
  /// Second precision (signed strings, §8.4), e.g. 2026-11-11T09:00:00Z.
  public static func isSeconds(_ s: String) -> Bool { matches(seconds, s) && isDateTime(s) }

  private static let msFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    f.timeZone = TimeZone(identifier: "UTC")
    return f
  }()
  private static let plainFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    f.timeZone = TimeZone(identifier: "UTC")
    return f
  }()

  /// JS `Date#toISOString()`: millisecond precision, `Z`.
  public static func string(_ d: Date) -> String {
    let ms = (d.timeIntervalSince1970 * 1000).rounded(.down) / 1000
    return msFormatter.string(from: Date(timeIntervalSince1970: ms))
  }

  /// Second precision, e.g. for signed strings.
  public static func secondsString(_ d: Date) -> String {
    plainFormatter.string(from: Date(timeIntervalSince1970: d.timeIntervalSince1970.rounded(.down)))
  }

  /// Parses what `isDateTime` accepts (any fractional precision) into a Date.
  public static func parse(_ s: String) -> Date? {
    guard isDateTime(s) else { return nil }
    if let dot = s.firstIndex(of: ".") {
      let base = String(s[..<dot]) + "Z"
      guard let d = plainFormatter.date(from: base) else { return nil }
      let fracDigits = s[s.index(after: dot)..<s.index(before: s.endIndex)]
      let frac = Double("0." + fracDigits) ?? 0
      return d.addingTimeInterval(frac)
    }
    return plainFormatter.date(from: s)
  }

  /// Milliseconds since the epoch (JS `Date.parse`) for comparisons.
  public static func millis(_ s: String) -> Double? {
    parse(s).map { ($0.timeIntervalSince1970 * 1000).rounded(.down) }
  }
}
