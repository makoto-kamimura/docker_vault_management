// Loads app/packages/crypto-vectors/vectors/*.json straight from the repository (no copies, NFR-14).
import Foundation
import XCTest

@testable import VaultKit

enum Vectors {
  /// .../app/mobile/modules/vault-kit/ios/Tests/VaultKitTests/Vectors.swift → .../app
  static let appDir: URL = {
    var u = URL(fileURLWithPath: #filePath)
    for _ in 0..<7 { u.deleteLastPathComponent() }
    return u
  }()

  static var dir: URL { appDir.appendingPathComponent("packages/crypto-vectors/vectors") }

  static func load(_ name: String) throws -> [String: Any] {
    let data = try Data(contentsOf: dir.appendingPathComponent(name))
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }
}

// Small typed accessors over JSONSerialization output.
extension Dictionary where Key == String, Value == Any {
  /// Case name for assertion messages (non-throwing).
  var name: String { (self["name"] as? String) ?? "" }
  func str(_ k: String, file: StaticString = #filePath, line: UInt = #line) throws -> String {
    try XCTUnwrap(self[k] as? String, "missing string \(k)", file: file, line: line)
  }
  func int(_ k: String, file: StaticString = #filePath, line: UInt = #line) throws -> Int {
    try XCTUnwrap(self[k] as? Int, "missing int \(k)", file: file, line: line)
  }
  func hex(_ k: String, file: StaticString = #filePath, line: UInt = #line) throws -> Bytes {
    try Hex.decode(try str(k, file: file, line: line))
  }
  func utf8(_ k: String, file: StaticString = #filePath, line: UInt = #line) throws -> Bytes {
    Array(try str(k, file: file, line: line).utf8)
  }
  func obj(_ k: String, file: StaticString = #filePath, line: UInt = #line) throws -> [String: Any] {
    try XCTUnwrap(self[k] as? [String: Any], "missing object \(k)", file: file, line: line)
  }
  func list(_ k: String, file: StaticString = #filePath, line: UInt = #line) throws -> [[String: Any]] {
    try XCTUnwrap(self[k] as? [[String: Any]], "missing list \(k)", file: file, line: line)
  }
}
