import XCTest
import Darwin
@testable import FeishuBridgeSpike

final class BridgeProcessOutcomeTests: XCTestCase {
    func fixture(_ name: String) throws -> Data {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        return try Data(contentsOf: root.appendingPathComponent("spikes/feishu/fixtures/process/" + name))
    }
    func testSharedConfigAndOutcomeFixturesBindExactlyAndRejectUnknownShapes() throws {
        let config = try BridgeProcessConfiguration.decode(fixture("config-v2.json"), inspection: false)
        let outcome = try BridgeProcessOutcome.decode(fixture("outcome-v1.json"))
        XCTAssertEqual(config.custody, outcome.binding)
        XCTAssertEqual(outcome.outcome, "departure_confirmed")
        XCTAssertThrowsError(try BridgeProcessConfiguration.decode(fixture("config-v2.json"), inspection: true))
        var raw = try JSONSerialization.jsonObject(with: fixture("outcome-v1.json")) as! [String: Any]
        raw["reason"] = "join_not_issued"
        XCTAssertThrowsError(try BridgeProcessOutcome.decode(JSONSerialization.data(withJSONObject: raw)))
        let duplicated = String(decoding: try fixture("outcome-v1.json"), as: UTF8.self)
            .replacingOccurrences(of: "\"outcome\":", with: "\"outcome\":\"departure_unconfirmed\",\"outcome\":")
        XCTAssertThrowsError(try BridgeProcessOutcome.decode(Data(duplicated.utf8)))
        XCTAssertThrowsError(try BridgeProcessOutcome.decode(Data(duplicated.replacingOccurrences(of: "departure_unconfirmed", with: "departure_confirmed").utf8)))
        for (key, value) in [("physicalClientId", "slot\n"), ("physicalGenerationId", String(repeating: "a", count: 32) + "\n")] {
            var invalid = try JSONSerialization.jsonObject(with: fixture("outcome-v1.json")) as! [String: Any]
            invalid[key] = value
            XCTAssertThrowsError(try BridgeProcessOutcome.decode(JSONSerialization.data(withJSONObject: invalid)))
        }
        raw["reason"] = "departure_observed"; raw["extra"] = true
        XCTAssertThrowsError(try BridgeProcessOutcome.decode(JSONSerialization.data(withJSONObject: raw)))
    }
    func testExistingValidLongBindingsAreLimitedBySerializedEnvelopeOnly() throws {
        var raw = try JSONSerialization.jsonObject(with: fixture("config-v2.json")) as! [String: Any]
        var binding = raw["custody"] as! [String: Any]
        binding["occurrenceId"] = String(repeating: "会", count: 400) + "@2026-09-02T14:00:00Z"
        binding["bridgeSessionId"] = String(repeating: "话", count: 200)
        raw["custody"] = binding
        XCTAssertNotNil(try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: raw), inspection: false).custody)
        var largest = binding
        largest["schema"] = "bridge-process-outcome/v1"; largest["outcome"] = "departure_unconfirmed"
        largest["reason"] = "departure_not_observed"; largest["observedAt"] = "9999-12-31T23:59:59.999Z"
        largest["bridgeSessionId"] = ""
        let available = 4096 - (try JSONSerialization.data(withJSONObject: largest, options: [.withoutEscapingSlashes]).count) - 1
        binding["bridgeSessionId"] = String(repeating: "x", count: available)
        XCTAssertNoThrow(try BridgeCustodyBinding(object: binding))
        for session in [String(repeating: "x", count: available + 1), String(repeating: "\"", count: available)] {
            binding["bridgeSessionId"] = session
            XCTAssertThrowsError(try BridgeCustodyBinding(object: binding))
        }
    }
    func testPrivateWriterSurvivesControlCancellationAndWritesOneLineThenEOF() throws {
        var fds: [Int32] = [0, 0]; XCTAssertEqual(pipe(&fds), 0)
        defer { Darwin.close(fds[0]) }
        let outcome = try BridgeProcessOutcome.decode(fixture("outcome-v1.json"))
        let writer = try BridgeOutcomeWriter(fd: fds[1])
        let cancellation = BridgeCancellation(); cancellation.cancel()
        try writer.write(outcome)
        XCTAssertThrowsError(try writer.write(outcome))
        var bytes = [UInt8](repeating: 0, count: 4096)
        let count = Darwin.read(fds[0], &bytes, bytes.count)
        XCTAssertGreaterThan(count, 0)
        XCTAssertEqual(bytes[count - 1], 10)
        XCTAssertEqual(try BridgeProcessOutcome.decode(Data(bytes.prefix(count))), outcome)
        XCTAssertEqual(Darwin.read(fds[0], &bytes, bytes.count), 0)
    }
    func testPrivateWriterRefusesInvalidDescriptorAndBoundsStalledReader() throws {
        XCTAssertThrowsError(try BridgeOutcomeWriter(fd: -1))
        var fds: [Int32] = [0, 0]; XCTAssertEqual(pipe(&fds), 0)
        defer { Darwin.close(fds[0]) }
        let writer = try BridgeOutcomeWriter(fd: fds[1])
        let filler = [UInt8](repeating: 65, count: 4096)
        while filler.withUnsafeBytes({ Darwin.write(fds[1], $0.baseAddress, $0.count) }) > 0 {}
        let start = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try writer.write(BridgeProcessOutcome.decode(fixture("outcome-v1.json"))))
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 1.5)
        XCTAssertEqual(fcntl(fds[1], F_GETFL), -1)
    }
    func testShutdownCachesTruthfulActionAndEvidenceOutcome() throws {
        for action in [false, true] {
            for evidenceFails in [false, true] {
                let sink = MemoryEvidenceSink()
                let driver = FakeAccessibilityDriver(snapshots: action ? [FakeTree.idleWithJoinSurface(), nil, FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()] : [nil])
                let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink, output: { _ in })
                try process.accept(BridgeCommandMessage(sessionId: "s", commandId: "j", command: .join(meetingOccurrenceId: "meeting@2026-09-02T14:00:00Z", meetingNo: "900000001", leaseId: "l")))
                sink.fail = evidenceFails
                try? process.shutdown()
                let result = try XCTUnwrap(process.shutdownResult)
                XCTAssertEqual(result.outcome, action ? (evidenceFails ? "departure_unconfirmed" : "departure_confirmed") : "no_join_action")
                if action && evidenceFails { XCTAssertEqual(result.reason, "evidence_unavailable") }
                let count = driver.pressed.count
                try? process.shutdown()
                XCTAssertEqual(process.shutdownResult, result)
                XCTAssertEqual(driver.pressed.count, count)
            }
        }
    }

    func testBoundJoinCannotIssueActionForOtherSessionOrOccurrence() throws {
        let binding = try BridgeProcessOutcome.decode(fixture("outcome-v1.json")).binding
        for sessionMismatch in [true, false] {
            let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting()])
            let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: MemoryEvidenceSink(), custody: binding, output: { _ in })
            XCTAssertThrowsError(try process.accept(.init(sessionId: sessionMismatch ? "wrong" : binding.bridgeSessionId, commandId: "join",
                command: .join(meetingOccurrenceId: sessionMismatch ? binding.occurrenceId : "wrong@2026-09-02T14:00:00Z", meetingNo: "900000001", leaseId: "l"))))
            try process.shutdown()
            XCTAssertEqual(process.shutdownResult, .noAction)
            XCTAssertTrue(driver.typed.isEmpty); XCTAssertTrue(driver.pressed.isEmpty)
        }
    }

    func testControlFailureRetainsPositivePrivateCleanupResultWithoutSuppressingError() throws {
        let binding = try BridgeProcessOutcome.decode(fixture("outcome-v1.json")).binding
        for joined in [false, true] {
            let sink = MemoryEvidenceSink()
            let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
            let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink, custody: binding, output: { _ in })
            if joined {
                try process.accept(.init(sessionId: binding.bridgeSessionId, commandId: "join", command: .join(meetingOccurrenceId: binding.occurrenceId, meetingNo: "900000001", leaseId: "l")))
            }
            let input = InvalidControlInput()
            XCTAssertThrowsError(try runBridgeControl(process: process, input: input, cancellation: BridgeCancellation(), clock: SystemBridgeClock(), observationInterval: 10)) {
                XCTAssertEqual($0 as? BridgeProcessError, .invalidInput)
            }
            XCTAssertTrue(input.reaped); XCTAssertTrue(sink.closed)
            XCTAssertEqual(process.shutdownResult, joined ? .confirmed : .noAction)
            let result = try BridgeProcessOutcome(binding: binding, status: XCTUnwrap(process.shutdownResult), observedAt: "2026-09-02T14:01:00.000Z")
            XCTAssertEqual(try BridgeProcessOutcome.decode(result.line()), result)
        }
    }

    func testNativePressFailureStillReservesJoinButValueFailureDoesNot() throws {
        for pressFailure in [false, true] {
            let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface()])
            if pressFailure { driver.refusePress.insert(FeishuUiLabels.bundled.identifiers.joinButton) }
            else { driver.refuseSetValue.insert(FeishuUiLabels.bundled.identifiers.joinMeetingNumberField) }
            let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: MemoryEvidenceSink(), output: { _ in })
            try process.accept(.init(sessionId: "s", commandId: "j", command: .join(meetingOccurrenceId: "meeting@2026-09-02T14:00:00Z", meetingNo: "900000001", leaseId: "l")))
            try? process.shutdown()
            XCTAssertEqual(process.shutdownResult?.outcome, pressFailure ? "departure_unconfirmed" : "no_join_action")
        }
    }

    func testEvidenceCloseFailureOverridesObservedDeparture() throws {
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: ClosingFailureSink(), output: { _ in })
        try process.accept(.init(sessionId: "s", commandId: "j", command: .join(meetingOccurrenceId: "meeting@2026-09-02T14:00:00Z", meetingNo: "900000001", leaseId: "l")))
        XCTAssertThrowsError(try process.shutdown())
        XCTAssertEqual(process.shutdownResult, .unconfirmed("evidence_unavailable"))
    }

    func testNativeProjectionCannotTurnMalformedWindowIntoIdleProof() {
        for fallback in [false, true] {
            for malformed in [false, true] {
                let backend = IdleProofAXBackend()
                backend.root = NativeAXAttributes(role: "AXWindow", identifier: "synthetic.home",
                    identifierRead: malformed && !fallback ? .malformed : .value("synthetic.home"),
                    titleRead: malformed && fallback ? .malformed : .value("synthetic home"))
                let labels = FeishuUiLabels(identifiers: FeishuUiLabels.bundled.identifiers,
                    titlesByIdentifier: fallback ? [FeishuUiLabels.bundled.identifiers.meetingWindow: ["synthetic meeting"]] : [:])
                let driver = AXAccessibilityDriver(backend: backend, clock: FakeDeadlineClock(), cancellation: BridgeCancellation())
                let adapter = FeishuClientAdapter(driver: driver, labels: labels, joinDeadline: 0.1)
                let result = adapter.join(meetingOccurrenceId: "meeting", meetingNo: "900000001")
                if malformed {
                    XCTAssertEqual(result, .failed(reason: "client_not_idle")); XCTAssertEqual(backend.inner.number, ""); XCTAssertEqual(backend.inner.joinPressCount, 0)
                } else { XCTAssertEqual(result, .joined(meetingOccurrenceId: "meeting")) }
            }
        }
    }

    func testNativeProjectionRequiresPositiveIdleContainerBeforeJoinAction() {
        for (role, empty, admitted) in [("AXApplication", true, false), ("AXApplication", false, false),
            ("AXWindow", false, true), ("AXSheet", false, true), ("AXDialog", false, true)] {
            let backend = IdleProofAXBackend()
            backend.root = NativeAXAttributes(role: role, identifier: "synthetic.home", title: "synthetic home")
            backend.emptyIdleChildren = empty
            let driver = AXAccessibilityDriver(backend: backend, clock: FakeDeadlineClock(), cancellation: BridgeCancellation())
            let adapter = FeishuClientAdapter(driver: driver, joinDeadline: 0.1)
            XCTAssertEqual(adapter.join(meetingOccurrenceId: "meeting", meetingNo: "900000001"),
                admitted ? .joined(meetingOccurrenceId: "meeting") : .failed(reason: "client_not_idle"))
            XCTAssertEqual(backend.inner.number, admitted ? "900000001" : "")
            XCTAssertEqual(backend.inner.joinPressCount, admitted ? 1 : 0)
            XCTAssertEqual(adapter.joinActionIssued, admitted)
        }
    }
}

private final class ClosingFailureSink: BridgeEvidenceSink {
    func append(_ line: Data) throws {}
    func close() throws { throw TestFailure.failed }
}

private final class InvalidControlInput: BridgeInputSource {
    var reachedEOF: Bool { false }
    var failed: Bool { false }
    var reaped = false
    func start() {}
    func next(wait: TimeInterval) -> Data? { Data("{\n".utf8) }
    func finish(timeout: TimeInterval) -> Bool { reaped = true; return true }
}

private final class IdleProofAXBackend: AXNativeBackend {
    let inner = JoiningAXBackend()
    var root = NativeAXAttributes(role: "AXWindow")
    var emptyIdleChildren = false
    func isApplicationValid() -> Bool { true }
    func beginSnapshot() -> String? { "root" }
    func attributes(_ handle: String) -> NativeAXAttributes? { handle == "root" && !inner.joined ? root : inner.attributes(handle) }
    func children(_ handle: String, limit: Int) -> [String]? {
        handle == "root" && !inner.joined && emptyIdleChildren ? [] : inner.children(handle, limit: limit)
    }
    func press(_ handle: String) -> Bool { inner.press(handle) }
    func setValue(_ value: String, handle: String) -> Bool { inner.setValue(value, handle: handle) }
}
