import Foundation
import Darwin
import XCTest
@testable import FeishuBridgeSpike

final class BridgeConfigurationTests: XCTestCase {
    func testTimedAudioFieldsAreExactBoundedAndNeverAcceptedByLegacyConfig() throws {
        var config = try JSONSerialization.jsonObject(with: meetingFixture("spikes/feishu/fixtures/process/config-v2.json")) as! [String: Any]
        config["schema"] = "feishu-bridge-config/v3"
        for invalid: [String: Any] in [[:], ["captureDisplayId": true, "outputDeviceUid": "x"],
            ["captureDisplayId": 0, "outputDeviceUid": "x"], ["captureDisplayId": UInt64(UInt32.max) + 1, "outputDeviceUid": "x"],
            ["captureDisplayId": 1, "outputDeviceUid": ""], ["captureDisplayId": 1, "outputDeviceUid": String(repeating: "x", count: 513)],
            ["captureDisplayId": 1, "outputDeviceUid": "x\0y"], ["captureDisplayId": 1, "outputDeviceUid": "x", "route": "default"]] {
            config["audio"] = invalid
            XCTAssertThrowsError(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: config), inspection: false))
        }
        config["audio"] = ["captureDisplayId": UInt32.max, "outputDeviceUid": String(repeating: "x", count: 512)]
        XCTAssertNoThrow(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: config), inspection: false))
        config["schema"] = "feishu-bridge-config/v2"
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: config), inspection: false))
    }
    func testExplicitTimedConfigIsAcceptedWithoutChangingLegacyConfig() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("spikes/feishu/fixtures/process/config-v2.json"))) as! [String: Any]
        _ = try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: object), inspection: false)
        object["schema"] = "feishu-bridge-config/v3"
        object["audio"] = ["captureDisplayId": 42, "outputDeviceUid": "synthetic-explicit-output"]
        XCTAssertNoThrow(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: object), inspection: false))
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: object), inspection: true))
    }
    func testPidIsOptionalAndAnExplicitPidStaysStrict() throws {
        var object = try JSONSerialization.jsonObject(with: meetingFixture("spikes/feishu/fixtures/process/config-v2.json")) as! [String: Any]
        XCTAssertEqual(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: object), inspection: false).pid, 123)
        object.removeValue(forKey: "pid")
        XCTAssertNil(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: object), inspection: false).pid,
                     "without a PID the bridge resolves the client at launch")
        object["schema"] = "feishu-bridge-config/v3"; object["audio"] = ["captureDisplayId": 42, "outputDeviceUid": "synthetic-explicit-output"]
        XCTAssertNil(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: object), inspection: false).pid)
        for invalid: Any in [0, -1, true, "123", 1.5, Int(Int32.max) + 1, NSNull()] {
            object["pid"] = invalid
            XCTAssertThrowsError(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: object), inspection: false), "\(invalid)")
        }
    }
    func testConfigurationReadsShortChunksAndRetriesInterruptedReadToEOF() throws {
        var calls = 0
        let data = try BridgeProcessConfiguration.readData(fd: -1) { _, buffer, count in
            calls += 1
            if calls == 1 { errno = EINTR; return -1 }
            if calls == 4 { return 0 }
            XCTAssertGreaterThanOrEqual(count, 2)
            let bytes: [UInt8] = calls == 2 ? [123, 32] : [32, 125]
            bytes.withUnsafeBytes { buffer!.copyMemory(from: $0.baseAddress!, byteCount: 2) }
            return 2
        }
        XCTAssertEqual(data, Data("{  }".utf8))
        XCTAssertEqual(calls, 4)
    }

    func testConfigurationRequiresEOFAndRejectsGrowthBeyondByteCap() throws {
        for total in [65_536, 65_537] {
            var consumed = 0; var calls = 0
            func read() throws -> Data {
                try BridgeProcessConfiguration.readData(fd: -1) { _, buffer, capacity in
                    calls += 1
                    let count = min(capacity, min(1024, total - consumed))
                    buffer!.initializeMemory(as: UInt8.self, repeating: 32, count: count)
                    consumed += count
                    return count
                }
            }
            if total == 65_536 { XCTAssertEqual(try read().count, total); XCTAssertEqual(calls, 65) }
            else { XCTAssertThrowsError(try read()); XCTAssertEqual(consumed, 65_537) }
        }
        XCTAssertThrowsError(try BridgeProcessConfiguration.readData(fd: -1) { _, _, _ in errno = EIO; return -1 })
    }

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
