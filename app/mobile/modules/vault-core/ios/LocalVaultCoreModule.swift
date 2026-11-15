// Expo module "LocalVaultCore": the native VaultCore of spec §15.
//
// JS calls `call(json)` with `{"method": "...", "args": [...]}` and receives a JSON envelope
// `{"ok":true,"value":...}` or `{"ok":false,"code":"E_...","message":"...","details":{...}}`.
// Text in both directions keeps key order intact (the admin signature covers the exact body).
// The module also owns the app lifecycle hooks: auto-lock (FR-11) and the privacy cover shown
// while the app is in the app switcher.
import ExpoModulesCore
import UIKit
import VaultKit

public final class LocalVaultCoreModule: Module {
  private var engine: VaultEngine?
  private var initError: String?
  private var observers: [NSObjectProtocol] = []
  private var cover: UIView?

  public func definition() -> ModuleDefinition {
    Name("LocalVaultCore")

    Events("onLockStateChange", "onVaultChanged", "onSyncNeeded", "onNotice")

    OnCreate {
      self.start()
    }

    OnDestroy {
      for o in self.observers { NotificationCenter.default.removeObserver(o) }
      self.observers = []
    }

    AsyncFunction("call") { (json: String) async -> String in
      await self.handle(json)
    }
  }

  private func start() {
    do {
      #if DEBUG
        let insecure = true  // G11: http://localhost only in development builds
      #else
        let insecure = false
      #endif
      let deps = EngineDeps(
        storage: try FileVaultStorage(), keystore: KeychainKeystore(), biometric: LocalAuthBiometric(), clipboard: PasteboardClipboard(),
        files: AppFiles(), platform: "ios", allowInsecureLocalhost: insecure)
      let e = VaultEngine(deps)
      engine = e
      Task {
        await e.setListener { [weak self] name, payload in
          self?.sendEvent(name, (payload.anyValue as? [String: Any]) ?? [:])
        }
      }
    } catch {
      initError = "storage unavailable"
    }
    let nc = NotificationCenter.default
    observers.append(nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      guard let e = self?.engine else { return }
      Task { await e.onBackground() }
    })
    observers.append(nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
      guard let e = self?.engine else { return }
      Task { await e.onForeground() }
    })
    observers.append(nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.showCover()
    })
    observers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.hideCover()
    })
  }

  private func handle(_ json: String) async -> String {
    guard let engine else {
      return Self.failure("E_IO", initError ?? "VaultCore is not available", nil)
    }
    do {
      let value = try await engine.dispatch(json: json)
      return #"{"ok":true,"value":"# + value + "}"
    } catch let e as VaultCoreError {
      var details: [(String, JSONValue)] = []
      if let d = e.details {
        if let v = d.retryAfterSec { details.append(("retryAfterSec", .int(v))) }
        if let v = d.attemptsLeft { details.append(("attemptsLeft", .int(v))) }
        if let v = d.availableAt { details.append(("availableAt", .string(v))) }
      }
      return Self.failure(e.code.rawValue, e.message, details.isEmpty ? nil : .object(details))
    } catch is CryptoError {
      return Self.failure("E_CORRUPTED", "decryption failed", nil)
    } catch {
      return Self.failure("E_IO", "unexpected error", nil)
    }
  }

  private static func failure(_ code: String, _ message: String, _ details: JSONValue?) -> String {
    JSONValue.obj([("ok", .bool(false)), ("code", .string(code)), ("message", .string(message)), ("details", details ?? .null)]).stringify()
  }

  // MARK: privacy cover (spec §14: the app switcher must not show vault contents)

  private func showCover() {
    guard cover == nil, let window = Self.keyWindow() else { return }
    let v = UIView(frame: window.bounds)
    v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    v.backgroundColor = UIColor(red: 0x1F / 255.0, green: 0x4A / 255.0, blue: 0x86 / 255.0, alpha: 1)  // 藍
    let label = UILabel()
    label.text = "うちカギ"
    label.textColor = UIColor(red: 0xE2 / 255.0, green: 0xBC / 255.0, blue: 0x6E / 255.0, alpha: 1)  // 真鍮
    label.font = .systemFont(ofSize: 28, weight: .bold)
    label.translatesAutoresizingMaskIntoConstraints = false
    v.addSubview(label)
    NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: v.centerXAnchor), label.centerYAnchor.constraint(equalTo: v.centerYAnchor)])
    window.addSubview(v)
    cover = v
  }

  private func hideCover() {
    cover?.removeFromSuperview()
    cover = nil
  }

  private static func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
  }
}
