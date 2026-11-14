// signed-strings / pairing-fingerprint / recovery-code / export-file vectors.
import XCTest

@testable import VaultKit

final class MoreVectorsTests: XCTestCase {
  let c = SystemCrypto()

  func testSignedStrings() throws {
    let v = try Vectors.load("signed-strings.json")
    let pub = try Base64Url.decode(try v.str("signerPublicKey"))
    let items = try v.list("items")
    XCTAssertEqual(items.count, 4)
    let auth = try items[0].obj("input")
    XCTAssertEqual(Strings.authSignString(deviceId: try auth.str("deviceId"), challenge: try auth.str("challenge")), try items[0].str("text"))
    let u = try items[1].obj("input")
    XCTAssertEqual(
      Strings.unlockSignString(.init(
        accountId: try u.str("accountId"), deviceId: try u.str("deviceId"), requestNonce: try u.str("requestNonce"),
        ephPub: try u.str("ephPub"), code: try u.str("code"), issuedAt: try u.str("issuedAt"))),
      try items[1].str("text"))
    for i in [2, 3] {
      let a = try items[i].obj("input")
      XCTAssertEqual(
        Strings.adminSignString(.init(
          method: try a.str("method"), path: try a.str("path"), bodyHash: try a.str("bodyHash"), ts: try a.int("ts"), nonce: try a.str("nonce"))),
        try items[i].str("text"), items[i].name)
    }
    for i in items {
      let text = Array(try i.str("text").utf8)
      XCTAssertTrue(c.ecdsaVerify(publicKey: pub, message: text, signature: try Base64Url.decode(try i.str("signature"))), i.name)
      XCTAssertTrue(c.ecdsaVerify(publicKey: pub, message: text, signature: try Base64Url.decode(try i.str("signatureHighS"))), i.name)
      XCTAssertFalse(c.ecdsaVerify(publicKey: pub, message: text, signature: try Base64Url.decode(try i.str("tamperedSignature"))), i.name)
      XCTAssertFalse(c.ecdsaVerify(publicKey: pub, message: text + [0x0A], signature: try Base64Url.decode(try i.str("signature"))), i.name)
    }
    let h = try v.obj("adminHeader")
    let req = try h.obj("request")
    let r = Signing.verifyAdminHeader(
      c, adminPublicKey: try v.str("signerPublicKey"), method: try req.str("method"), path: try req.str("path"),
      body: Array(try req.str("bodyUtf8").utf8), headerValue: try h.str("value"))
    guard case .ok = r else { return XCTFail("admin header: \(r)") }

    // Our own signer round-trips through the header format.
    let priv = try v.hex("signerPrivateKeyHex")
    let header = try Signing.buildAdminHeader(
      c, sign: { try self.c.ecdsaSign(privateKey: priv, message: $0) }, method: "DELETE", path: "/v1/devices/x?y=1", body: nil,
      deviceId: "7b2e4c10-9f5d-4e3c-a001-3c4d5e6f7081", nowSec: 1_794_387_600)
    guard case .ok = Signing.verifyAdminHeader(
      c, adminPublicKey: try v.str("signerPublicKey"), method: "DELETE", path: "/v1/devices/x?y=1", body: [], headerValue: header, nowSec: 1_794_387_700)
    else { return XCTFail("own header") }
    XCTAssertEqual(
      Signing.verifyAdminHeader(
        c, adminPublicKey: try v.str("signerPublicKey"), method: "DELETE", path: "/v1/devices/x?y=1", body: nil, headerValue: header,
        nowSec: 1_794_387_600 + 301), .clockSkew)

    let f = try Vectors.load("pairing-fingerprint.json")
    for t in try f.list("cases") {
      XCTAssertEqual(try Signing.pairingFingerprint(c, signPub: try t.str("signPub"), ephPub: try t.str("ephPub")), try t.str("fingerprint"))
      XCTAssertTrue(try Signing.verifyPairingFingerprint(c, signPub: try t.str("signPub"), ephPub: try t.str("ephPub"), expected: try t.str("fingerprint")))
    }
    for t in try f.list("negative") {
      XCTAssertNotEqual(try Signing.pairingFingerprint(c, signPub: try t.str("signPub"), ephPub: try t.str("ephPub")), try t.str("fingerprint"))
    }
  }

  func testRecoveryCode() throws {
    let r = try Vectors.load("recovery-code.json")
    for t in try r.list("textCases") {
      XCTAssertEqual(try RecoveryCode.format(c, try t.hex("rcHex")), try t.str("text"))
      XCTAssertEqual(Hex.encode(try RecoveryCode.parse(c, try t.str("text"))), try t.str("rcHex"))
    }
    for t in try r.list("lenientValid") {
      let input = try t.str("input")
      XCTAssertEqual(Hex.encode(try RecoveryCode.parse(c, input)), try t.str("rcHex"), input)
    }
    for t in try r.list("invalid") {
      let input = (t["input"] as? String) ?? ""
      XCTAssertThrowsError(try RecoveryCode.parse(c, input), input) { XCTAssertEqual(($0 as? VaultCoreError)?.code, .invalidRecoveryCode) }
    }
    let d = try r.obj("derivation")
    let keys = try RecoveryCode.deriveKeys(c, rc: try d.hex("rcHex"), accountId: try d.str("accountId"))
    XCTAssertEqual([Hex.encode(keys.rcId), Hex.encode(keys.kekRC), Hex.encode(keys.authRC)], [try d.str("rcIdHex"), try d.str("kekRCHex"), try d.str("authRCHex")])
    let det = DeterministicCrypto()
    det.enqueueRandom(try d.hex("wrapNonceHex"))
    let reg = try RecoveryCode.createRegistration(det, rc: try d.hex("rcHex"), accountId: try d.str("accountId"), vk: try d.hex("vkHex"), vkVersion: try d.int("vkVersion"))
    let e = try d.obj("registration")
    XCTAssertEqual(reg.rcId, try e.str("rcId"))
    XCTAssertEqual(reg.wrappedVK, try WrappedVk(json: try e.json("wrappedVK")))
    XCTAssertEqual(reg.verifier, try e.str("verifier"))
    XCTAssertEqual(reg.vkVersion, try e.int("vkVersion"))
    XCTAssertEqual(
      Hex.encode(try RecoveryCode.unwrapVaultKey(c, rc: try d.hex("rcHex"), accountId: try d.str("accountId"), wrapped: reg.wrappedVK, vkVersion: try d.int("vkVersion"))),
      try d.str("vkHex"))
    for n in try r.list("negative") {
      XCTAssertThrowsError(
        try RecoveryCode.unwrapVaultKey(c, rc: try d.hex("rcHex"), accountId: try d.str("accountId"), wrapped: try WrappedVk(json: try n.json("wrappedVK")), vkVersion: try n.int("vkVersion")),
        n.name)
    }
    XCTAssertEqual(RecoveryCode.confirmationTail("LVRC-ABCDEF-GHJKMN"), "GHJKMN")
  }

  func testExportFile() throws {
    let v = try Vectors.load("export-file.json")
    let det = DeterministicCrypto()
    det.enqueueRandom(try v.hex("saltHex"), try v.hex("fileKeyHex"), try v.hex("keyNonceHex"), try v.hex("payloadNonceHex"))
    let payload = try ExportPayload(json: try v.json("payload"))
    let fileJson = try v.json("file")
    let file = try ExportFile.create(det, exportPassword: try v.str("exportPasswordUtf8"), payload: payload, exportedAt: try fileJson["exportedAt"]!.stringValue!)
    XCTAssertEqual(file, try ExportFileModel(json: fileJson))
    XCTAssertTrue(det.drained)
    XCTAssertEqual(try ExportFile.open(c, exportPassword: try v.str("exportPasswordUtf8"), file: fileJson).payload, payload)
    for n in try v.list("negative") {
      let expected = try n.str("expectedError")
      XCTAssertThrowsError(try ExportFile.open(c, exportPassword: try n.str("passwordUtf8"), file: try n.json("file")), n.name) {
        XCTAssertEqual(($0 as? VaultCoreError)?.code.rawValue, expected, n.name)
      }
    }
  }
}
