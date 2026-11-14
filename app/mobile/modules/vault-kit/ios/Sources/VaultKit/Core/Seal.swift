// Seal: hand a secret (the VK) to a recipient's ephemeral public key — spec §8.5.
// Port of core/src/seal.ts.
//   z = ECDH(s, R); k = HKDF(z, salt = SHA-256(S || R), info = "localvault/v2/seal|" + ctx, 32)
//   c = AES-256-GCM(k, random nonce, m, AAD = "lv|v2|seal|" + ctx)

public enum Seal {
  static func key(_ p: CryptoProvider, z: Bytes, senderPub: Bytes, recipientPub: Bytes, ctx: String) throws -> Bytes {
    try p.hkdfSha256(ikm: z, salt: p.sha256(senderPub + recipientPub), info: Array(Strings.sealHkdfInfo(ctx).utf8), length: 32)
  }

  public static func seal(_ p: CryptoProvider, recipientPub: Bytes, ctx: String, message: SealPlaintext) throws -> SealEnvelope {
    guard recipientPub.count == ByteSize.signPub else { throw VaultCoreError(.invalidInput, "recipient public key must be 65 bytes") }
    let m: SealPlaintext
    do { m = try SealPlaintext(json: message.json) } catch { throw VaultCoreError(.invalidInput, "seal plaintext does not match the schema") }
    var eph = try p.generateKeyPair()
    var z = try p.ecdh(privateKey: eph.privateKey, peerPublicKey: recipientPub)
    var k = try key(p, z: z, senderPub: eph.publicKey, recipientPub: recipientPub, ctx: ctx)
    defer { wipe(&eph.privateKey); wipe(&z); wipe(&k) }
    let nonce = try p.randomBytes(ByteSize.nonce)
    let ct = try p.aesGcmEncrypt(key: k, nonce: nonce, plaintext: m.json.utf8(), aad: Array(Strings.sealAad(ctx).utf8))
    let env = SealEnvelope(epk: Base64Url.encode(eph.publicKey), nonce: Base64Url.encode(nonce), ct: Base64Url.encode(ct))
    return try SealEnvelope(json: env.json)
  }

  /// `CryptoError.decrypt` for a wrong key, context or tampered envelope.
  public static func open(_ p: CryptoProvider, recipientPrivateKey: Bytes, ctx: String, envelope: SealEnvelope) throws -> SealPlaintext {
    let env: SealEnvelope
    do { env = try SealEnvelope(json: envelope.json) } catch { throw VaultCoreError(.invalidInput, "malformed seal envelope") }
    let senderPub = try Base64Url.decode(env.epk)
    let recipientPub = try p.publicKeyOf(privateKey: recipientPrivateKey)
    var z: Bytes
    do { z = try p.ecdh(privateKey: recipientPrivateKey, peerPublicKey: senderPub) } catch { throw CryptoError.decrypt }
    var k = try key(p, z: z, senderPub: senderPub, recipientPub: recipientPub, ctx: ctx)
    defer { wipe(&z); wipe(&k) }
    let plaintext = try p.aesGcmDecrypt(
      key: k, nonce: try Base64Url.decode(env.nonce), ciphertextAndTag: try Base64Url.decode(env.ct), aad: Array(Strings.sealAad(ctx).utf8))
    let json: JSONValue
    do { json = try JSONValue.parse(plaintext) } catch { throw VaultCoreError(.corrupted, "seal plaintext is not JSON") }
    do { return try SealPlaintext(json: json) } catch { throw VaultCoreError(.corrupted, "seal plaintext does not match the schema") }
  }
}
