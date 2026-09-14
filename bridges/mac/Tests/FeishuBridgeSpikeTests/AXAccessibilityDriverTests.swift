import Foundation
import XCTest
@testable import FeishuBridgeSpike

final class AXAccessibilityDriverTests: XCTestCase {
    func testNativeMalformedLocatorProjectionKeepsProcessDepartureUnconfirmed() throws {
        XCTAssertEqual(AXStringRead(rawValue: nil), .absent)
        XCTAssertEqual(AXStringRead(rawValue: ""), .value(""))
        XCTAssertEqual(AXStringRead(rawValue: NSNumber(value: 7)), .malformed)
        for malformedTitle in [false, true] {
            let backend = JoiningAXBackend()
            backend.afterLeave = NativeAXAttributes(role: "AXWindow", identifier: "synthetic.home",
                identifierRead: malformedTitle ? .value("synthetic.home") : AXStringRead(rawValue: NSNumber(value: 7)),
                titleRead: malformedTitle ? AXStringRead(rawValue: NSNumber(value: 7)) : .value("synthetic home"))
            let driver = AXAccessibilityDriver(backend: backend, clock: FakeDeadlineClock(), cancellation: BridgeCancellation())
            let labels = FeishuUiLabels(identifiers: FeishuUiLabels.bundled.identifiers,
                titlesByIdentifier: malformedTitle ? [FeishuUiLabels.bundled.identifiers.meetingWindow: ["synthetic meeting"]] : [:])
            var events: [BridgeEventMessage] = []
            let process = BridgeProcess(driver: driver, labels: labels, clock: SequentialClock(start: "2026-09-02T14:00:00Z"), sink: MemoryEvidenceSink(), actionDeadline: 0.1,
                output: { events.append(try JSONDecoder().decode(BridgeEventMessage.self, from: $0)) })
            try process.accept(.init(sessionId: "s", commandId: "j", command: .join(meetingOccurrenceId: "occ", meetingNo: "900000001", leaseId: "l")))
            try process.accept(.init(sessionId: "s", commandId: "leave", command: .leave(reason: .coordinatorStop)))
            let projected = try XCTUnwrap(driver.snapshot(waitingUpTo: 0))
            XCTAssertEqual(malformedTitle ? projected.titleRead : projected.identifierRead, .malformed)
            XCTAssertFalse(events.contains { if case .left = $0.event { true } else { false } })
            XCTAssertTrue(events.contains { $0.event == .commandResult(commandId: "leave", outcome: .failed, detail: "client_not_observable") })
            try process.accept(.init(sessionId: "s", commandId: "release", command: .releaseLease(leaseId: "l")))
            XCTAssertTrue(events.contains { $0.event == .commandResult(commandId: "release", outcome: .rejected, detail: "lease_not_releasable") })
        }
    }

    func testNativeNonNilButUnidentifiedContainersCannotConfirmLeave() throws {
        for role in ["AXWindow", "AXSheet", "AXDialog", "AXGroup"] {
            let backend = LeavingAXBackend(role: role, finalIdentifier: nil, finalTitle: nil)
            let driver = AXAccessibilityDriver(backend: backend, clock: FakeDeadlineClock(), cancellation: BridgeCancellation())
            let labels = FeishuUiLabels(identifiers: FeishuUiLabels.bundled.identifiers, titlesByIdentifier: [:])
            let adapter = FeishuClientAdapter(driver: driver, labels: labels, actionDeadline: 0.1)
            XCTAssertEqual(adapter.leave(), .failed(reason: "client_not_observable"), role)
            XCTAssertNotNil(driver.snapshot(waitingUpTo: 0), "structural traversal succeeds; locator evidence does not")
            XCTAssertEqual(backend.presses, 1)
        }
        let duplicate = LeavingAXBackend(role: "AXGroup", finalIdentifier: nil, finalTitle: nil)
        duplicate.duplicateInitialContainer = true
        let driver = AXAccessibilityDriver(backend: duplicate, clock: FakeDeadlineClock(), cancellation: BridgeCancellation())
        XCTAssertEqual(FeishuClientAdapter(driver: driver, actionDeadline: 0.1).leave(), .failed(reason: "client_not_observable"),
            "ambiguous pre-leave matches still identify a possible container role")
    }

    func testNativeLeaveRequiresOnlyConfiguredLocatorChannelsOnPossibleContainers() {
        for fallback in [false, true] {
            for title in [nil, "synthetic home"] as [String?] {
                let backend = LeavingAXBackend(role: "AXWindow", finalIdentifier: "synthetic.home", finalTitle: title)
                let driver = AXAccessibilityDriver(backend: backend, clock: FakeDeadlineClock(), cancellation: BridgeCancellation())
                let labels = FeishuUiLabels(identifiers: FeishuUiLabels.bundled.identifiers,
                    titlesByIdentifier: fallback ? [FeishuUiLabels.bundled.identifiers.meetingWindow: ["synthetic meeting"]] : [:])
                let adapter = FeishuClientAdapter(driver: driver, labels: labels, actionDeadline: 0.1)
                XCTAssertEqual(adapter.leave(), fallback && title == nil ? .failed(reason: "client_not_observable") : .left)
            }
        }
    }

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

final class LeavingAXBackend: AXNativeBackend {
    let role: String, finalIdentifier: String?, finalTitle: String?
    var presses = 0
    var duplicateInitialContainer = false
    init(role: String, finalIdentifier: String?, finalTitle: String?) {
        self.role = role; self.finalIdentifier = finalIdentifier; self.finalTitle = finalTitle
    }
    func isApplicationValid() -> Bool { true }
    func beginSnapshot() -> String? { "root" }
    func attributes(_ handle: String) -> NativeAXAttributes? {
        switch handle {
        case "root": return NativeAXAttributes(role: "AXApplication")
        case "window", "duplicate": return NativeAXAttributes(role: role, identifier: presses == 0 ? FeishuUiLabels.bundled.identifiers.meetingWindow : finalIdentifier, title: presses == 0 ? "synthetic meeting" : finalTitle)
        case "leave": return NativeAXAttributes(role: "AXButton", identifier: FeishuUiLabels.bundled.identifiers.leaveButton, enabled: true, canPress: true)
        default: return NativeAXAttributes(role: "AXStaticText") // Unrelated optional attributes may be absent.
        }
    }
    func children(_ handle: String, limit: Int) -> [String]? {
        if handle == "root" { return ["window", "unrelated"] + (duplicateInitialContainer && presses == 0 ? ["duplicate"] : []) }
        return handle == "window" && presses == 0 ? ["leave"] : []
    }
    func press(_ handle: String) -> Bool { guard handle == "leave" else { return false }; presses += 1; return true }
    func setValue(_ value: String, handle: String) -> Bool { false }
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
    var afterLeave: NativeAXAttributes?
    var leavePressed = false
    let labels = FeishuUiLabels.bundled.identifiers
    func beginSnapshot() -> String? { "root" }
    func isApplicationValid() -> Bool { true }
    func attributes(_ handle: String) -> NativeAXAttributes? {
        switch handle {
        case "root": return leavePressed ? afterLeave : NativeAXAttributes(role: "AXWindow", identifier: joined ? labels.meetingWindow : labels.appWindow)
        case "field": return NativeAXAttributes(role: "AXTextField", identifier: labels.joinMeetingNumberField, value: number, enabled: true, canSetValue: true)
        case "join": return NativeAXAttributes(role: "AXButton", identifier: labels.joinButton, enabled: true, canPress: true)
        case "number": return NativeAXAttributes(role: "AXStaticText", identifier: labels.meetingNumberLabel, value: number)
        case "leave": return NativeAXAttributes(role: "AXButton", identifier: labels.leaveButton, enabled: true, canPress: true)
        default: return nil
        }
    }
    func children(_ handle: String, limit: Int) -> [String]? { handle == "root" && !leavePressed ? (joined ? ["number", "leave"] : ["field", "join"]) : [] }
    func press(_ handle: String) -> Bool {
        if handle == "leave", afterLeave != nil { leavePressed = true; return true }
        guard handle == "join", number == "900000001" else { return false }; joined = true; joinPressCount += 1; return true
    }
    func setValue(_ value: String, handle: String) -> Bool { guard handle == "field" else { return false }; number = value; return true }
}
