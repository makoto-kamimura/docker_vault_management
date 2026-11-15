// JSON bridge for the Expo module: `call(method, argsJson) -> resultJson`. Arguments and results
// cross the bridge as JSON TEXT so key order survives (JS sends `JSON.stringify(request.body)` and
// the admin signature covers exactly those bytes). Shapes follow core/src/vault-core.ts.
import Foundation

extension VaultEngine {
  private static func str(_ v: JSONValue?, _ name: String) throws -> String {
    guard let s = v?.stringValue else { throw VaultCoreError(.invalidInput, "\(name) must be a string") }
    return s
  }
  private static func int(_ v: JSONValue?, _ name: String) throws -> Int {
    guard let n = v?.intValue else { throw VaultCoreError(.invalidInput, "\(name) must be an integer") }
    return n
  }
  private static func clears(_ s: String?) -> JSONValue { .obj([("clearsAt", .str(s))]) }

  private static func itemInput(_ j: JSONValue) throws -> ItemInput {
    let urls = try (j["urls"]?.arrayValue ?? []).map { try UrlEntry(json: $0) }
    return ItemInput(
      id: j["id"]?.stringValue, title: try str(j["title"], "title"), username: j["username"]?.stringValue ?? "",
      password: j["password"]?.stringValue, urls: urls, notes: j["notes"]?.stringValue ?? "", favorite: j["favorite"]?.boolValue ?? false)
  }

  public func dispatch(json: String) async throws -> String {
    guard let call = try? JSONValue.parse(json), let method = call["method"]?.stringValue else {
      throw VaultCoreError(.invalidInput, "malformed call")
    }
    return try await dispatch(method, call["args"]?.arrayValue ?? []).stringify()
  }

  // swiftlint:disable:next cyclomatic_complexity function_body_length
  public func dispatch(_ method: String, _ args: [JSONValue]) async throws -> JSONValue {
    let a0 = args.first ?? .null
    let a1 = args.count > 1 ? args[1] : .null
    let a2 = args.count > 2 ? args[2] : .null
    typealias S = VaultEngine
    switch method {
    // state and unlocking
    case "getLockState": return .string(getLockState())
    case "getBiometricAvailability":
      let b = await getBiometricAvailability()
      return .obj([("available", .bool(b.available)), ("kind", .string(b.kind.rawValue))])
    case "enableBiometrics": try await enableBiometrics()
    case "disableBiometrics": try await disableBiometrics()
    case "unlockWithBiometrics": try await unlockWithBiometrics()
    case "unlockWithPassword": try await unlockWithPassword(try S.str(a0, "masterPassword"))
    case "lock": await lock()
    case "onBackground": onBackground()
    case "onForeground": await onForeground()

    // account
    case "createAccount":
      let r = try await createAccount(
        serverUrl: try S.str(a0["serverUrl"], "serverUrl"), accountName: try S.str(a0["accountName"], "accountName"),
        masterPassword: try S.str(a0["masterPassword"], "masterPassword"), inviteCode: a0["inviteCode"]?.stringValue ?? "")
      return .obj([("request", r.request.json), ("recoveryKey", .string(r.recoveryKey))])
    case "commitAccount": try await commitAccount()
    case "discardPendingAccount": discardPendingAccount()
    case "deriveAuthKey":
      let kdf: Kdf
      do { kdf = try Kdf(json: a0["kdf"] ?? .null) } catch { throw VaultCoreError(.invalidInput, "bad kdf") }
      return .string(try deriveAuthKey(
        accountId: try S.str(a0["accountId"], "accountId"), kdf: kdf, masterPassword: try S.str(a0["masterPassword"], "masterPassword"),
        recoveryKey: try S.str(a0["recoveryKey"], "recoveryKey")))
    case "buildRecoverRequest":
      return try buildRecoverRequest(accountName: a0["accountName"]?.stringValue ?? "", authKey: try S.str(a0["authKey"], "authKey")).json
    case "restoreAccount":
      try await restoreAccount(
        serverUrl: try S.str(a0["serverUrl"], "serverUrl"), accountName: try S.str(a0["accountName"], "accountName"),
        accountId: try S.str(a0["accountId"], "accountId"), keyset: a0["keyset"] ?? .null, masterPassword: try S.str(a0["masterPassword"], "masterPassword"),
        recoveryKey: try S.str(a0["recoveryKey"], "recoveryKey"))
    case "signAuthChallenge":
      let r = try await signAuthChallenge(try S.str(a0, "challenge"))
      return .obj([("deviceId", .string(r.deviceId)), ("sig", .string(r.sig))])
    case "getRecoveryKey": return .string(try await getRecoveryKey())
    case "changeMasterPassword": return try await changeMasterPassword(current: try S.str(a0, "current"), next: try S.str(a1, "next")).json
    case "resetMasterPassword": return try await resetMasterPassword(recoveryKey: try S.str(a0, "recoveryKey"), next: try S.str(a1, "next")).json
    case "regenerateRecoveryKey":
      let r = try await regenerateRecoveryKey(masterPassword: try S.str(a0, "masterPassword"))
      return .obj([("request", r.request.json), ("recoveryKey", .string(r.recoveryKey))])
    case "confirmKeysetAccepted": try await confirmKeysetAccepted()
    case "reregisterAdminKey": return try await reregisterAdminKey(masterPassword: try S.str(a0, "masterPassword")).json
    case "buildDeleteAccount": return try await buildDeleteAccount(masterPassword: try S.str(a0, "masterPassword")).json
    case "wipeLocal": try await wipeLocal()
    case "getAccountInfo": return try getAccountInfo()
    case "getThrottleState":
      let t = await getThrottleState()
      return .obj([("failedCount", .int(t.failedCount)), ("retryAfterSec", .int(t.retryAfterSec))])
    case "changeServerUrl": try changeServerUrl(try S.str(a0, "newUrl"))
    case "buildSignOutDevice": return .array(try await buildSignOutDevice().map(\.json))
    case "getStorageStatus":
      let st = getStorageStatus()
      return .obj([("recoveredFromBackup", .bool(st.recoveredFromBackup)), ("corrupted", .bool(st.corrupted))])
    case "markRevoked": try await markRevoked()
    case "isLastApprover": return .bool(try isLastApprover())

    // items
    case "listItems": return .array(try listItems(includeTrashed: a0["includeTrashed"]?.boolValue ?? false))
    case "searchItems": return .array(try searchItems(try S.str(a0, "query")))
    case "getItem": return try getItem(try S.str(a0, "id"))
    case "revealPassword": return .string(try revealPassword(try S.str(a0, "id")))
    case "saveItem": return try saveItem(try S.itemInput(a0))
    case "trashItem": try trashItem(try S.str(a0, "id"))
    case "restoreItem": try restoreItem(try S.str(a0, "id"))
    case "purgeItem": try purgeItem(try S.str(a0, "id"))
    case "purgeExpiredTrash": return .int(try await purgeExpiredTrash())
    case "resolveConflict": try resolveConflict(copyId: try S.str(a0, "copyId"), keep: try S.str(a1, "keep"))
    case "unlinkAndroidApp": try unlinkAndroidApp(try S.str(a0, "id"), packageName: try S.str(a1, "packageName"))
    case "getPasswordHistory": return .array(try getPasswordHistory(try S.str(a0, "id")))
    case "revealHistoricPassword": return .string(try revealHistoricPassword(try S.str(a0, "id"), index: try S.int(a1, "index")))
    case "copyHistoricPassword": return S.clears(try await copyHistoricPassword(try S.str(a0, "id"), index: try S.int(a1, "index")))
    case "clearPasswordHistory": try clearPasswordHistory(try S.str(a0, "id"))
    case "copy": return S.clears(try await copy(try S.str(a0, "id"), field: try S.str(a1, "field")))
    case "copyText": return S.clears(try await copyText(try S.str(a0, "text")))
    case "generatePassword":
      return .string(try generatePassword(GeneratorOptions(
        length: try S.int(a0["length"], "length"), upper: a0["upper"]?.boolValue ?? false, lower: a0["lower"]?.boolValue ?? false,
        digits: a0["digits"]?.boolValue ?? false, symbols: a0["symbols"]?.boolValue ?? false,
        excludeAmbiguous: a0["excludeAmbiguous"]?.boolValue ?? false)))

    // sync
    case "getSyncState": return try getSyncState()
    case "getPendingChanges": return .array(try await getPendingChanges(try S.int(a0, "limit")).map(\.json))
    case "applyPushResults":
      let results: [PushResult]
      do { results = try (a0.arrayValue ?? []).map { try PushResult(json: $0) } } catch { throw VaultCoreError(.invalidInput, "bad push results") }
      return .obj([("conflicts", .int(try await applyPushResults(results)))])
    case "applyPulled":
      let records: [EncryptedRecord]
      do { records = try (a0["records"]?.arrayValue ?? []).map { try EncryptedRecord(json: $0) } } catch {
        throw VaultCoreError(.corrupted, "malformed record from the server")
      }
      let r = try await applyPulled(
        records: records, cursor: try S.int(a0["cursor"], "cursor"), keyset: a0["keyset"], fullResync: a0["fullResync"]?.boolValue ?? false,
        hasMore: a0["hasMore"]?.boolValue ?? false)
      return .obj([("conflicts", .int(r.conflicts)), ("needsMasterPassword", .bool(r.needsMasterPassword))])
    case "acceptServerState": try acceptServerState()
    case "drainNotices": return .array(drainNotices().map(\.json))

    // devices and PC approval
    case "listDevices": return .array(try listDevices())
    case "renameDevice": try renameDevice(try S.str(a0, "deviceId"), name: try S.str(a1, "name"))
    case "parsePairingQr": return try parsePairingQr(try S.str(a0, "qr"))
    case "approvePairing":
      return try await approvePairing(pairing: a0["pairing"] ?? .null, fingerprint: try S.str(a0["fingerprint"], "fingerprint"), name: try S.str(a0["name"], "name")).json
    case "verifyUnlockRequest":
      switch try verifyUnlockRequest(a0) {
      case let .ok(name): return .obj([("ok", .bool(true)), ("deviceName", .string(name))])
      case let .failed(r): return .obj([("ok", .bool(false)), ("reason", .string(r.rawValue))])
      }
    case "approveUnlock": return try await approveUnlock(request: a0["request"] ?? .null, typedCode: try S.str(a0["typedCode"], "typedCode")).json
    case "rememberUnlockNonce": try rememberUnlockNonce(try S.str(a0, "nonce"))
    case "revokeDevice":
      return .array(try await revokeDevice(
        try S.str(a0["deviceId"], "deviceId"), rotateKey: a0["rotateKey"]?.boolValue ?? false, masterPassword: a0["masterPassword"]?.stringValue
      ).map(\.json))
    case "continueRotation": return .array(try await continueRotation(try S.str(a0, "rotationId")).map(\.json))
    case "confirmRotation": try await confirmRotation(cursor: try S.int(a0["cursor"], "cursor"))
    case "abortRotation": return abortRotation(try S.str(a0, "rotationId")).json
    case "isRotationPending": return .bool(isRotationPending())
    case "getDeviceRegistration": return try getDeviceRegistration()

    // recovery code
    case "issueRecoveryCode":
      let r = try await issueRecoveryCode(waitSec: try S.int(a0["waitSec"], "waitSec"))
      return .obj([("request", r.request.json), ("sheet", .obj([("qr", .string(r.qr)), ("text", .string(r.text))]))])
    case "buildSetRecoveryWait": return try await buildSetRecoveryWait(try S.int(a0, "waitSec")).json
    case "buildRevokeRecoveryCode": return try await buildRevokeRecoveryCode().json
    case "startRecoveryClaim": return .obj([("request", try await startRecoveryClaim(a0).json)])
    case "rememberRecoveryClaim":
      try await rememberRecoveryClaim(
        claimId: try S.str(a0["claimId"], "claimId"), claimToken: try S.str(a0["claimToken"], "claimToken"),
        availableAt: try S.str(a0["availableAt"], "availableAt"))
    case "getPendingRecoveryClaim": return try await getPendingRecoveryClaim()
    case "buildCompleteRecoveryClaim": return try await buildCompleteRecoveryClaim().json
    case "completeRecoveryClaim": try await completeRecoveryClaim(a0)
    case "setMasterPasswordAfterCodeRecovery": return try await setMasterPasswordAfterCodeRecovery(try S.str(a0, "next")).json
    case "abandonRecoveryClaim": try await abandonRecoveryClaim()
    case "buildCancelRecoveryClaim": return try await buildCancelRecoveryClaim(try S.str(a0, "claimId")).json
    case "buildApproveRecoveryClaimNow": return try await buildApproveRecoveryClaimNow(try S.str(a0, "claimId")).json

    // backup, settings, autofill
    case "exportVault": return .obj([("fileUri", .string(try await exportVault(try S.str(a0, "exportPassword"))))])
    case "deleteExportFile": try await deleteExportFile(try S.str(a0, "fileUri"))
    case "inspectImport":
      let r = try await inspectImport(try S.str(a0, "fileUri"), password: try S.str(a1, "password"))
      return .obj([("itemCount", .int(r.itemCount)), ("conflictCount", .int(r.conflictCount))])
    case "importVault":
      let r = try await importVault(try S.str(a0, "fileUri"), password: try S.str(a1, "password"), strategy: try S.str(a2, "strategy"))
      return .obj([("added", .int(r.added)), ("updated", .int(r.updated))])
    case "inspectCsvImport": return try await inspectCsvImport(try S.str(a0, "fileUri"))
    case "importCsv":
      let r = try await importCsv(try S.str(a0, "fileUri"), skipDuplicates: a1["skipDuplicates"]?.boolValue ?? false)
      return .obj([("added", .int(r.added)), ("skipped", .int(r.skipped))])
    case "getBackupInfo": return .obj([("lastExportAt", .str(try getBackupInfo()))])
    case "listTrustedBrowsers": return .array(listTrustedBrowsers())
    case "addTrustedBrowser", "removeTrustedBrowser": throw VaultCoreError(.invalidInput, "Android only")
    case "getSettings": return try getSettings()
    case "updateSettings": try updateSettings(a0)
    case "getAutofillStatus": return getAutofillStatus()
    case "requestEnableAutofill": return .bool(false)
    default:
      throw VaultCoreError(.invalidInput, "unknown method \(method)")
    }
    return .null
  }
}
