// primitives.json (spec §17.1, AC-34) against SystemCrypto, plus the byte helpers.
import XCTest

@testable import VaultKit

final class PrimitivesTests: XCTestCase {
  let c = SystemCrypto()
  var v: [String: Any] = [:]

  override func setUpWithError() throws { v = try Vectors.load("primitives.json") }

  func testSha256() throws {
    for t in try v.list("sha256") {
      XCTAssertEqual(Hex.encode(c.sha256(try t.utf8("messageUtf8"))), try t.str("sha256"))
    }
  }

  func testHmac() throws {
    for t in try v.list("hmacSha256") {
      XCTAssertEqual(Hex.encode(c.hmacSha256(key: try t.hex("keyHex"), data: try t.utf8("messageUtf8"))), try t.str("mac"))
    }
  }

  func testHkdf() throws {
    for t in try v.list("hkdfSha256") {
      let out = try c.hkdfSha256(
        ikm: try t.hex("ikmHex"), salt: try t.hex("saltHex"), info: try t.utf8("infoUtf8"), length: try t.int("length"))
      XCTAssertEqual(Hex.encode(out), try t.str("okmHex"))
    }
  }

  func testPbkdf2() throws {
    for t in try v.list("pbkdf2Sha256") {
      let out = try c.pbkdf2Sha256(
        password: try t.utf8("passwordUtf8"), salt: try t.hex("saltHex"),
        iterations: try t.int("iterations"), length: try t.int("length"))
      XCTAssertEqual(Hex.encode(out), try t.str("dkHex"))
    }
  }

  func testAesGcm() throws {
    for t in try v.list("aesGcm") {
      let key = try t.hex("keyHex"), nonce = try t.hex("nonceHex"), aad = try t.hex("aadHex")
      let ct = try c.aesGcmEncrypt(key: key, nonce: nonce, plaintext: try t.hex("plaintextHex"), aad: aad)
      XCTAssertEqual(Hex.encode(ct), try t.str("ciphertextAndTagHex"), t.name)
      XCTAssertEqual(try c.aesGcmDecrypt(key: key, nonce: nonce, ciphertextAndTag: ct, aad: aad), try t.hex("plaintextHex"))
      var bad = ct
      bad[bad.count - 1] ^= 1
      XCTAssertThrowsError(try c.aesGcmDecrypt(key: key, nonce: nonce, ciphertextAndTag: bad, aad: aad)) {
        XCTAssertEqual($0 as? CryptoError, .decrypt)
      }
      XCTAssertThrowsError(try c.aesGcmDecrypt(key: key, nonce: nonce, ciphertextAndTag: [1, 2], aad: aad))
    }
  }

  func testEcdh() throws {
    for t in try v.list("ecdh") {
      XCTAssertEqual(try c.publicKeyOf(privateKey: try t.hex("privateKeyAHex")), try t.hex("publicKeyAHex"))
      XCTAssertEqual(try c.publicKeyOf(privateKey: try t.hex("privateKeyBHex")), try t.hex("publicKeyBHex"))
      let ab = try c.ecdh(privateKey: try t.hex("privateKeyAHex"), peerPublicKey: try t.hex("publicKeyBHex"))
      let ba = try c.ecdh(privateKey: try t.hex("privateKeyBHex"), peerPublicKey: try t.hex("publicKeyAHex"))
      XCTAssertEqual(Hex.encode(ab), try t.str("sharedXHex"))
      XCTAssertEqual(ab, ba)
    }
  }

  func testEcdsaVerify() throws {
    let e = try v.obj("ecdsaVerify")
    let pub = try e.hex("publicKeyHex"), msg = try e.hex("messageHex")
    for t in try e.list("valid") {
      XCTAssertTrue(c.ecdsaVerify(publicKey: pub, message: msg, signature: try t.hex("signatureHex")), t.name)
    }
    for t in try e.list("invalid") {
      XCTAssertFalse(c.ecdsaVerify(publicKey: pub, message: msg, signature: try t.hex("signatureHex")), t.name)
    }
    let sig = try e.list("valid")[0].hex("signatureHex")
    for t in try e.list("invalidPublicKeys") {
      XCTAssertFalse(c.ecdsaVerify(publicKey: try t.hex("publicKeyHex"), message: msg, signature: sig), t.name)
    }
  }

  func testSignRoundTripAndHalfOrder() throws {
    let kp = try c.generateKeyPair()
    XCTAssertEqual(kp.publicKey.count, 65)
    XCTAssertEqual(try c.publicKeyOf(privateKey: kp.privateKey), kp.publicKey)
    let msg = Array("うちカギ".utf8)
    let sig = try c.ecdsaSign(privateKey: kp.privateKey, message: msg)
    XCTAssertTrue(c.ecdsaVerify(publicKey: kp.publicKey, message: msg, signature: sig))
    XCTAssertFalse(c.ecdsaVerify(publicKey: kp.publicKey, message: msg + [0], signature: sig))
    // halfN is floor(n / 2)
    var doubled = Bytes(repeating: 0, count: 32)
    var carry = 0
    for i in stride(from: 31, through: 0, by: -1) {
      let d = Int(P256Order.halfN[i]) * 2 + carry
      doubled[i] = UInt8(d & 0xFF)
      carry = d >> 8
    }
    doubled[31] |= 1
    XCTAssertEqual(doubled, P256Order.n)
  }

  func testRandom() throws {
    XCTAssertEqual(try c.randomBytes(32).count, 32)
    XCTAssertNotEqual(try c.randomBytes(16), try c.randomBytes(16))
    XCTAssertEqual(try c.randomBytes(0), [])
  }

  func testBase64UrlStrict() throws {
    XCTAssertEqual(Base64Url.encode([]), "")
    XCTAssertEqual(Base64Url.encode(Array("abcd".utf8)), "YWJjZA")
    XCTAssertEqual(try Base64Url.decode("YWJjZA"), Array("abcd".utf8))
    for bad in ["YWJjZA==", "YW+j", "YW/j", "Y", "YWJjZB", " YWJj", "あ"] {
      XCTAssertThrowsError(try Base64Url.decode(bad), bad)
    }
    for n in 0..<40 {
      let b = try c.randomBytes(n)
      XCTAssertEqual(try Base64Url.decode(Base64Url.encode(b)), b)
    }
  }

  func testHexAndUuid() throws {
    XCTAssertEqual(Hex.encode([0, 15, 255]), "000fff")
    XCTAssertThrowsError(try Hex.decode("0F"))
    XCTAssertThrowsError(try Hex.decode("abc"))
    let id = try UUIDBytes.v4(fromRandom: Bytes(repeating: 0xFF, count: 16))
    XCTAssertEqual(id, "ffffffff-ffff-4fff-bfff-ffffffffffff")
    XCTAssertTrue(UUIDBytes.isValid(id))
    XCTAssertFalse(UUIDBytes.isValid("ffffffff-ffff-1fff-bfff-ffffffffffff"))
    XCTAssertEqual(try UUIDBytes.fromBytes(try UUIDBytes.toBytes(id)), id)
  }
}
