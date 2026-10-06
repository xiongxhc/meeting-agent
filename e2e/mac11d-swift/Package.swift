// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Mac11dCalibration",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "mac11d-calibration", targets: ["Mac11dCalibration"])],
    dependencies: [.package(path: "../../bridges/mac")],
    targets: [
        .target(name: "CalibrationSupport", dependencies: [.product(name: "FeishuBridgeLibrary", package: "mac")]),
        .executableTarget(name: "Mac11dCalibration", dependencies: ["CalibrationSupport", .product(name: "FeishuBridgeLibrary", package: "mac")]),
        .testTarget(name: "CalibrationSupportTests", dependencies: ["CalibrationSupport", .product(name: "FeishuBridgeLibrary", package: "mac")]),
    ]
)
