import Foundation
import Darwin
import XCTest
@testable import FeishuBridgeSpike

final class BridgeConfigurationTests: XCTestCase {
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
