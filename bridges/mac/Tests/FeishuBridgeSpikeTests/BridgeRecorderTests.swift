import XCTest

@testable import FeishuBridgeSpike

/// The Swift recorder writes the same JSONL evidence shape as
/// `spikes/feishu/src/recorder.ts`: one record per line, `recordedAt` from an
/// injected clock, `direction`, and the full validated message.
final class BridgeRecorderTests: XCTestCase {

    private func event(_ sequence: Int, _ event: BridgeEvent) -> BridgeEventMessage {
        BridgeEventMessage(
            sessionId: "sess_mac_0000000000000001",
            sequence: sequence,
            observedAt: "2026-09-02T14:00:00.000Z",
            event: event)
    }

    func testRecordsCommandsAndEventsAsOneJsonObjectPerLine() throws {
        let recorder = BridgeRecorder(
            sessionId: "sess_mac_0000000000000001",
            clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))
        recorder.record(
            command: BridgeCommandMessage(
                sessionId: "sess_mac_0000000000000001",
                commandId: "cmd_0001",
                command: .join(
                    meetingOccurrenceId: "900000001@2026-09-02T14:00:00Z",
                    meetingNo: "900000001",
                    leaseId: "lease_0001")))
        recorder.record(event: event(1, .activeSpeaker(.ambiguous)))

        let lines = try recorder.jsonl().split(separator: "\n", omittingEmptySubsequences: false)
        XCTAssertEqual(lines.count, 3, "two records, each newline-terminated")
        XCTAssertEqual(lines.last, "")
        XCTAssertEqual(
            String(lines[0]),
            """
            {"direction":"command","message":{"commandId":"cmd_0001","leaseId":"lease_0001",\
            "meetingNo":"900000001","meetingOccurrenceId":"900000001@2026-09-02T14:00:00Z",\
            "schema":"bridge-session/v1","sessionId":"sess_mac_0000000000000001","type":"join"},\
            "recordedAt":"2026-09-02T00:00:00.000Z"}
            """)
        XCTAssertEqual(
            String(lines[1]),
            """
            {"direction":"event","message":{"confidence":"ambiguous","feishuUserId":null,\
            "observedAt":"2026-09-02T14:00:00.000Z","schema":"bridge-session/v1",\
            "sequence":1,"sessionId":"sess_mac_0000000000000001","type":"active_speaker"},\
            "recordedAt":"2026-09-02T00:00:01.000Z"}
            """)
    }

    func testEvidenceIsByteIdenticalForTheSameInputAndClock() throws {
        func run() throws -> String {
            let recorder = BridgeRecorder(
                sessionId: "sess_mac_0000000000000001",
                clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))
            recorder.record(event: event(1, .joined(meetingOccurrenceId: "m@t")))
            recorder.record(event: event(2, .left(reason: .ended)))
            return try recorder.jsonl()
        }
        XCTAssertEqual(try run(), try run())
    }

    func testEvidenceMovesWithTheClockProvingNothingReadsTheWallClock() throws {
        let a = BridgeRecorder(
            sessionId: "s", clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))
        let b = BridgeRecorder(
            sessionId: "s", clock: SequentialClock(start: "2026-09-03T00:00:00.000Z"))
        let message = BridgeEventMessage(
            sessionId: "s", sequence: 1, observedAt: "2026-09-02T14:00:00.000Z",
            event: .reconnecting(attempt: 1))
        a.record(event: message)
        b.record(event: message)
        XCTAssertNotEqual(try a.jsonl(), try b.jsonl())
    }

    func testRefusesAnEventThatWouldBreakTheStreamRules() {
        let recorder = BridgeRecorder(
            sessionId: "sess_mac_0000000000000001",
            clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))
        XCTAssertTrue(recorder.record(event: event(2, .reconnecting(attempt: 1))))
        XCTAssertFalse(
            recorder.record(event: event(2, .reconnected(attempt: 1))),
            "a repeated sequence is rejected, not recorded")
        XCTAssertFalse(
            recorder.record(event: event(1, .reconnected(attempt: 1))),
            "a sequence that regresses is rejected, not recorded")
        XCTAssertTrue(
            recorder.record(event: event(9, .reconnected(attempt: 1))),
            "gaps are allowed")
        XCTAssertEqual(recorder.records.count, 2)
    }

    func testRefusesAMessageFromAnotherSession() {
        let recorder = BridgeRecorder(
            sessionId: "sess_mac_0000000000000001",
            clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))
        XCTAssertFalse(
            recorder.record(
                event: BridgeEventMessage(
                    sessionId: "sess_other", sequence: 1,
                    observedAt: "2026-09-02T14:00:00.000Z", event: .left(reason: .ended))))
    }

    func testAnEmptyRecorderWritesNothingAtAll() throws {
        let recorder = BridgeRecorder(
            sessionId: "s", clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))
        XCTAssertEqual(try recorder.jsonl(), "")
    }

    func testRedactsConnectMediaSessionTokenFromPersistedEvidence() throws {
        let recorder = BridgeRecorder(
            sessionId: "sess_mac_0000000000000001",
            clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))
        let token = "tok_must_not_reach_evidence"

        XCTAssertTrue(recorder.record(
            command: BridgeCommandMessage(
                sessionId: "sess_mac_0000000000000001",
                commandId: "cmd_media",
                command: .connectMedia(
                    endpoint: "udp://127.0.0.1:40001", sessionToken: token,
                    format: "pcm_s16le/48000/1/20ms", expiresAt: "2026-09-02T15:00:00Z"))))

        let jsonl = try recorder.jsonl()
        XCTAssertFalse(jsonl.contains(token))
        XCTAssertFalse(jsonl.contains("sessionToken"))
        XCTAssertTrue(jsonl.contains("udp://127.0.0.1:40001"))
    }

    func testRejectsDirectlyConstructedMessagesThatDoNotMeetTheContract() {
        let recorder = BridgeRecorder(
            sessionId: "sess_mac_0000000000000001",
            clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))

        XCTAssertFalse(recorder.record(
            command: BridgeCommandMessage(
                sessionId: "sess_mac_0000000000000001", commandId: "cmd_bad",
                command: .postDisclosure(text: ""))))
        XCTAssertFalse(recorder.record(
            event: BridgeEventMessage(
                sessionId: "sess_mac_0000000000000001", sequence: 1,
                observedAt: "not-a-timestamp", event: .reconnecting(attempt: 1))))
        XCTAssertEqual(recorder.records.count, 0)
    }

    func testRejectsCommandResultsThatDoNotReferenceARecordedCommand() {
        let recorder = BridgeRecorder(
            sessionId: "sess_mac_0000000000000001",
            clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"))
        let result = BridgeEventMessage(
            sessionId: "sess_mac_0000000000000001", sequence: 1,
            observedAt: "2026-09-02T14:00:00.000Z",
            event: .commandResult(commandId: "cmd_known", outcome: .ok, detail: nil))

        XCTAssertFalse(recorder.record(event: result))
        XCTAssertTrue(recorder.record(
            command: BridgeCommandMessage(
                sessionId: "sess_mac_0000000000000001", commandId: "cmd_known",
                command: .leave(reason: .coordinatorStop))))
        XCTAssertTrue(recorder.record(event: result))
    }
}
