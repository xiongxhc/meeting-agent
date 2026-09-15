import XCTest
@testable import FeishuBridgeSpike

final class BridgeProcessV2Tests: XCTestCase {
    func testFailedSnapshotOutputCannotLeakItsBracketIntoLaterCleanupObservation() throws {
        let sink = MemoryEvidenceSink(), source = SyntheticPairClock()
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
        var events: [[String: Any]] = []
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink,
            v2Clock: try CaptureClockPairSampler(clockDomainId: "source-process", source: source), output: { bytes in
                let object = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
                if object["type"] as? String == "ui_snapshot" { throw TestFailure.failed }
                events.append(object)
            })
        let command: [String: Any] = ["schema": "bridge-session/v2", "sessionId": "bridge-one", "commandId": "join", "type": "join", "meetingOccurrenceId": "900000001@2026-09-02T14:00:00Z", "meetingNo": "900000001", "leaseId": "lease"]
        try process.accept(BridgeCommandMessageV2.decode(JSONSerialization.data(withJSONObject: command)))
        XCTAssertThrowsError(try process.pollObservation())
        source.host += 1_000_000_000
        try process.shutdown()
        let left = try XCTUnwrap(events.first { $0["type"] as? String == "left" })
        XCTAssertTrue(left["observationTiming"] is NSNull)
        XCTAssertEqual(left["observationTimingReason"] as? String, "timing_unavailable")
        XCTAssertEqual(process.shutdownResult, .confirmed)
    }
    func testActualMediaOwnerIsRecordedBeforeStartAndStoppedBeforePhysicalLeave() throws {
        let cancellation = BridgeCancellation(), sink = MemoryEvidenceSink()
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        socket.feed(try authAcceptedFixture())
        let session = try makeTimedSession(socket, capture, engine, clock)
        let media = TimedMediaControlOwner(session: session, cancellation: cancellation)
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(meetingNo: "123456789"), FakeTree.inMeeting(meetingNo: "123456789"), FakeTree.idleWithJoinSurface()])
        var events: [[String: Any]] = []
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink,
            v2Clock: try CaptureClockPairSampler(clockDomainId: "source-process", source: clock), timedMedia: media,
            output: { bytes in
                let event = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
                if event["type"] as? String == "left" { XCTAssertEqual(engine.stopCount, 1); XCTAssertEqual(capture.stopCount, 1) }
                events.append(event)
            })
        let fixture = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/contracts/bridge-session-v2.json")) as! [String: Any]
        for object in fixture["commands"] as! [[String: Any]] {
            try process.accept(BridgeCommandMessageV2.decode(JSONSerialization.data(withJSONObject: object)))
        }
        XCTAssertTrue(events.contains { $0["type"] as? String == "media_connected" })
        XCTAssertEqual(capture.startCount, 1); XCTAssertEqual(engine.startCount, 1)
        XCTAssertFalse(String(decoding: sink.data, as: UTF8.self).contains("fixture-token"))
        try process.shutdown()
        XCTAssertEqual(process.shutdownResult, .confirmed); XCTAssertTrue(socket.closed); XCTAssertTrue(sink.closed)
    }
    func testSerializedControlLoopSelectsV2AndClosesBeforeReturn() throws {
        let cancellation = BridgeCancellation(), sink = MemoryEvidenceSink()
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink,
            v2Clock: try CaptureClockPairSampler(clockDomainId: "source-process", source: SyntheticPairClock()), output: { _ in })
        let bytes = Data("{\"schema\":\"bridge-session/v2\",\"sessionId\":\"bridge-one\",\"commandId\":\"join\",\"type\":\"join\",\"meetingOccurrenceId\":\"900000001@2026-09-02T14:00:00Z\",\"meetingNo\":\"900000001\",\"leaseId\":\"lease\"}\n".utf8)
        let input = V2ScriptedInput(bytes: bytes, cancellation: cancellation)
        XCTAssertNoThrow(try runBridgeControl(process: process, input: input, cancellation: cancellation, clock: SystemBridgeClock(), observationInterval: 10))
        XCTAssertTrue(input.finished); XCTAssertTrue(sink.closed)
        XCTAssertEqual(driver.pressed.count, 2)
        XCTAssertEqual(process.shutdownResult, .confirmed)
    }
    func testVersionedOwnerEmitsPeriodicSnapshotsBeforeChangesAndRetainsCustodyCleanup() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
        let source = SyntheticPairClock(), sink = MemoryEvidenceSink()
        let sampler = try CaptureClockPairSampler(clockDomainId: "source-process", source: source)
        var events: [[String: Any]] = []
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink,
            v2Clock: sampler, output: { events.append(try JSONSerialization.jsonObject(with: $0) as! [String: Any]) })
        let message: [String: Any] = ["schema": "bridge-session/v2", "sessionId": "bridge-one", "commandId": "join-1", "type": "join", "meetingOccurrenceId": "900000001@2026-09-02T14:00:00Z", "meetingNo": "900000001", "leaseId": "lease"]
        let command = try BridgeCommandMessageV2.decode(JSONSerialization.data(withJSONObject: message))
        try process.accept(command)
        try process.accept(command)
        for _ in 0..<2 { source.host += 250_000_000; try process.pollObservation() }
        let snapshots = events.filter { $0["type"] as? String == "ui_snapshot" }
        XCTAssertEqual(snapshots.count, 2)
        XCTAssertEqual(snapshots.compactMap { $0["snapshotSequence"] as? Int }, [1, 2])
        XCTAssertTrue(events.allSatisfy { $0["schema"] as? String == "bridge-session/v2" })
        XCTAssertEqual(events.compactMap { $0["sequence"] as? Int }, Array(1...events.count))
        XCTAssertEqual(driver.pressed.count, 1)
        try process.shutdown()
        XCTAssertEqual(process.shutdownResult, .confirmed)
        XCTAssertTrue(sink.closed)
        for event in events { _ = try BridgeEventMessageV2.decode(JSONSerialization.data(withJSONObject: event)) }
    }
}

private final class V2ScriptedInput: BridgeInputSource {
    var reachedEOF = false
    var failed: Bool { false }
    var finished = false
    private var bytes: Data?
    private let cancellation: BridgeCancellation
    init(bytes: Data, cancellation: BridgeCancellation) { self.bytes = bytes; self.cancellation = cancellation }
    func start() {}
    func next(wait: TimeInterval) -> Data? {
        if let data = bytes { bytes = nil; return data }
        reachedEOF = true; cancellation.cancel(); return nil
    }
    func finish(timeout: TimeInterval) -> Bool { finished = true; return true }
}
