import Foundation
import XCTest
@testable import FeishuBridgeSpike

/// Synthetic only: attribute names below are invented for the test, handles use
/// the `ou_0000...` fixture pattern, and display names are `Test Participant N`.
final class MeasuredSpeakerSelectorsTests: XCTestCase {
    private let ids = FeishuUiLabels.bundled.identifiers
    private let measured = MeasuredSpeakerSelectors(
        identity: .init(attribute: "AXDOMIdentifier", pattern: "^ou_[0-9]{8}$"),
        highlight: .init(attribute: "SyntheticSpeaking", speakingValue: "1"))

    // T1
    func testUnmeasuredDefaultReadsNothingExtraAndResolvesNobody() throws {
        XCTAssertTrue(MeasuredSpeakerSelectors.unmeasured.resolver() is UnknownUiIdentity)
        let backend = meeting(rows: [("row-1", "Test Participant One", ["AXDOMIdentifier": .value("ou_00000001")])],
                              tiles: [("tile-1", ["AXDOMIdentifier": .value("ou_00000001"), "SyntheticSpeaking": .value("1"), "AXSelected": .value("true")])])
        let tree = try XCTUnwrap(driver(backend, .unmeasured).snapshot(waitingUpTo: 0))
        XCTAssertEqual(backend.attributeReads, [], "no extra AX read without a measured selector")
        let observer = AccessibilityObserver(identity: MeasuredSpeakerSelectors.unmeasured.resolver())
        XCTAssertEqual(observer.snapshotState(from: tree).state, "unknown")
        XCTAssertEqual(observer.snapshotState(from: tree).reason, "identity_unavailable")
        XCTAssertEqual(roster(observer, tree), [])
        XCTAssertEqual(try decode(identity: nil, highlight: nil).speakerSelectors, .unmeasured)
    }

    // T2
    func testPlaceholderNameFocusAndLooseSelectorsAreRefusedAtConfig() throws {
        let placeholder = MeasuredSpeakerSelectors.placeholder
        let refusedIdentity: [Any] = [
            ["attribute": placeholder.identity!.attribute, "pattern": "^ou_[0-9]{8}$"],
            ["attribute": "AXDOMIdentifier", "pattern": placeholder.identity!.pattern],
            ["attribute": "AXTitle", "pattern": "^ou_[0-9]{8}$"], ["attribute": "AXDescription", "pattern": "^ou_[0-9]{8}$"],
            ["attribute": "AXSelected", "pattern": "^ou_[0-9]{8}$"], ["attribute": "AXDOMIdentifier", "pattern": "ou_[0-9]{8}"],
            ["attribute": "AXDOMIdentifier", "pattern": "^.*$"], ["attribute": "AXDOMIdentifier", "pattern": "^([$"],
            ["attribute": "AXDOMIdentifier", "pattern": "^ou_[0-9]{8}$", "fallback": "name"], ["attribute": "", "pattern": "^ou_[0-9]{8}$"],
            "AXDOMIdentifier"]
            + ["AXValue", "AXHelp", "AXValueDescription", "AXTitleUIElement", "SyntheticHandle"].map { ["attribute": $0, "pattern": "^ou_[0-9]{8}$"] as Any }
            + ["^(a+)+$", "^a|b$", "^.+$", "^(ou_[0-9]+)$", "^[a-z]+[0-9]+$", "^a{1,}$", "^ou_[^,]+$", "^a++$", "^\\w+$"].map { ["attribute": "AXDOMIdentifier", "pattern": $0] as Any }
        for identity in refusedIdentity { XCTAssertThrowsError(try decode(identity: identity, highlight: nil), "\(identity)") }
        let refusedHighlight: [Any] = [
            ["attribute": placeholder.highlight!.attribute, "speakingValue": "1"],
            ["attribute": "SyntheticSpeaking", "speakingValue": placeholder.highlight!.speakingValue],
            ["attribute": "AXSelected", "speakingValue": "true"], ["attribute": "AXFocused", "speakingValue": "true"],
            ["attribute": "AXTitle", "speakingValue": "1"], ["attribute": "AXIdentifier", "speakingValue": "1"],
            ["attribute": "SyntheticSpeaking", "speakingValue": ""], ["attribute": "SyntheticSpeaking", "speakingValue": "1", "fallback": "AXSelected"]]
        for highlight in refusedHighlight { XCTAssertThrowsError(try decode(identity: nil, highlight: highlight), "\(highlight)") }
        let accepted = try decode(identity: ["attribute": "AXDOMIdentifier", "pattern": "^ou_[0-9]{8}$"],
                                  highlight: ["attribute": "SyntheticSpeaking", "speakingValue": "1"])
        XCTAssertEqual(accepted.speakerSelectors, measured)
        XCTAssertTrue(accepted.speakerSelectors.resolver() is ConfiguredUiIdentity)
        for pattern in ["^ou_[0-9a-f]+$", "^ou_[0-9a-f]{32}$", "^[a-z]{2}_[0-9a-zA-Z_-]{8,64}$", "^id\\.\\d{6}$"] {
            XCTAssertNoThrow(try decode(identity: ["attribute": "AXIdentifier", "pattern": pattern], highlight: nil), pattern)
        }
        // A catastrophic pattern never reaches the matcher, so it cannot stall the control thread.
        XCTAssertNil(ConfiguredUiIdentity(.init(attribute: "AXDOMIdentifier", pattern: "^(a+)+$")))
        XCTAssertFalse(ConfiguredUiIdentity.isLinear("^(a+)+$"))
    }

    func testMatchingIsWholeValueNotASearch() throws {
        let alternation = try NSRegularExpression(pattern: "^a|b$")
        XCTAssertFalse(ConfiguredUiIdentity.matches(alternation, "xxb"))
        XCTAssertFalse(ConfiguredUiIdentity.matches(alternation, "ab"))
        XCTAssertTrue(ConfiguredUiIdentity.matches(alternation, "b"))
        let resolver = try XCTUnwrap(ConfiguredUiIdentity(.init(attribute: "AXIdentifier", pattern: "^ou_[0-9]{8}$")))
        XCTAssertNil(resolver.identify(uiElementId: "ou_00000001\n"), "a trailing newline is not a handle")
        XCTAssertNil(resolver.identify(uiElementId: "xou_00000001"))
        XCTAssertEqual(resolver.identify(uiElementId: "ou_00000001"), "ou_00000001")
    }

    // T3
    func testMeasuredIdentityNamesRowsThatCarryItAndDropsTheRest() throws {
        let backend = meeting(rows: [
            ("row-1", "Test Participant One", ["AXDOMIdentifier": .value("ou_00000001")]),
            ("row-2", "Test Participant Two", [:]),
            ("row-3", "ou_00000003", ["AXDOMIdentifier": .value("ou_00000003")]),
            ("row-4", "Test Participant Four", ["AXDOMIdentifier": .malformed]),
            ("row-5", "Test Participant Five", ["AXDOMIdentifier": .value("Test Participant Five")]),
            ("row-6", "Test Participant Six", ["AXDOMIdentifier": .value("ou_00000006\n")])], tiles: [("tile-1", [:])])
        let tree = try XCTUnwrap(driver(backend, measured).snapshot(waitingUpTo: 0))
        let identity = measured.resolver()
        XCTAssertEqual(roster(AccessibilityObserver(identity: identity), tree), [RosterEntry(feishuUserId: "ou_00000001", displayName: "Test Participant One")])
        let reducer = SessionObservationReducer(sessionId: "s", identity: identity, chatControl: FakeChatControl(outcome: .unavailable))
        let events = AccessibilityObserver(identity: identity).observations(from: tree, at: "2026-09-02T14:00:00Z").flatMap(reducer.reduce).map(\.event)
        XCTAssertEqual(events, [.participantJoined(feishuUserId: "ou_00000001", displayName: "Test Participant One")])

        let byIdentifier = try XCTUnwrap(ConfiguredUiIdentity(.init(attribute: "AXIdentifier", pattern: "^ou_[0-9]{8}$")))
        XCTAssertEqual(byIdentifier.identify(uiElementId: "ou_00000007"), "ou_00000007")
        XCTAssertNil(byIdentifier.identify(uiElementId: "row-7"))
        XCTAssertNil(try XCTUnwrap(ConfiguredUiIdentity(measured.identity!)).identify(uiElementId: "ou_00000007"),
                     "a non-identifier attribute cannot be recovered from the element id alone")
    }

    // T4
    func testMeasuredHighlightProducesExactAmbiguousAndUnknownHonestly() throws {
        func state(_ tiles: [(String, [String: AXStringRead])]) throws -> UiSnapshotState {
            let tree = try XCTUnwrap(driver(meeting(rows: [], tiles: tiles), measured).snapshot(waitingUpTo: 0))
            return AccessibilityObserver(identity: measured.resolver()).snapshotState(from: tree)
        }
        let lit: [String: AXStringRead] = ["SyntheticSpeaking": .value("1"), "AXDOMIdentifier": .value("ou_00000001")]
        let dark: [String: AXStringRead] = ["SyntheticSpeaking": .value("0"), "AXDOMIdentifier": .value("ou_00000002")]
        let exact = try state([("tile-1", lit), ("tile-2", dark)])
        XCTAssertEqual(exact.state, "ui_exact"); XCTAssertEqual(exact.feishuUserId, "ou_00000001")
        XCTAssertEqual(try state([("tile-1", lit), ("tile-2", ["SyntheticSpeaking": .value("1"), "AXDOMIdentifier": .value("ou_00000002")])]).state, "ambiguous")
        let unresolved = try state([("tile-1", ["SyntheticSpeaking": .value("1")]), ("tile-2", dark)])
        XCTAssertEqual(unresolved.state, "ambiguous"); XCTAssertEqual(unresolved.reason, "identity_unavailable"); XCTAssertNil(unresolved.feishuUserId)
        for unreadable: AXStringRead in [.absent, .malformed] {
            let unknown = try state([("tile-1", lit), ("tile-2", ["SyntheticSpeaking": unreadable, "AXDOMIdentifier": .value("ou_00000002")])])
            XCTAssertEqual(unknown.state, "unknown"); XCTAssertEqual(unknown.reason, "identity_unavailable")
        }
        XCTAssertEqual(try state([("tile-1", dark)]).reason, "no_highlight")
    }

    // T5
    func testSelectedOrFocusedTilesNeverBecomeASpeakingHighlight() throws {
        let tiles: [(String, [String: AXStringRead])] = [("tile-1", ["AXSelected": .value("true"), "AXFocused": .value("true"), "AXDOMIdentifier": .value("ou_00000001")])]
        for selectors in [MeasuredSpeakerSelectors.unmeasured, measured] {
            let backend = meeting(rows: [], tiles: tiles)
            let tree = try XCTUnwrap(driver(backend, selectors).snapshot(waitingUpTo: 0))
            let tile = try XCTUnwrap(tree.firstDescendant { $0.identifier == self.ids.speakerTilePrefix + "tile-1" })
            XCTAssertNil(tile.highlightRead); XCTAssertFalse(tile.isHighlighted)
            XCTAssertFalse(backend.attributeReads.contains { ["AXSelected", "AXFocused"].contains($0) })
            XCTAssertNotEqual(AccessibilityObserver(identity: selectors.resolver()).snapshotState(from: tree).state, "ui_exact")
        }
    }

    // T6
    func testStalledOrFailingResolverNeverStopsCaptureDelivery() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        socket.feed(try authAcceptedFixture())
        let media = TimedMediaControlOwner(session: try makeTimedSession(socket, capture, engine, clock), cancellation: BridgeCancellation())
        let tile = AccessibilityNode(role: "AXGroup", identifier: ids.speakerTilePrefix + "tile-1", isHighlighted: true, highlightRead: true,
                                     measuredIdentity: .value("ou_00000001"))
        let inMeeting = AccessibilityNode(role: "AXWindow", identifier: ids.meetingWindow, children: [
            AccessibilityNode(role: "AXStaticText", identifier: ids.meetingNumberLabel, value: "123456789"),
            AccessibilityNode(role: "AXButton", identifier: ids.leaveButton),
            AccessibilityNode(role: "AXGroup", identifier: ids.speakerGrid, children: [tile])])
        let fake = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface()] + Array(repeating: inMeeting, count: 4) + [FakeTree.idleWithJoinSurface()])
        let resolver = StallingResolver()
        let events = EventLog()
        let process = BridgeProcess(driver: fake, labels: .bundled, clock: SystemBridgeClock(), sink: MemoryEvidenceSink(),
            v2Clock: try CaptureClockPairSampler(clockDomainId: "source-process", source: clock), timedMedia: media,
            identity: resolver, output: { events.append(try JSONSerialization.jsonObject(with: $0) as! [String: Any]) })
        let fixture = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/contracts/bridge-session-v2.json")) as! [String: Any]
        for object in fixture["commands"] as! [[String: Any]] {
            try process.accept(BridgeCommandMessageV2.decode(JSONSerialization.data(withJSONObject: object)))
        }
        XCTAssertTrue(events.contains("media_connected"))
        let box = UncheckedBox(process)
        let poll = Thread { try? box.value.pollObservation() }
        poll.start()
        XCTAssertTrue(resolver.entered.wait(timeout: .now() + 10) == .success, "observation reached the resolver")
        // The UI observation loop is stalled inside the resolver.
        capture.emit(try syntheticAudio(rate: 48_000, channels: 1, values: [Array(repeating: 0.25, count: 1926)]))
        await waitForAudio { socket.writes.contains { $0[5] == 2 } }
        XCTAssertTrue(socket.writes.contains { $0[5] == 2 }, "capture frames reach the recorder while the resolver stalls")
        XCTAssertFalse(socket.closed)
        try await Task.sleep(for: .milliseconds(2_100)) // past the 2 s AX read deadline
        XCTAssertFalse(poll.isFinished); XCTAssertFalse(socket.closed)
        resolver.release.signal()
        while !poll.isFinished { try await Task.sleep(for: .milliseconds(10)) }
        let snapshot = try XCTUnwrap(events.last("ui_snapshot"))
        XCTAssertEqual(snapshot["state"] as? String, "ambiguous", "a failed resolution degrades UI evidence only")
        XCTAssertEqual(snapshot["reason"] as? String, "identity_unavailable")
        try box.value.pollObservation()
        XCTAssertEqual(events.last("ui_snapshot")?["state"] as? String, "ambiguous")
        try box.value.shutdown()
        XCTAssertEqual(box.value.shutdownResult, .confirmed); XCTAssertTrue(socket.closed)
        XCTAssertEqual(capture.stopCount, 1)
    }

    // T7
    func testRosterAndSpeakerIdsComeFromOneConfiguredNamespace() throws {
        let backend = meeting(rows: [("row-1", "Test Participant One", ["AXDOMIdentifier": .value("ou_00000001")])],
                              tiles: [("tile-a", ["AXDOMIdentifier": .value("ou_00000001"), "SyntheticSpeaking": .value("1")])])
        let tree = try XCTUnwrap(driver(backend, measured).snapshot(waitingUpTo: 0))
        let observer = AccessibilityObserver(identity: measured.resolver())
        XCTAssertEqual(roster(observer, tree).map(\.feishuUserId), [observer.snapshotState(from: tree).feishuUserId])
        let foreign = meeting(rows: [("row-1", "Test Participant One", ["AXDOMIdentifier": .value("ou_00000001")])],
                              tiles: [("tile-a", ["AXDOMIdentifier": .value("tile-internal-17"), "SyntheticSpeaking": .value("1")])])
        let mismatched = observer.snapshotState(from: try XCTUnwrap(driver(foreign, measured).snapshot(waitingUpTo: 0)))
        XCTAssertEqual(mismatched.state, "ambiguous"); XCTAssertNil(mismatched.feishuUserId)
    }

    // MARK: helpers

    private func decode(identity: Any?, highlight: Any?) throws -> BridgeProcessConfiguration {
        var identifiers = try JSONSerialization.jsonObject(with: JSONEncoder().encode(FeishuUiLabels.bundled.identifiers)) as! [String: String]
        for key in identifiers.keys { identifiers[key] = "measured-" + key }
        var selectors: [String: Any] = ["build": "1", "locale": "en-US", "measured": true, "identifiers": identifiers, "titles": [:]]
        if let identity { selectors["identity"] = identity }
        if let highlight { selectors["highlight"] = highlight }
        let object: [String: Any] = ["schema": "feishu-bridge-config/v1", "pid": 123,
            "bundlePath": "/Applications/Synthetic.app", "bundleIdentifier": "test.synthetic", "bundleVersion": "1", "locale": "en-US",
            "evidenceRoot": "/private/tmp/synthetic-evidence", "observationIntervalMs": 200, "joinDeadlineMs": 1000,
            "actionDeadlineMs": 500, "axCallTimeoutMs": 50, "selectors": selectors]
        return try BridgeProcessConfiguration.decode(JSONSerialization.data(withJSONObject: object), inspection: false)
    }
    private func driver(_ backend: MeasuredTreeBackend, _ selectors: MeasuredSpeakerSelectors) -> AXAccessibilityDriver {
        AXAccessibilityDriver(backend: backend, clock: FakeDeadlineClock(), cancellation: BridgeCancellation(), measured: selectors)
    }
    private func roster(_ observer: AccessibilityObserver, _ tree: AccessibilityNode) -> [RosterEntry] {
        for case .rosterSnapshot(_, let participants) in observer.observations(from: tree, at: "2026-09-02T14:00:00Z") { return participants }
        return []
    }
    private func meeting(rows: [(String, String, [String: AXStringRead])], tiles: [(String, [String: AXStringRead])]) -> MeasuredTreeBackend {
        var nodes: [String: MeasuredTreeBackend.Node] = [
            "root": .init(NativeAXAttributes(role: "AXWindow", identifier: ids.meetingWindow), ["grid", "panel"]),
            "grid": .init(NativeAXAttributes(role: "AXGroup", identifier: ids.speakerGrid), tiles.map { "tile:" + $0.0 }),
            "panel": .init(NativeAXAttributes(role: "AXOutline", identifier: ids.participantsPanel), rows.map { "row:" + $0.0 })]
        for (id, extra) in tiles { nodes["tile:" + id] = .init(NativeAXAttributes(role: "AXGroup", identifier: ids.speakerTilePrefix + id), [], extra) }
        for (id, name, extra) in rows { nodes["row:" + id] = .init(NativeAXAttributes(role: "AXRow", identifier: ids.participantRowPrefix + id, title: name), [], extra) }
        return MeasuredTreeBackend(nodes)
    }
}

final class MeasuredTreeBackend: AXNativeBackend {
    struct Node {
        let fields: NativeAXAttributes, children: [String], extra: [String: AXStringRead]
        init(_ fields: NativeAXAttributes, _ children: [String], _ extra: [String: AXStringRead] = [:]) {
            self.fields = fields; self.children = children; self.extra = extra
        }
    }
    let nodes: [String: Node]
    private(set) var attributeReads: [String] = []
    init(_ nodes: [String: Node]) { self.nodes = nodes }
    func isApplicationValid() -> Bool { true }
    func beginSnapshot() -> String? { "root" }
    func attributes(_ handle: String) -> NativeAXAttributes? { nodes[handle]?.fields }
    func children(_ handle: String, limit: Int) -> [String]? { nodes[handle]?.children }
    func press(_ handle: String) -> Bool { false }
    func setValue(_ value: String, handle: String) -> Bool { false }
    func attribute(_ name: String, handle: String) -> AXStringRead {
        attributeReads.append(name); return nodes[handle]?.extra[name] ?? .absent
    }
}

/// Blocks the UI observation path until released, then fails to resolve.
private final class StallingResolver: UiIdentityResolver, @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    private var stalled = false
    func identify(uiElementId: String) -> String? { nil }
    func identify(node: AccessibilityNode, uiElementId: String) -> String? {
        if !stalled { stalled = true; entered.signal(); _ = release.wait(timeout: .now() + 30) }
        return nil
    }
}
private final class EventLog: @unchecked Sendable {
    private let lock = NSLock(); private var items: [[String: Any]] = []
    func append(_ item: [String: Any]) { lock.withLock { items.append(item) } }
    func contains(_ type: String) -> Bool { lock.withLock { items.contains { $0["type"] as? String == type } } }
    func last(_ type: String) -> [String: Any]? { lock.withLock { items.last { $0["type"] as? String == type } } }
}
private final class UncheckedBox<Value>: @unchecked Sendable { let value: Value; init(_ value: Value) { self.value = value } }
