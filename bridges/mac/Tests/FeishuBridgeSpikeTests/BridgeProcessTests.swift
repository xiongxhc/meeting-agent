import Foundation
import XCTest
@testable import FeishuBridgeSpike

final class BridgeProcessTests: XCTestCase {
    let occurrence = "900000001@2026-09-02T14:00:00Z"
    func command(_ id: String, _ payload: BridgeCommand, session: String = "bridge-one") -> BridgeCommandMessage {
        BridgeCommandMessage(sessionId: session, commandId: id, command: payload)
    }

    func testReplayOwnershipAndOneGlobalOutputOrder() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting()])
        let sink = MemoryEvidenceSink()
        var events: [BridgeEventMessage] = []
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: sink,
                                    output: { events.append(try JSONDecoder().decode(BridgeEventMessage.self, from: $0)) })
        let join = command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "lease"))
        try process.accept(join)
        try process.accept(join)
        XCTAssertEqual(driver.pressed.count, 1)
        XCTAssertEqual(events.map(\.sequence), [1, 2, 3])
        XCTAssertThrowsError(try process.accept(command("j", .leave(reason: .coordinatorStop))))
        XCTAssertThrowsError(try process.accept(command("other", .leave(reason: .coordinatorStop), session: "foreign")))
        XCTAssertEqual(driver.pressed.count, 1)
        try process.accept(command("m", .connectMedia(endpoint: "tcp://127.0.0.1:9000", sessionToken: "TOKEN_MUST_NOT_PERSIST", format: "pcm_s16le_24000_mono", expiresAt: "2026-09-02T15:00:00Z")))
        XCTAssertFalse(events.contains { if case .mediaConnected = $0.event { true } else { false } })
        XCTAssertFalse(String(decoding: sink.data, as: UTF8.self).contains("TOKEN_MUST_NOT_PERSIST"))
        XCTAssertEqual(Set(events.map(\.sequence)).count, events.count)
        XCTAssertEqual(process.retainedRecordCount, 0)
        XCTAssertThrowsError(try process.shutdown())
        XCTAssertTrue(sink.closed)
    }

    func testEvidenceFailurePreventsJoinAndOutputFailureStopsFurtherActions() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting()])
        let sink = MemoryEvidenceSink(); sink.fail = true
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: sink, output: { _ in })
        XCTAssertThrowsError(try process.accept(command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "lease"))))
        XCTAssertTrue(driver.pressed.isEmpty)
        let second = BridgeProcess(driver: driver, labels: .bundled, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: MemoryEvidenceSink(), output: { _ in throw TestFailure.failed })
        XCTAssertThrowsError(try second.accept(command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "lease"))))
        let count = driver.pressed.count
        XCTAssertThrowsError(try second.accept(command("d", .postDisclosure(text: "test"))))
        XCTAssertEqual(driver.pressed.count, count)
    }

    func testBoundedDedupAndDisclosureAttemptCannotBeRepeatedWithNewId() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(chat: .absent)])
        var events: [BridgeEventMessage] = []
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: MemoryEvidenceSink(), maxCommands: 3,
                                    output: { events.append(try JSONDecoder().decode(BridgeEventMessage.self, from: $0)) })
        try process.accept(command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "lease")))
        try process.accept(command("d", .postDisclosure(text: "test")))
        try process.accept(command("d2", .postDisclosure(text: "test")))
        XCTAssertEqual(events.filter { if case .chatDisclosure = $0.event { true } else { false } }.count, 1)
        XCTAssertThrowsError(try process.accept(command("full", .leave(reason: .coordinatorStop))))
    }

    func testIncrementalLinesRejectInvalidTruncatedOversizedAndUnknownFields() throws {
        var decoder = BoundedCommandLines(maxBytes: 512)
        let data = try JSONEncoder().encode(command("x", .leave(reason: .coordinatorStop)))
        XCTAssertTrue(try decoder.append(data.prefix(7)).isEmpty)
        XCTAssertEqual(try decoder.append(data.dropFirst(7) + Data([10])).count, 1)
        try decoder.finish()
        XCTAssertThrowsError(try decoder.append(Data("{\"schema\":\"no\"}\n".utf8)))
        var truncated = BoundedCommandLines(maxBytes: 10)
        _ = try truncated.append(Data("{".utf8))
        XCTAssertThrowsError(try truncated.finish())
        XCTAssertThrowsError(try truncated.append(Data(repeating: 65, count: 20)))
        var invalid = BoundedCommandLines(maxBytes: 512)
        XCTAssertThrowsError(try invalid.append(Data([255, 10])))
        let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        var extra = object; extra["unknown"] = true
        XCTAssertThrowsError(try invalid.append(JSONSerialization.data(withJSONObject: extra) + Data([10])))
    }

    func testShutdownAttemptsBoundedLeaveAndNeverClaimsUnreadableDeparture() throws {
        for readable in [true, false] {
            let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), FakeTree.inMeeting(), readable ? FakeTree.idleWithJoinSurface() : nil])
            let sink = MemoryEvidenceSink(); var events: [BridgeEventMessage] = []
            let process = BridgeProcess(driver: driver, labels: .bundled, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: sink,
                output: { events.append(try JSONDecoder().decode(BridgeEventMessage.self, from: $0)) })
            try process.accept(command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "l")))
            if readable { try process.shutdown() } else { XCTAssertThrowsError(try process.shutdown()) }
            XCTAssertEqual(events.contains { if case .left(reason: .removed) = $0.event { true } else { false } }, readable)
            XCTAssertTrue(driver.pressed.contains(FeishuUiLabels.bundled.identifiers.leaveButton))
            XCTAssertTrue(sink.closed)
            XCTAssertFalse(events.contains { if case .commandResult(let id, _, _) = $0.event { id.hasPrefix("shutdown-") } else { false } }, "the peer never issued an internal cleanup command")
            XCTAssertThrowsError(try process.accept(command("later", .leave(reason: .coordinatorStop))))
        }
    }

    func testBridgeFailureObservationDoesNotConfirmDepartureOrPermitLeaseRelease() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), nil, nil, nil, FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
        var events: [BridgeEventMessage] = []
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: MemoryEvidenceSink(),
            output: { events.append(try JSONDecoder().decode(BridgeEventMessage.self, from: $0)) })
        try process.accept(command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "l")))
        for _ in 0..<3 { try process.pollObservation() }
        try process.accept(command("release", .releaseLease(leaseId: "l")))
        XCTAssertTrue(events.contains { if case .commandResult(commandId: "release", outcome: .rejected, detail: _) = $0.event { true } else { false } })
        try process.shutdown()
        XCTAssertTrue(driver.pressed.contains(FeishuUiLabels.bundled.identifiers.leaveButton))
        XCTAssertEqual(events.filter { if case .left = $0.event { true } else { false } }.count, 1, "the frozen session already terminated with bridge_failure")
    }

    func testFailedJoinConfirmationStillNeedsRecordedCleanupAndReleaseWaits() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), nil, FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
        let sink = MemoryEvidenceSink()
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: sink, output: { _ in })
        try process.accept(command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "l")))
        try process.shutdown()
        XCTAssertEqual(driver.pressed, [FeishuUiLabels.bundled.identifiers.joinButton, FeishuUiLabels.bundled.identifiers.leaveButton])
        XCTAssertTrue(sink.closed)
    }

    func testEvidenceFailureAfterJoinPreventsUnrecordedCleanupAndNeverClaimsLeft() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting()])
        let sink = MemoryEvidenceSink(); var events: [BridgeEventMessage] = []
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink,
            output: { events.append(try JSONDecoder().decode(BridgeEventMessage.self, from: $0)) })
        try process.accept(command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "l")))
        sink.fail = true
        XCTAssertThrowsError(try process.shutdown())
        XCTAssertEqual(driver.pressed.count, 1)
        XCTAssertFalse(events.contains { if case .left = $0.event { true } else { false } })
        XCTAssertTrue(sink.closed)
    }

    func testLeaveAndReleaseAreTerminalWithoutRepeatingSideEffects() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: MemoryEvidenceSink(), output: { _ in })
        try process.accept(command("j", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "l")))
        let leave = command("leave", .leave(reason: .coordinatorStop))
        try process.accept(leave); try process.accept(leave)
        try process.accept(command("release", .releaseLease(leaseId: "l")))
        XCTAssertThrowsError(try process.accept(command("new", .join(meetingOccurrenceId: occurrence, meetingNo: "900000001", leaseId: "l"))))
        try process.shutdown()
        XCTAssertEqual(driver.pressed.count, 2)
    }
}

enum TestFailure: Error { case failed }
final class MemoryEvidenceSink: BridgeEvidenceSink {
    var data = Data(); var closed = false; var fail = false
    func append(_ line: Data) throws { if fail { throw TestFailure.failed }; data.append(line) }
    func close() throws { closed = true }
}
