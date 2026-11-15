// Injected dependencies of the engine (port of vault-engine/src/deps.ts). Platform code (files,
// Keychain, LocalAuthentication, UIPasteboard, clock) sits behind these protocols so the same
// engine runs in `swift test` with in-memory fakes and in the app with the iOS implementations.
import Foundation

/// File-like store (app container, excluded from backups). The engine implements the §6.6 write
/// protocol on top: write `<name>.tmp` -> rename `<name>` to `.bak` -> rename tmp to `<name>`.
public protocol VaultStorage: Sendable {
  func read(_ name: String) throws -> Bytes?
  func write(_ name: String, _ data: Bytes) throws
  /// Replaces `to` if it exists. Throws when `from` does not exist.
  func rename(_ from: String, _ to: String) throws
  func remove(_ name: String) throws
  func exists(_ name: String) -> Bool
}

/// Keychain slots. `vk.bio` and `admin.key` are only readable after a biometric success.
public enum KeystoreSlot: String, Sendable, CaseIterable {
  case vkBio = "vk.bio", sk, signKey = "sign.key", adminKey = "admin.key", claim, throttle, usageKey = "usage.key"

  public var biometricGated: Bool { self == .vkBio || self == .adminKey }
}

/// Opaque proof that the user just passed a biometric prompt. The iOS implementation carries the
/// authenticated LAContext so a gated Keychain read does not prompt a second time.
public final class AuthToken: @unchecked Sendable {
  public let context: AnyObject?
  public init(context: AnyObject? = nil) { self.context = context }
}

public protocol Keystore: Sendable {
  /// Gated slots reject unless `auth` came from `Biometric.authenticate`.
  func read(_ slot: KeystoreSlot, auth: AuthToken?) async throws -> Bytes?
  func write(_ slot: KeystoreSlot, _ value: Bytes) async throws
  func delete(_ slot: KeystoreSlot) async throws
}

public enum BiometricKind: String, Sendable { case faceId, touchId, biometric, none }

public protocol Biometric: Sendable {
  func availability() async -> (available: Bool, kind: BiometricKind)
  /// Throws VaultCoreError E_AUTH_CANCELED / E_AUTH_FAILED / E_BIOMETRY_INVALIDATED / E_BIOMETRY_UNAVAILABLE.
  func authenticate(reason: String) async throws -> AuthToken
}

public protocol SecureClipboard: Sendable {
  /// Local only (no Universal Clipboard), expires after `ttlSec` (nil = never).
  func setSensitive(_ text: String, ttlSec: Int?) async throws
}

/// Export / import / CSV files chosen or produced through the share sheet / document picker.
public protocol FileAccess: Sendable {
  func write(suggestedName: String, data: Bytes) async throws -> String
  func read(uri: String) async throws -> Bytes
  func delete(uri: String) async throws
}

public protocol Clock: Sendable {
  func now() -> Date
}

public struct SystemClock: Clock {
  public init() {}
  public func now() -> Date { Date() }
}

public struct EngineDeps: Sendable {
  public var crypto: CryptoProvider
  public var storage: VaultStorage
  public var keystore: Keystore
  public var biometric: Biometric
  public var clipboard: SecureClipboard
  public var files: FileAccess
  public var clock: Clock
  public var platform: String  // "ios" | "android"
  public var psl: PublicSuffixList
  /// Development builds only (G11): accept http://localhost, 127.0.0.1, 10.0.2.2.
  public var allowInsecureLocalhost: Bool
  /// Default name for this device's record.
  public var deviceName: String?

  public init(
    crypto: CryptoProvider = SystemCrypto(), storage: VaultStorage, keystore: Keystore, biometric: Biometric,
    clipboard: SecureClipboard, files: FileAccess, clock: Clock = SystemClock(), platform: String = "ios",
    psl: PublicSuffixList = .shared, allowInsecureLocalhost: Bool = false, deviceName: String? = nil
  ) {
    self.crypto = crypto; self.storage = storage; self.keystore = keystore; self.biometric = biometric
    self.clipboard = clipboard; self.files = files; self.clock = clock; self.platform = platform; self.psl = psl
    self.allowInsecureLocalhost = allowInsecureLocalhost; self.deviceName = deviceName
  }
}
