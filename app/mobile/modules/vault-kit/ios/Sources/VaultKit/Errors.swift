// Error types shared by every VaultKit module (port of app/packages/core/src/errors.ts).
// Messages never contain secrets or plaintext.

/// Error codes of the VaultCore interface (spec §15 table, v0.4 additions) plus the two
/// core-internal codes `E_INVALID_INPUT` and `E_TOO_LARGE`. Raw values are the wire codes JS sees.
public enum VaultCoreErrorCode: String, Sendable, CaseIterable {
  case locked = "E_LOCKED"
  case authCanceled = "E_AUTH_CANCELED"
  case authFailed = "E_AUTH_FAILED"
  case biometryInvalidated = "E_BIOMETRY_INVALIDATED"
  case biometryUnavailable = "E_BIOMETRY_UNAVAILABLE"
  case wrongPassword = "E_WRONG_PASSWORD"
  case wrongCredentials = "E_WRONG_CREDENTIALS"
  case invalidRecoveryKey = "E_INVALID_RECOVERY_KEY"
  case throttled = "E_THROTTLED"
  case corrupted = "E_CORRUPTED"
  case unsupportedVersion = "E_UNSUPPORTED_VERSION"
  case io = "E_IO"
  case notFound = "E_NOT_FOUND"
  case importFormat = "E_IMPORT_FORMAT"
  case rollbackDetected = "E_ROLLBACK_DETECTED"
  case needsMasterPassword = "E_NEEDS_MASTER_PASSWORD"
  case fingerprintMismatch = "E_FINGERPRINT_MISMATCH"
  case serverMismatch = "E_SERVER_MISMATCH"
  case codeMismatch = "E_CODE_MISMATCH"
  case untrustedDevice = "E_UNTRUSTED_DEVICE"
  case invalidRecoveryCode = "E_INVALID_RECOVERY_CODE"
  case claimWaiting = "E_CLAIM_WAITING"
  case rcFrozen = "E_RC_FROZEN"
  case claimClosed = "E_CLAIM_CLOSED"
  case deviceRevoked = "E_DEVICE_REVOKED"
  case accountDeleted = "E_ACCOUNT_DELETED"
  case clockSkew = "E_CLOCK_SKEW"
  case staleKey = "E_STALE_KEY"
  case versionConflict = "E_VERSION_CONFLICT"
  case invalidInput = "E_INVALID_INPUT"
  case tooLarge = "E_TOO_LARGE"
}

/// Documented `details` payloads of some codes.
public struct VaultCoreErrorDetails: Sendable, Equatable {
  /// `E_THROTTLED`
  public var retryAfterSec: Int?
  /// `E_CODE_MISMATCH`
  public var attemptsLeft: Int?
  /// `E_CLAIM_WAITING` (ISO 8601)
  public var availableAt: String?

  public init(retryAfterSec: Int? = nil, attemptsLeft: Int? = nil, availableAt: String? = nil) {
    self.retryAfterSec = retryAfterSec
    self.attemptsLeft = attemptsLeft
    self.availableAt = availableAt
  }
}

public struct VaultCoreError: Error, Sendable, Equatable, CustomStringConvertible {
  public let code: VaultCoreErrorCode
  public let message: String
  public let details: VaultCoreErrorDetails?

  public init(_ code: VaultCoreErrorCode, _ message: String? = nil, details: VaultCoreErrorDetails? = nil) {
    self.code = code
    self.message = message ?? code.rawValue
    self.details = details
  }

  public var description: String { "\(code.rawValue): \(message)" }
}

/// Failure inside a crypto primitive. `decrypt` is the only AEAD failure signal and carries no
/// detail on purpose (wrong key, wrong AAD, tampered ciphertext and malformed input look alike).
public enum CryptoError: Error, Sendable, Equatable {
  case decrypt
  case input(String)
}
