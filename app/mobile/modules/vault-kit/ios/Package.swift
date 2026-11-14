// swift-tools-version:5.9
// VaultKit as a Swift package, only so that `swift test` runs the unit tests on the Mac without a
// simulator. The app consumes the same sources through VaultKit.podspec (spec §4.3: one source).
import PackageDescription

let package = Package(
  name: "VaultKit",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [.library(name: "VaultKit", targets: ["VaultKit"])],
  targets: [
    .target(name: "VaultKit", path: "Sources/VaultKit"),
    .testTarget(name: "VaultKitTests", dependencies: ["VaultKit"], path: "Tests/VaultKitTests"),
  ]
)
