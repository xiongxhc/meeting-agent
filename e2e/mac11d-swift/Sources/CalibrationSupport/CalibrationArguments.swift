import Foundation
import FeishuBridgeSpike

public enum CalibrationScenario: String, Sendable {
    case normal
    case confirmedCleanupWrite = "confirmed-cleanup-write"
    case metadataPrimary = "metadata-primary"
    case nativePrimary = "native-primary"
    case unconfirmedCleanupWrite = "unconfirmed-cleanup-write"
    case expiryRollback = "expiry-rollback"
    public var telemetrySchema: String {
        switch self {
        case .normal: "mac11d-calibration/v1"
        case .confirmedCleanupWrite: "mac11d-reconnect/v1"
        case .metadataPrimary: "mac11d-metadata/v1"
        case .nativePrimary: "mac11d-native/v1"
        case .unconfirmedCleanupWrite: "mac11d-unconfirmed/v1"
        case .expiryRollback: "mac11d-expiry/v1"
        }
    }
}

public struct CalibrationArguments: Equatable, Sendable {
    public let configPath: String
    public let telemetryPath: String
    public let scenario: CalibrationScenario
    public let expiresAtMs: UInt64?
    public static func parse(_ arguments: [String]) throws -> Self {
        guard [4, 6, 8].contains(arguments.count) else { throw BridgeProcessError.invalidInput }
        var paths: [String: String] = [:]
        var scenario: CalibrationScenario?
        var expiresAtMs: UInt64?
        for index in stride(from: 0, to: arguments.count, by: 2) {
            let option = arguments[index], path = arguments[index + 1]
            if option == "--scenario" {
                guard scenario == nil, let selected = CalibrationScenario(rawValue: path) else { throw BridgeProcessError.invalidInput }
                scenario = selected; continue
            }
            if option == "--expires-at-ms" {
                guard expiresAtMs == nil, let value = UInt64(path), value > 0, String(value) == path else { throw BridgeProcessError.invalidInput }
                expiresAtMs = value; continue
            }
            guard ["--config", "--telemetry"].contains(option), paths[option] == nil,
                  path.hasPrefix("/"), path != "/", !path.contains("\0"),
                  !path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else {
                throw BridgeProcessError.invalidInput
            }
            paths[option] = path
        }
        guard let config = paths["--config"], let telemetry = paths["--telemetry"], config != telemetry else {
            throw BridgeProcessError.invalidInput
        }
        let selected = scenario ?? .normal
        guard (selected == .expiryRollback) == (expiresAtMs != nil) else { throw BridgeProcessError.invalidInput }
        return Self(configPath: config, telemetryPath: telemetry, scenario: selected, expiresAtMs: expiresAtMs)
    }
}
