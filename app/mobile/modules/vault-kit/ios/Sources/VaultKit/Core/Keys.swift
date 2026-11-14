// Key derivation and keyset handling — spec §5.4, §5.2. Port of core/src/keys.ts.

public struct MasterKeys: Sendable {
  /// Wraps the vault key. Never stored.
  public var kek: Bytes
  /// Authenticates to the server (only SHA-256(authKey) is stored there). Never stored.
  public var authKey: Bytes
}

public struct KeysetBundle: Sendable {
  public var keyset: Keyset
  /// Server-side authentication value, base64url.
  public var verifier: String
  public var authKey: Bytes
  public var kek: Bytes
  public var vk: Bytes
}

public enum Keys {
  /// The master password is NFKC-normalised; surrounding whitespace is NOT trimmed (§5.4).
  public static func passwordBytes(_ password: String) -> Bytes {
    Array(password.nfkc.utf8)
  }

  /// p = PBKDF2(NFKC(pw), salt, iterations, 32); ikm = p || SK;
  /// KEK / authKey = HKDF(ikm, salt = accountId bytes, info, 32).
  public static func deriveMasterKeys(
    _ p: CryptoProvider, masterPassword: String, kdf: Kdf, recoveryKey: Bytes, accountId: String
  ) throws -> MasterKeys {
    guard recoveryKey.count == ByteSize.uuid else { throw VaultCoreError(.invalidInput, "recovery key must be 16 bytes") }
    guard kdf.iterations >= Limits.kdfMinIterations, kdf.iterations <= Limits.kdfMaxIterations,
      let salt = try? Base64Url.decode(kdf.salt), salt.count == ByteSize.kdfSalt
    else { throw VaultCoreError(.invalidInput, "kdf does not match the schema") }
    let hkdfSalt = try UUIDBytes.toBytes(accountId)
    var stretched = try p.pbkdf2Sha256(password: passwordBytes(masterPassword), salt: salt, iterations: kdf.iterations, length: 32)
    var ikm = stretched + recoveryKey
    defer { wipe(&stretched); wipe(&ikm) }
    let kek = try p.hkdfSha256(ikm: ikm, salt: hkdfSalt, info: Array(Strings.HKDFInfo.kek.utf8), length: 32)
    let authKey = try p.hkdfSha256(ikm: ikm, salt: hkdfSalt, info: Array(Strings.HKDFInfo.auth.utf8), length: 32)
    return MasterKeys(kek: kek, authKey: authKey)
  }

  /// verifier = SHA-256(authKey).
  public static func verifier(_ p: CryptoProvider, _ authKey: Bytes) -> Bytes { p.sha256(authKey) }

  /// wrappedVK = AES-256-GCM(KEK, VK, AAD = "lv|v2|vk|<accountId>|<keysetVersion>"), fresh nonce.
  public static func wrapVaultKey(_ p: CryptoProvider, kek: Bytes, vk: Bytes, accountId: String, keysetVersion: Int) throws -> WrappedVk {
    guard vk.count == ByteSize.vk else { throw VaultCoreError(.invalidInput, "vault key must be 32 bytes") }
    let nonce = try p.randomBytes(ByteSize.nonce)
    let ct = try p.aesGcmEncrypt(key: kek, nonce: nonce, plaintext: vk, aad: Array(Strings.vkAad(accountId, keysetVersion).utf8))
    return WrappedVk(nonce: Base64Url.encode(nonce), ct: Base64Url.encode(ct))
  }

  /// `CryptoError.decrypt` when the KEK, accountId or keysetVersion do not match.
  public static func unwrapVaultKey(_ p: CryptoProvider, kek: Bytes, wrapped: WrappedVk, accountId: String, keysetVersion: Int) throws -> Bytes {
    guard let nonce = try? Base64Url.decode(wrapped.nonce), let ct = try? Base64Url.decode(wrapped.ct) else { throw CryptoError.decrypt }
    let vk = try p.aesGcmDecrypt(key: kek, nonce: nonce, ciphertextAndTag: ct, aad: Array(Strings.vkAad(accountId, keysetVersion).utf8))
    guard vk.count == ByteSize.vk else { throw VaultCoreError(.corrupted, "unexpected vault key size") }
    return vk
  }

  public static func generateVaultKey(_ p: CryptoProvider) throws -> Bytes { try p.randomBytes(ByteSize.vk) }

  public static func generateKdf(_ p: CryptoProvider, iterations: Int = Limits.kdfMinIterations) throws -> Kdf {
    guard iterations >= Limits.kdfMinIterations, iterations <= Limits.kdfMaxIterations else {
      throw VaultCoreError(.invalidInput, "kdf iterations out of range")
    }
    return Kdf(iterations: iterations, salt: Base64Url.encode(try p.randomBytes(ByteSize.kdfSalt)))
  }

  /// First keyset of an account: new random salt (and VK unless given). Versions default to 1/1.
  public static func createKeyset(
    _ p: CryptoProvider, masterPassword: String, recoveryKey: Bytes, accountId: String, vk: Bytes? = nil,
    iterations: Int? = nil, keysetVersion: Int = 1, vkVersion: Int = 1
  ) throws -> KeysetBundle {
    let key = try vk ?? generateVaultKey(p)
    let kdf = try generateKdf(p, iterations: iterations ?? Limits.kdfMinIterations)
    return try buildBundle(
      p, masterPassword: masterPassword, recoveryKey: recoveryKey, accountId: accountId, vk: key, kdf: kdf,
      keysetVersion: keysetVersion, vkVersion: vkVersion)
  }

  /// Password change / recovery-key reissue / code recovery: same VK, NEW salt,
  /// keysetVersion + 1, vkVersion unchanged.
  public static func rewrapKeyset(
    _ p: CryptoProvider, masterPassword: String, recoveryKey: Bytes, accountId: String, vk: Bytes, previous: Keyset,
    iterations: Int? = nil
  ) throws -> KeysetBundle {
    let kdf = try generateKdf(p, iterations: iterations ?? previous.kdf.iterations)
    return try buildBundle(
      p, masterPassword: masterPassword, recoveryKey: recoveryKey, accountId: accountId, vk: vk, kdf: kdf,
      keysetVersion: previous.keysetVersion + 1, vkVersion: previous.vkVersion)
  }

  static func buildBundle(
    _ p: CryptoProvider, masterPassword: String, recoveryKey: Bytes, accountId: String, vk: Bytes, kdf: Kdf,
    keysetVersion: Int, vkVersion: Int
  ) throws -> KeysetBundle {
    let mk = try deriveMasterKeys(p, masterPassword: masterPassword, kdf: kdf, recoveryKey: recoveryKey, accountId: accountId)
    let wrapped = try wrapVaultKey(p, kek: mk.kek, vk: vk, accountId: accountId, keysetVersion: keysetVersion)
    return KeysetBundle(
      keyset: Keyset(keysetVersion: keysetVersion, vkVersion: vkVersion, kdf: kdf, wrappedVK: wrapped),
      verifier: Base64Url.encode(verifier(p, mk.authKey)), authKey: mk.authKey, kek: mk.kek, vk: vk)
  }
}
