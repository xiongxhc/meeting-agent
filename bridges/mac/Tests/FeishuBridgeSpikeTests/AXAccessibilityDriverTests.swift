import Foundation
import XCTest
@testable import FeishuBridgeSpike

final class AXAccessibilityDriverTests: XCTestCase {
    func testStaleSnapshotDisabledAndUnsupportedNativeHandlesNeverAct() throws {
        let native = FakeAXBackend()
        let driver = AXAccessibilityDriver(backend: native, clock: FakeDeadlineClock(), cancellation: BridgeCancellation())
        let stale = try XCTUnwrap(driver.snapshot(waitingUpTo: 0))
        let current = try XCTUnwrap(driver.snapshot(waitingUpTo: 0))
        XCTAssertFalse(driver.press(stale))
        XCTAssertTrue(driver.press(current))
        native.node = NativeAXAttributes(role: "AXButton", identifier: "synthetic.button", enabled: false, canPress: true)
        XCTAssertFalse(driver.press(current))
        native.node = NativeAXAttributes(role: "AXButton", identifier: "synthetic.button", enabled: true, canPress: false)
        XCTAssertFalse(driver.press(current))
        XCTAssertEqual(native.presses, 1)
        native.valid = false
        XCTAssertFalse(driver.press(current))
        XCTAssertNil(driver.snapshot(waitingUpTo: 0))
    }

    func testPendingWaitCanBeCancelledWithoutAnotherAction() {
        let native = FakeAXBackend(); let clock = FakeDeadlineClock(); let cancellation = BridgeCancellation()
        let driver = AXAccessibilityDriver(backend: native, clock: clock, cancellation: cancellation)
        _ = driver.snapshot(waitingUpTo: 0)
        native.onRead = { count in if count >= 3 { cancellation.cancel() } }
        XCTAssertNil(driver.snapshot(waitingUpTo: 60))
        XCTAssertLessThan(clock.time, 1)
        XCTAssertEqual(native.presses, 0)
    }

    func testWaitHonorsDeadlineAndCancellationAndRejectsOversizedTree() throws {
        let native = FakeAXBackend(); let clock = FakeDeadlineClock(); let cancellation = BridgeCancellation()
        let driver = AXAccessibilityDriver(backend: native, clock: clock, cancellation: cancellation, maxNodes: 2, maxDepth: 2, maxStringBytes: 32)
        _ = driver.snapshot(waitingUpTo: 0)
        _ = driver.snapshot(waitingUpTo: 0.2)
        XCTAssertGreaterThanOrEqual(clock.time, 0.2)
        native.onRead = { count in if count > 8 { native.node = NativeAXAttributes(role: "AXButton", identifier: "changed", enabled: true, canPress: true) } }
        let changed = driver.snapshot(waitingUpTo: 1)
        XCTAssertEqual(changed?.identifier, "changed")
        native.onRead = nil
        native.node = NativeAXAttributes(role: String(repeating: "a", count: 33))
        XCTAssertNil(driver.snapshot(waitingUpTo: 0))
        native.node = NativeAXAttributes(role: "AXButton")
        native.onRead = nil; native.childHandles = ["root"]
        XCTAssertNil(driver.snapshot(waitingUpTo: 0))
        cancellation.cancel()
        let before = native.reads
        XCTAssertNil(driver.snapshot(waitingUpTo: 60))
        XCTAssertEqual(native.reads, before)
    }

    func testProductionControlCompositionUsesNativeHandleActionsWithoutIdentityGuessing() throws {
        let backend = JoiningAXBackend()
        let driver = AXAccessibilityDriver(backend: backend, clock: FakeDeadlineClock(), cancellation: BridgeCancellation())
        var events: [BridgeEventMessage] = []
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: MemoryEvidenceSink(),
            output: { events.append(try JSONDecoder().decode(BridgeEventMessage.self, from: $0)) })
        let join = BridgeCommandMessage(sessionId: "s", commandId: "j", command: .join(meetingOccurrenceId: "900000001@2026-09-02T14:00:00Z", meetingNo: "900000001", leaseId: "l"))
        try process.accept(join); try process.accept(join)
        XCTAssertEqual(backend.joinPressCount, 1)
        XCTAssertEqual(events.first?.event, .joined(meetingOccurrenceId: "900000001@2026-09-02T14:00:00Z"))
        try process.pollObservation()
        XCTAssertFalse(events.contains { if case .participantJoined = $0.event { true } else { false } })
        XCTAssertNil(UnknownUiIdentity().identify(uiElementId: "a familiar name"))
    }
}

final class FakeDeadlineClock: BridgeDeadlineClock {
    var time: TimeInterval = 0
    func monotonicSeconds() -> TimeInterval { time }
    func pause(seconds: TimeInterval) { time += seconds }
}
final class FakeAXBackend: AXNativeBackend {
    var node = NativeAXAttributes(role: "AXButton", identifier: "synthetic.button", enabled: true, canPress: true)
    var childHandles: [String] = []; var reads = 0; var presses = 0
    var valid = true
    var onRead: ((Int) -> Void)?
    func beginSnapshot() -> String? { "root" }
    func isApplicationValid() -> Bool { valid }
    func attributes(_ handle: String) -> NativeAXAttributes? { reads += 1; onRead?(reads); return node }
    func children(_ handle: String, limit: Int) -> [String]? { childHandles }
    func press(_ handle: String) -> Bool { presses += 1; return true }
    func setValue(_ value: String, handle: String) -> Bool { true }
}
final class JoiningAXBackend: AXNativeBackend {
    var joined = false; var number = ""; var joinPressCount = 0
    let labels = FeishuUiLabels.bundled.identifiers
    func beginSnapshot() -> String? { "root" }
    func isApplicationValid() -> Bool { true }
    func attributes(_ handle: String) -> NativeAXAttributes? {
        switch handle {
        case "root": return NativeAXAttributes(role: "AXWindow", identifier: joined ? labels.meetingWindow : labels.appWindow)
        case "field": return NativeAXAttributes(role: "AXTextField", identifier: labels.joinMeetingNumberField, value: number, enabled: true, canSetValue: true)
        case "join": return NativeAXAttributes(role: "AXButton", identifier: labels.joinButton, enabled: true, canPress: true)
        case "number": return NativeAXAttributes(role: "AXStaticText", identifier: labels.meetingNumberLabel, value: number)
        default: return nil
        }
    }
    func children(_ handle: String, limit: Int) -> [String]? { handle == "root" ? (joined ? ["number"] : ["field", "join"]) : [] }
    func press(_ handle: String) -> Bool { guard handle == "join", number == "900000001" else { return false }; joined = true; joinPressCount += 1; return true }
    func setValue(_ value: String, handle: String) -> Bool { guard handle == "field" else { return false }; number = value; return true }
}
