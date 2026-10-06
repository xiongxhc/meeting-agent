import XCTest
@testable import CalibrationSupport

final class CalibrationArgumentsTests: XCTestCase {
    func testRemainingScenariosAndExpiryTimestampAreClosedAndBoundTogether() throws {
        for mode in ["native-primary", "unconfirmed-cleanup-write"] {
            XCTAssertEqual(try CalibrationArguments.parse(["--config", "/a", "--telemetry", "/b", "--scenario", mode]).scenario.rawValue, mode)
        }
        let expiry = try CalibrationArguments.parse(["--config", "/a", "--telemetry", "/b", "--scenario", "expiry-rollback", "--expires-at-ms", "1700000000000"])
        XCTAssertEqual(expiry.scenario.rawValue, "expiry-rollback")
        for value in ["0", "01", "-1", "18446744073709551616", "secret"] {
            XCTAssertThrowsError(try CalibrationArguments.parse(["--config", "/a", "--telemetry", "/b", "--scenario", "expiry-rollback", "--expires-at-ms", value]))
        }
        XCTAssertThrowsError(try CalibrationArguments.parse(["--config", "/a", "--telemetry", "/b", "--scenario", "expiry-rollback"]))
        XCTAssertThrowsError(try CalibrationArguments.parse(["--config", "/a", "--telemetry", "/b", "--expires-at-ms", "1700000000000"]))
    }
    func testMetadataScenarioIsExplicitWithoutChangingDefault() throws {
        let result = try CalibrationArguments.parse(["--config", "/a", "--telemetry", "/b", "--scenario", "metadata-primary"])
        XCTAssertEqual(result.scenario.rawValue, "metadata-primary")
        XCTAssertEqual(result.scenario.telemetrySchema, "mac11d-metadata/v1")
        XCTAssertEqual(try CalibrationArguments.parse(["--config", "/a", "--telemetry", "/b"]).scenario, .normal)
    }
    func testReconnectScenarioIsExplicitAndUnknownFaultsCannotSelectAnInjection() throws {
        let result = try CalibrationArguments.parse(["--config", "/private/run/config.json", "--telemetry", "/private/run/telemetry.jsonl",
            "--scenario", "confirmed-cleanup-write"])
        XCTAssertEqual(result.configPath, "/private/run/config.json")
        for scenario in ["unknown", "expiry", "native-fault", "", "/private/key"] {
            XCTAssertThrowsError(try CalibrationArguments.parse(["--config", "/a", "--telemetry", "/b", "--scenario", scenario]))
        }
    }
    func testExplicitPrivateTelemetryPathCannotBeConfusedWithConfiguration() throws {
        let result = try CalibrationArguments.parse(["--config", "/private/run/config.json", "--telemetry", "/private/run/telemetry.jsonl"])
        XCTAssertEqual(result.configPath, "/private/run/config.json")
        XCTAssertEqual(result.telemetryPath, "/private/run/telemetry.jsonl")
        for arguments in [
            ["--config", "/a"],
            ["--config", "/a", "--telemetry", "relative"],
            ["--config", "/a", "--telemetry", "/a"],
            ["--config", "/a", "--config", "/b", "--telemetry", "/c"],
            ["--config", "/a", "--telemetry", "/b", "--fault", "expiry"],
        ] { XCTAssertThrowsError(try CalibrationArguments.parse(arguments)) }
    }
}
