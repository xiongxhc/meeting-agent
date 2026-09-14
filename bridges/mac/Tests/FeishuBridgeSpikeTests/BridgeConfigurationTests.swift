import Foundation
import XCTest
@testable import FeishuBridgeSpike

final class BridgeConfigurationTests: XCTestCase {
    func testStrictConfigurationRejectsUnknownSecretsBoundsAndProductionPlaceholders() throws {
        var object: [String: Any] = ["schema": "feishu-bridge-config/v1", "pid": 123,
            "bundlePath": "/Applications/Synthetic.app", "bundleIdentifier": "test.synthetic", "bundleVersion": "1", "locale": "en-US",
            "evidenceRoot": "/private/tmp/synthetic-evidence", "observationIntervalMs": 200, "joinDeadlineMs": 1000,
            "actionDeadlineMs": 500, "axCallTimeoutMs": 50]
        func data() throws -> Data { try JSONSerialization.data(withJSONObject: object) }
        _ = try BridgeProcessConfiguration.decode(data(), inspection: true)
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(data(), inspection: false))
        object["secret"] = "must-not-be-accepted"
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(data(), inspection: true))
        object.removeValue(forKey: "secret"); object["pid"] = 0
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(data(), inspection: true))
        object["pid"] = 123; object["joinDeadlineMs"] = 999_999
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(data(), inspection: true))
        object["joinDeadlineMs"] = 1000
        object["selectors"] = ["build": "1", "locale": "en-US", "measured": true,
            "identifiers": try JSONSerialization.jsonObject(with: JSONEncoder().encode(FeishuUiLabels.bundled.identifiers)), "titles": [:]]
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(data(), inspection: false))
        XCTAssertThrowsError(try BridgeProcessConfiguration.arguments([]))
        XCTAssertThrowsError(try BridgeProcessConfiguration.arguments(["--config", "relative.json"]))
        XCTAssertEqual(try BridgeProcessConfiguration.arguments(["--help"]), .help)
        var identifiers = try JSONSerialization.jsonObject(with: JSONEncoder().encode(FeishuUiLabels.bundled.identifiers)) as! [String: String]
        for key in identifiers.keys { identifiers[key] = "measured-" + key }
        object["selectors"] = ["build": "1", "locale": "en-US", "measured": true, "identifiers": identifiers, "titles": [:]]
        XCTAssertEqual(try BridgeProcessConfiguration.decode(data(), inspection: false).pid, 123)
        object["pid"] = true
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(data(), inspection: false))
    }
}
