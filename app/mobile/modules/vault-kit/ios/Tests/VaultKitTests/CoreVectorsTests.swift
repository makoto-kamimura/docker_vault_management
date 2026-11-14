// kdf / wrapped-vk / records / record-padding / seal / recovery-key vectors (spec §17.1, AC-34).
import XCTest

@testable import VaultKit

final class CoreVectorsTests: XCTestCase {
  let c = SystemCrypto()

  func testKdfAndWrappedVk() throws {
    let kdf = try Vectors.load("kdf.json")
    for t in try kdf.list("cases") {
      let k = try Kdf(json: try t.json("kdf"))
      let sk = try t.hex("recoveryKeyHex")
      let pw = try t.str("masterPasswordUtf8")
      let e = try t.obj("expected")
      let p = try c.pbkdf2Sha256(password: Keys.passwordBytes(pw), salt: try Base64Url.decode(k.salt), iterations: k.iterations, length: 32)
      XCTAssertEqual(Hex.encode(p), try e.str("pbkdf2Hex"), t.name)
      let mk = try Keys.deriveMasterKeys(c, masterPassword: pw, kdf: k, recoveryKey: sk, accountId: try t.str("accountId"))
      XCTAssertEqual(Hex.encode(mk.kek), try e.str("kekHex"), t.name)
      XCTAssertEqual(Hex.encode(mk.authKey), try e.str("authKeyHex"), t.name)
      XCTAssertEqual(Base64Url.encode(Keys.verifier(c, mk.authKey)), try e.str("verifier"), t.name)
      XCTAssertEqual(try RecoveryKey.format(c, sk), try t.str("recoveryKeyText"), t.name)
    }

    let w = try Vectors.load("wrapped-vk.json")
    let det = DeterministicCrypto()
    det.enqueueRandom(try w.hex("nonceHex"))
    let wrapped = try Keys.wrapVaultKey(det, kek: try w.hex("kekHex"), vk: try w.hex("vkHex"), accountId: try w.str("accountId"), keysetVersion: try w.int("keysetVersion"))
    XCTAssertEqual(wrapped, try WrappedVk(json: try w.json("wrappedVK")))
    XCTAssertTrue(det.drained)
    XCTAssertEqual(
      try Keys.unwrapVaultKey(c, kek: try w.hex("kekHex"), wrapped: wrapped, accountId: try w.str("accountId"), keysetVersion: try w.int("keysetVersion")),
      try w.hex("vkHex"))
    for n in try w.list("negative") {
      XCTAssertThrowsError(
        try Keys.unwrapVaultKey(c, kek: try w.hex("kekHex"), wrapped: try WrappedVk(json: try n.json("wrappedVK")), accountId: try n.str("accountId"), keysetVersion: try n.int("keysetVersion")),
        n.name
      ) { XCTAssertEqual($0 as? CryptoError, .decrypt, n.name) }
    }
  }

  func testRecordsAndPadding() throws {
    let v = try Vectors.load("records.json")
    let vk = try v.hex("vkHex")
    let accountId = try v.str("accountId")
    for t in try v.list("cases") {
      let det = DeterministicCrypto()
      det.enqueueRandom(try t.hex("nonceHex"))
      let loc = RecordLocator(accountId: accountId, recordId: try t.str("recordId"), vkVersion: try t.int("vkVersion"))
      let plain = try RecordPlain(json: try t.json("plain"))
      XCTAssertEqual(plain.json.utf8().count, try t.int("jsonByteLength"), t.name)
      XCTAssertEqual(Records.paddedLength(plain.json.utf8().count), try t.int("paddedByteLength"), t.name)
      let enc = try Records.encrypt(det, vk: vk, locator: loc, record: plain)
      let expected = try t.obj("encrypted")
      XCTAssertEqual(enc.nonce, try expected.str("nonce"), t.name)
      XCTAssertEqual(enc.ct, try expected.str("ct"), t.name)
      XCTAssertTrue(det.drained)
      let dec = try Records.decrypt(c, vk: vk, locator: loc, payload: enc)
      XCTAssertEqual(dec.kind, plain.kind)
    }
    for n in try v.list("negative") {
      let e = try n.obj("encrypted")
      let loc = RecordLocator(accountId: try n.str("accountId"), recordId: try n.str("recordId"), vkVersion: try n.int("vkVersion"))
      XCTAssertThrowsError(try Records.decrypt(c, vk: vk, locator: loc, payload: EncryptedPayload(nonce: try e.str("nonce"), ct: try e.str("ct"))), n.name) {
        XCTAssertEqual($0 as? CryptoError, .decrypt, n.name)
      }
    }

    let pad = try Vectors.load("record-padding.json")
    let base = try RecordPlain(json: try v.list("cases")[0].json("plain"))
    for t in try pad.list("cases") {
      let det = DeterministicCrypto()
      det.enqueueRandom(try pad.hex("nonceHex"))
      var plain = base
      guard case var .login(d) = plain.data else { return XCTFail("login expected") }
      d.notes = String(repeating: "x", count: try t.int("notesLength"))
      plain.data = .login(d)
      let enc = try Records.encrypt(
        det, vk: try pad.hex("vkHex"), locator: RecordLocator(accountId: try pad.str("accountId"), recordId: try pad.str("recordId"), vkVersion: 1), record: plain)
      XCTAssertEqual(try Base64Url.decode(enc.ct).count, try t.int("ciphertextBytes"))
      XCTAssertEqual(plain.json.utf8().count, try t.int("jsonByteLength"))
    }
  }

  func testSeal() throws {
    let v = try Vectors.load("seal.json")
    for t in try v.list("cases") {
      let det = DeterministicCrypto()
      det.enqueueKeyPair(KeyPair(privateKey: try t.hex("senderPrivateKeyHex"), publicKey: try t.hex("senderPublicKeyHex")))
      det.enqueueRandom(try t.hex("nonceHex"))
      let plain = try SealPlaintext(json: try t.json("plaintext"))
      XCTAssertEqual(plain.json.stringify(), try t.str("plaintextJson"), t.name)
      let env = try Seal.seal(det, recipientPub: try v.hex("recipientPublicKeyHex"), ctx: try t.str("ctx"), message: plain)
      XCTAssertEqual(env, try SealEnvelope(json: try t.json("envelope")), t.name)
      XCTAssertTrue(det.drained)
      XCTAssertEqual(try Seal.open(c, recipientPrivateKey: try v.hex("recipientPrivateKeyHex"), ctx: try t.str("ctx"), envelope: env), plain)
    }
    for n in try v.list("negative") {
      let priv = try (n["recipientPrivateKeyHex"] as? String).map(Hex.decode) ?? v.hex("recipientPrivateKeyHex")
      XCTAssertThrowsError(try Seal.open(c, recipientPrivateKey: priv, ctx: try n.str("ctx"), envelope: try SealEnvelope(json: try n.json("envelope"))), n.name) {
        XCTAssertEqual($0 as? CryptoError, .decrypt, n.name)
      }
    }
  }

  func testRecoveryKey() throws {
    let v = try Vectors.load("recovery-key.json")
    for t in try v.list("cases") {
      let sk = try t.hex("skHex")
      XCTAssertEqual(try RecoveryKey.format(c, sk), try t.str("text"))
      XCTAssertEqual(try RecoveryKey.parse(c, try t.str("text")), sk)
    }
    for t in try v.list("lenientValid") {
      let input = try t.str("input")
      XCTAssertEqual(Hex.encode(try RecoveryKey.parse(c, input)), try t.str("skHex"), input)
    }
    for t in try v.list("invalid") {
      let input = (t["input"] as? String) ?? ""
      XCTAssertThrowsError(try RecoveryKey.parse(c, input), input) {
        XCTAssertEqual(($0 as? VaultCoreError)?.code, .invalidRecoveryKey)
      }
    }
  }

  func testJsonMatchesJsStringify() throws {
    XCTAssertEqual(JSONValue.string("a\"b\\c\n\u{01}\u{1f}é/日本").stringify(), #""a\"b\\c\n\u0001\u001fé/日本""#)
    XCTAssertEqual(JSONValue.number(1).stringify(), "1")
    XCTAssertEqual(JSONValue.number(-0.5).stringify(), "-0.5")
    XCTAssertEqual(JSONValue.number(1e21).stringify(), "1e+21")
    XCTAssertEqual(JSONValue.number(1.5e-7).stringify(), "1.5e-7")
    XCTAssertEqual(JSONValue.number(0.000001).stringify(), "0.000001")
    XCTAssertEqual(JSONValue.number(123.456).stringify(), "123.456")
    let parsed = try JSONValue.parse(#"{"b":1,"a":[true,null,"x"],"b":2}"#)
    XCTAssertEqual(parsed.stringify(), #"{"b":2,"a":[true,null,"x"]}"#)
    for bad in ["{", "[1,]", "01", "\"\\x\"", "{\"a\" 1}", "1 2", "\"\u{01}\""] {
      XCTAssertThrowsError(try JSONValue.parse(bad), bad)
    }
  }

  func testIsoDateMatchesZod() {
    let cases: [(String, Bool)] = [
      ("2026-11-11T09:00:00Z", true), ("2026-11-11T09:00Z", false), ("2026-11-11T09:00:00.123456789Z", true),
      ("2026-02-29T00:00:00Z", false), ("2024-02-29T00:00:00Z", true), ("2026-13-01T00:00:00Z", false),
      ("2026-04-31T00:00:00Z", false), ("2026-11-11T24:00:00Z", false), ("2026-11-11T09:00:00+09:00", false),
      ("2026-11-11T09:00:00z", false), ("1900-02-29T00:00:00Z", false), ("2000-02-29T00:00:00Z", true),
      ("0000-01-01T00:00:00Z", true), ("２０２６-11-11T09:00:00Z", false),
    ]
    for (s, ok) in cases { XCTAssertEqual(ISODate.isDateTime(s), ok, s) }
    XCTAssertEqual(ISODate.string(Date(timeIntervalSince1970: 1_794_651_573.8389)), "2026-11-14T10:19:33.838Z")
  }
}
