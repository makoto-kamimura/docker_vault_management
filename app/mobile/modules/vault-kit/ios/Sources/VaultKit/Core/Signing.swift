// Signing and verification helpers (port of core/src/signing.ts and protocol/src/headers.ts).
// Signing takes a `Signer` instead of raw key bytes so device keys can live in the Secure Enclave.
import Foundation

/// Signs with a P-256 key: ECDSA over SHA-256(message), 64-byte r || s.
public typealias Signer = (Bytes) throws -> Bytes

public struct AdminHeader: Sendable, Equatable {
  public var deviceId: String
  public var ts: Int
  public var nonce: String
  public var sig: String
}

public struct HeaderParseError: Error, Sendable { public let message: String }

public enum AdminHeaderFormat {
  public static let name = "X-LV-Admin"

  static func validate(_ h: AdminHeader) throws {
    guard UUIDBytes.isValid(h.deviceId) else { throw HeaderParseError(message: "bad deviceId") }
    guard h.ts >= 0, h.ts <= 9_007_199_254_740_991 else { throw HeaderParseError(message: "bad ts") }
    guard Base64Url.isValid(h.nonce, byteLength: ByteSize.adminNonce) else { throw HeaderParseError(message: "bad nonce") }
    guard Base64Url.isValid(h.sig, byteLength: ByteSize.sig) else { throw HeaderParseError(message: "bad sig") }
  }

  /// `deviceId=<uuid>, ts=<unix seconds>, nonce=<b64url 16B>, sig=<b64url 64B>`
  public static func format(_ h: AdminHeader) throws -> String {
    try validate(h)
    return "deviceId=\(h.deviceId), ts=\(h.ts), nonce=\(h.nonce), sig=\(h.sig)"
  }

  public static func parse(_ value: String) throws -> AdminHeader {
    let parts = value.components(separatedBy: ", ")
    let keys = ["deviceId", "ts", "nonce", "sig"]
    guard parts.count == keys.count else { throw HeaderParseError(message: "wrong field count") }
    var map: [String: String] = [:]
    for (i, p) in parts.enumerated() {
      guard p.hasPrefix(keys[i] + "=") else { throw HeaderParseError(message: "expected \(keys[i])") }
      map[keys[i]] = String(p.dropFirst(keys[i].count + 1))
    }
    let ts = map["ts"]!
    let tsOk = ts == "0" || (ts.utf8.count <= 16 && ts.utf8.first.map { (0x31...0x39).contains($0) } == true
      && ts.utf8.allSatisfy { (0x30...0x39).contains($0) })
    guard tsOk, let tsNum = Int(ts) else { throw HeaderParseError(message: "bad ts") }
    let h = AdminHeader(deviceId: map["deviceId"]!, ts: tsNum, nonce: map["nonce"]!, sig: map["sig"]!)
    try validate(h)
    return h
  }
}

public enum UnlockVerifyFailure: String, Sendable {
  case unknownDevice = "unknown_device", revoked, badSignature = "bad_signature", stale, replayed
}

public enum UnlockVerifyResult: Sendable, Equatable {
  case ok(deviceName: String)
  case failed(UnlockVerifyFailure)
}

public struct UnlockRequestToVerify: Sendable, Equatable {
  public var deviceId, requestNonce, ephPub, code, issuedAt, sig: String
  public init(deviceId: String, requestNonce: String, ephPub: String, code: String, issuedAt: String, sig: String) {
    self.deviceId = deviceId; self.requestNonce = requestNonce; self.ephPub = ephPub
    self.code = code; self.issuedAt = issuedAt; self.sig = sig
  }
}

public enum CodeAttemptResult: Sendable, Equatable {
  case ok
  case wrong(attemptsLeft: Int, reject: Bool)
}

public enum Signing {
  // MARK: device auth challenge (§13.3)

  public static func signAuthChallenge(sign: Signer, deviceId: String, challenge: String) throws -> String {
    guard Base64Url.isValid(challenge, byteLength: ByteSize.challenge) else {
      throw VaultCoreError(.invalidInput, "challenge must be 32 bytes of base64url")
    }
    return Base64Url.encode(try sign(Array(Strings.authSignString(deviceId: deviceId, challenge: challenge).utf8)))
  }

  public static func verifyAuthChallenge(_ p: CryptoProvider, signPublicKey: String, deviceId: String, challenge: String, sig: String) -> Bool {
    verifyText(p, publicKey: signPublicKey, text: Strings.authSignString(deviceId: deviceId, challenge: challenge), sig: sig)
  }

  // MARK: unlock request (§8.4)

  public static func signUnlockRequest(sign: Signer, fields: Strings.UnlockSignFields) throws -> String {
    Base64Url.encode(try sign(Array(Strings.unlockSignString(fields).utf8)))
  }

  /// Checks 2-5 of §8.4 in order: trust list, signature, freshness, replay. Malformed fields are
  /// reported as `bad_signature`.
  public static func verifyUnlockRequest(
    _ p: CryptoProvider, accountId: String, request r: UnlockRequestToVerify, trust: [DeviceData], now: Date,
    isNonceSeen: (String) -> Bool
  ) -> UnlockVerifyResult {
    let entries = trust.filter { $0.deviceId == r.deviceId }
    guard let entry = entries.first(where: { $0.revokedAt != nil }) ?? entries.first, entry.type == "extension" else {
      return .failed(.unknownDevice)
    }
    if entry.revokedAt != nil { return .failed(.revoked) }

    let code = Array(r.code.utf8)
    let codeOk = code.count == 2 && (0x31...0x39).contains(code[0]) && (0x30...0x39).contains(code[1])
    let wellFormed =
      UUIDBytes.isValid(accountId) && UUIDBytes.isValid(r.deviceId)
      && Base64Url.isValid(r.requestNonce, byteLength: ByteSize.requestNonce)
      && Base64Url.isValid(r.ephPub, byteLength: ByteSize.signPub) && codeOk && ISODate.isSeconds(r.issuedAt)
      && Base64Url.isValid(r.sig, byteLength: ByteSize.sig)
    guard wellFormed else { return .failed(.badSignature) }

    let text = Strings.unlockSignString(
      .init(accountId: accountId, deviceId: r.deviceId, requestNonce: r.requestNonce, ephPub: r.ephPub, code: r.code, issuedAt: r.issuedAt))
    guard verifyText(p, publicKey: entry.signPub, text: text, sig: r.sig) else { return .failed(.badSignature) }

    let nowMs = (now.timeIntervalSince1970 * 1000).rounded(.down)
    guard let issuedMs = ISODate.millis(r.issuedAt), abs(nowMs - issuedMs) <= Double(TTLSec.unlockIssuedAtWindow * 1000) else {
      return .failed(.stale)
    }
    if isNonceSeen(r.requestNonce) { return .failed(.replayed) }
    return .ok(deviceName: entry.name)
  }

  /// Check 6 of §8.4. `failedAttempts` = wrong attempts BEFORE this one.
  public static func evaluateCodeAttempt(typedCode: String, signedCode: String, failedAttempts: Int) -> CodeAttemptResult {
    if constantTimeEqual(Array(typedCode.utf8), Array(signedCode.utf8)) { return .ok }
    let left = max(0, Limits.unlockCodeMaxAttempts - (failedAttempts + 1))
    return .wrong(attemptsLeft: left, reject: left == 0)
  }

  // MARK: admin header (§8.7)

  public static func adminBodyHash(_ p: CryptoProvider, body: Bytes?) -> String {
    Base64Url.encode(p.sha256(body ?? []))
  }

  /// Value of the `X-LV-Admin` header. `nowSec` is UNIX seconds.
  public static func buildAdminHeader(
    _ p: CryptoProvider, sign: Signer, method: String, path: String, body: Bytes?, deviceId: String, nowSec: Int
  ) throws -> String {
    let nonce = Base64Url.encode(try p.randomBytes(ByteSize.adminNonce))
    let fields = Strings.AdminSignFields(method: method, path: path, bodyHash: adminBodyHash(p, body: body), ts: nowSec, nonce: nonce)
    let sig = Base64Url.encode(try sign(Array(Strings.adminSignString(fields).utf8)))
    do {
      return try AdminHeaderFormat.format(AdminHeader(deviceId: deviceId, ts: nowSec, nonce: nonce, sig: sig))
    } catch {
      throw VaultCoreError(.invalidInput, "admin header")
    }
  }

  public enum AdminVerifyResult: Equatable { case ok(AdminHeader), malformed, badSignature, clockSkew }

  public static func verifyAdminHeader(
    _ p: CryptoProvider, adminPublicKey: String, method: String, path: String, body: Bytes?, headerValue: String, nowSec: Int? = nil
  ) -> AdminVerifyResult {
    guard let h = try? AdminHeaderFormat.parse(headerValue) else { return .malformed }
    let text = Strings.adminSignString(.init(method: method, path: path, bodyHash: adminBodyHash(p, body: body), ts: h.ts, nonce: h.nonce))
    guard verifyText(p, publicKey: adminPublicKey, text: text, sig: h.sig) else { return .badSignature }
    if let nowSec, abs(nowSec - h.ts) > TTLSec.adminTsWindow { return .clockSkew }
    return .ok(h)
  }

  // MARK: pairing fingerprint (§8.3)

  /// base64url(SHA-256(signPub || ephPub)).
  public static func pairingFingerprint(_ p: CryptoProvider, signPub: String, ephPub: String) throws -> String {
    guard let a = try? Base64Url.decode(signPub), let b = try? Base64Url.decode(ephPub), a.count == ByteSize.signPub, b.count == ByteSize.ephPub
    else { throw VaultCoreError(.invalidInput, "public keys must be 65 bytes") }
    return Base64Url.encode(p.sha256(a + b))
  }

  public static func verifyPairingFingerprint(_ p: CryptoProvider, signPub: String, ephPub: String, expected: String) throws -> Bool {
    guard let e = try? Base64Url.decode(expected) else { return false }
    return constantTimeEqual(try Base64Url.decode(try pairingFingerprint(p, signPub: signPub, ephPub: ephPub)), e)
  }

  static func verifyText(_ p: CryptoProvider, publicKey: String, text: String, sig: String) -> Bool {
    guard let pub = try? Base64Url.decode(publicKey), let s = try? Base64Url.decode(sig) else { return false }
    return p.ecdsaVerify(publicKey: pub, message: Array(text.utf8), signature: s)
  }
}
