import XCTest
import FeishuBridgeSpike
@testable import CalibrationSupport

final class SyntheticControlTests: XCTestCase {
    func testStaticConfigurationFeedsActualSerializedV2ControlAndCleanup() throws {
        let configURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("static-config.json")
        let config = try BridgeProcessConfiguration.decode(Data(contentsOf: configURL), inspection: false)
        let custody = try XCTUnwrap(config.custody)
        XCTAssertNotNil(config.audio)
        let cancellation = BridgeCancellation(), sink = MemorySink()
        var events: [[String: Any]] = []
        let process = BridgeProcess(driver: SyntheticAccessibility(labels: config.labels), labels: config.labels,
            clock: SystemBridgeClock(), sink: sink, custody: custody, v2Clock: try CaptureClockPairSampler(),
            output: { data in
                _ = try BridgeEventMessageV2.decode(data)
                events.append(try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]))
            })
        let commands: [[String: Any]] = [
            ["type": "join", "meetingOccurrenceId": custody.occurrenceId, "meetingNo": "123456789", "leaseId": "test-lease"],
            ["type": "post_disclosure", "text": "Synthetic disclosure"],
            ["type": "leave", "reason": "coordinator_stop"],
            ["type": "release_lease", "leaseId": "test-lease"],
        ]
        var bytes = Data()
        for (index, var command) in commands.enumerated() {
            command["schema"] = "bridge-session/v2"; command["sessionId"] = custody.bridgeSessionId
            command["commandId"] = "command-\(index)"
            bytes.append(try JSONSerialization.data(withJSONObject: command)); bytes.append(10)
        }
        let input = ImmediateEOFInput(bytes: bytes, cancellation: cancellation)
        try runBridgeControl(process: process, input: input, cancellation: cancellation,
            clock: SystemBridgeClock(), observationInterval: 10)
        XCTAssertEqual(events.filter { $0["type"] as? String == "command_result" }.compactMap { $0["outcome"] as? String }, ["ok", "ok", "ok", "ok"])
        XCTAssertEqual(process.shutdownResult?.outcome, "departure_confirmed")
        XCTAssertTrue(sink.closed)
    }
    func testSyntheticUserStateSupportsActualJoinDisclosureAndConfirmedDeparture() {
        let driver = SyntheticAccessibility(labels: .bundled)
        let adapter = FeishuClientAdapter(driver: driver, joinDeadline: 0.2, actionDeadline: 0.2)
        XCTAssertEqual(adapter.join(meetingOccurrenceId: "123456789@2026-10-01T00:00:00Z", meetingNo: "123456789"), .joined(meetingOccurrenceId: "123456789@2026-10-01T00:00:00Z"))
        XCTAssertEqual(adapter.postDisclosureOnce(text: "Synthetic disclosure"), .sent)
        XCTAssertEqual(adapter.leave(), .left)
        XCTAssertFalse(adapter.departureUnconfirmed)
    }
    func testDeclaredWallClockAdvancesExactlyWithRealHostDomainInput() throws {
        let source = CoherentCalibrationClock(anchorHost: 5_000_000_000, anchorUnixNs: 1_000_000_000_000, host: { 5_123_456_789 })
        XCTAssertEqual(try source.hostNanoseconds(), 5_123_456_789)
        XCTAssertEqual(try source.wallSample().unixNs, 1_000_123_456_789)
    }
}

private final class MemorySink: BridgeEvidenceSink {
    var closed = false
    func append(_ line: Data) throws {}
    func close() throws { closed = true }
}
private final class ImmediateEOFInput: BridgeInputSource {
    private var bytes: Data?
    private let cancellation: BridgeCancellation
    var reachedEOF = false
    var failed: Bool { false }
    init(bytes: Data, cancellation: BridgeCancellation) { self.bytes = bytes; self.cancellation = cancellation }
    func start() {}
    func next(wait: TimeInterval) -> Data? {
        if let bytes { self.bytes = nil; return bytes }
        reachedEOF = true; cancellation.cancel(); return nil
    }
    func finish(timeout: TimeInterval) -> Bool { true }
}
