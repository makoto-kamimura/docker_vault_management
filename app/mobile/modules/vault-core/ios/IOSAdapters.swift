// iOS implementations of the VaultKit dependencies (spec §5 storage table):
//  - vault files: Application Support/vault, NSFileProtectionComplete, excluded from backups
//  - Keychain: ThisDeviceOnly; vk.bio / admin.key behind `.biometryCurrentSet` (Face ID)
//  - LocalAuthentication for the biometric prompt (the evaluated LAContext is reused for the read)
//  - UIPasteboard: local only, with an expiration date
import Foundation
import LocalAuthentication
import Security
import UIKit
import UniformTypeIdentifiers
import VaultKit

// MARK: - files

final class FileVaultStorage: VaultStorage, @unchecked Sendable {
  let dir: URL

  init() throws {
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    var d = base.appendingPathComponent("vault", isDirectory: true)
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try d.setResourceValues(values)
    dir = d
  }

  func url(_ name: String) -> URL { dir.appendingPathComponent(name, isDirectory: false) }

  func read(_ name: String) throws -> Bytes? {
    let u = url(name)
    guard FileManager.default.fileExists(atPath: u.path) else { return nil }
    do { return Array(try Data(contentsOf: u)) } catch { throw VaultCoreError(.io, "read failed") }
  }

  func write(_ name: String, _ data: Bytes) throws {
    do { try Data(data).write(to: url(name), options: [.completeFileProtection]) } catch { throw VaultCoreError(.io, "write failed") }
  }

  /// POSIX rename(2): atomically replaces `to`.
  func rename(_ from: String, _ to: String) throws {
    guard Darwin.rename(url(from).path, url(to).path) == 0 else { throw VaultCoreError(.io, "rename failed") }
  }

  func remove(_ name: String) throws {
    let u = url(name)
    if FileManager.default.fileExists(atPath: u.path) {
      do { try FileManager.default.removeItem(at: u) } catch { throw VaultCoreError(.io, "remove failed") }
    }
  }

  func exists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: url(name).path) }
}

// MARK: - Keychain

final class KeychainKeystore: Keystore, @unchecked Sendable {
  let service = "localvault.vault"

  private func base(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  /// A plain marker next to each gated slot: "the key existed", so a missing gated item after a
  /// biometric enrollment change reads as E_BIOMETRY_INVALIDATED instead of "never set".
  private func marker(_ slot: KeystoreSlot) -> String { slot.rawValue + ".present" }

  private func exists(_ account: String) -> Bool {
    var q = base(account)
    q[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    let s = SecItemCopyMatching(q as CFDictionary, nil)
    return s == errSecSuccess || s == errSecInteractionNotAllowed
  }

  func read(_ slot: KeystoreSlot, auth: AuthToken?) async throws -> Bytes? {
    var q = base(slot.rawValue)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    if slot.biometricGated {
      guard let ctx = auth?.context as? LAContext else { throw VaultCoreError(.authFailed, "slot needs a biometric prompt") }
      q[kSecUseAuthenticationContext as String] = ctx
    }
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    switch status {
    case errSecSuccess:
      guard let d = out as? Data else { return nil }
      return Array(d)
    case errSecItemNotFound:
      if slot.biometricGated && exists(marker(slot)) { throw VaultCoreError(.biometryInvalidated) }
      return nil
    case errSecUserCanceled:
      throw VaultCoreError(.authCanceled)
    case errSecAuthFailed:
      throw VaultCoreError(slot.biometricGated ? .biometryInvalidated : .authFailed)
    default:
      throw VaultCoreError(.io, "keychain read failed (\(status))")
    }
  }

  func write(_ slot: KeystoreSlot, _ value: Bytes) async throws {
    SecItemDelete(base(slot.rawValue) as CFDictionary)
    var q = base(slot.rawValue)
    q[kSecValueData as String] = Data(value)
    if slot.biometricGated {
      var err: Unmanaged<CFError>?
      guard let ac = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &err) else {
        throw VaultCoreError(.biometryUnavailable)
      }
      q[kSecAttrAccessControl as String] = ac
    } else {
      q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    }
    let status = SecItemAdd(q as CFDictionary, nil)
    guard status == errSecSuccess else {
      // No device passcode: biometric-protected items cannot exist.
      if slot.biometricGated { throw VaultCoreError(.biometryUnavailable) }
      throw VaultCoreError(.io, "keychain write failed (\(status))")
    }
    if slot.biometricGated {
      SecItemDelete(base(marker(slot)) as CFDictionary)
      var m = base(marker(slot))
      m[kSecValueData as String] = Data([1])
      m[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
      SecItemAdd(m as CFDictionary, nil)
    }
  }

  func delete(_ slot: KeystoreSlot) async throws {
    SecItemDelete(base(slot.rawValue) as CFDictionary)
    if slot.biometricGated { SecItemDelete(base(marker(slot)) as CFDictionary) }
  }
}

// MARK: - Face ID / Touch ID

final class LocalAuthBiometric: Biometric, @unchecked Sendable {
  func availability() async -> (available: Bool, kind: BiometricKind) {
    let ctx = LAContext()
    var err: NSError?
    let ok = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
    let kind: BiometricKind
    switch ctx.biometryType {
    case .faceID: kind = .faceId
    case .touchID: kind = .touchId
    case .none: kind = .none
    default: kind = .biometric
    }
    return (ok, ok ? kind : .none)
  }

  func authenticate(reason: String) async throws -> AuthToken {
    let ctx = LAContext()
    ctx.localizedFallbackTitle = ""  // no passcode fallback: the gated keys need biometry
    var err: NSError?
    guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
      throw VaultCoreError(.biometryUnavailable)
    }
    do {
      _ = try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
      return AuthToken(context: ctx)
    } catch let e as LAError {
      switch e.code {
      case .userCancel, .appCancel, .systemCancel, .userFallback: throw VaultCoreError(.authCanceled)
      case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet: throw VaultCoreError(.biometryUnavailable)
      default: throw VaultCoreError(.authFailed)
      }
    } catch {
      throw VaultCoreError(.authFailed)
    }
  }
}

// MARK: - clipboard

final class PasteboardClipboard: SecureClipboard, @unchecked Sendable {
  func setSensitive(_ text: String, ttlSec: Int?) async throws {
    await MainActor.run {
      var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
      if let ttlSec { options[.expirationDate] = Date().addingTimeInterval(Double(ttlSec)) }
      UIPasteboard.general.setItems([[UTType.plainText.identifier: text]], options: options)
    }
  }
}

// MARK: - export / import files

final class AppFiles: FileAccess, @unchecked Sendable {
  func write(suggestedName: String, data: Bytes) async throws -> String {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("exports", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let u = dir.appendingPathComponent(suggestedName)
    do { try Data(data).write(to: u, options: [.completeFileProtection]) } catch { throw VaultCoreError(.io, "export write failed") }
    return u.absoluteString
  }

  func read(uri: String) async throws -> Bytes {
    guard let u = URL(string: uri) else { throw VaultCoreError(.notFound) }
    let scoped = u.startAccessingSecurityScopedResource()
    defer { if scoped { u.stopAccessingSecurityScopedResource() } }
    do { return Array(try Data(contentsOf: u)) } catch { throw VaultCoreError(.importFormat, "file cannot be read") }
  }

  func delete(uri: String) async throws {
    guard let u = URL(string: uri) else { return }
    try? FileManager.default.removeItem(at: u)
  }
}
