// swift-tools-version: 6.0
import PackageDescription

// Zero external dependencies on purpose: this package must build and test on a
// machine with no network access, and a Feishu bridge that pulls third-party
// code into the process that reads a meeting UI is a supply-chain surface we do
// not want. XCTest ships with the toolchain.
let package = Package(
    name: "FeishuBridgeSpike",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "FeishuBridgeLibrary", targets: ["FeishuBridgeSpike"]),
        .executable(name: "FeishuBridgeSpike", targets: ["FeishuBridgeExecutable"])
    ],
    targets: [
        .target(name: "FeishuBridgeSpike"),
        .executableTarget(name: "FeishuBridgeExecutable", dependencies: ["FeishuBridgeSpike"]),
        .testTarget(
            name: "FeishuBridgeSpikeTests",
            dependencies: ["FeishuBridgeSpike"]
        ),
    ]
)
