import XCTest
@testable import FeishuBridgeSpike

final class UiSnapshotV2Tests: XCTestCase {
    func testRegressedAndOverlongReadsCloseCoverageAndRecoveryDoesNotInventActivation() throws {
        let clock = SyntheticPairClock()
        let producer = UiSnapshotProducer(clock: try CaptureClockPairSampler(clockDomainId: "source-process", source: clock), labels: .bundled, identity: SnapshotIdentity())
        _ = try producer.observe { tree(highlight: true) }
        clock.host -= 1
        let regression = try producer.observe { tree(highlight: true) }.snapshot
        XCTAssertNil(regression.timing); XCTAssertEqual(regression.reason, "timing_unavailable")
        XCTAssertEqual(regression.barrierBefore, "clock_reset")
        clock.host += 250_000_000
        let recovered = try producer.observe { tree(highlight: true) }.snapshot
        XCTAssertEqual(recovered.barrierBefore, "observation_drop"); XCTAssertNil(recovered.observedSpeakerChange)
        let slow = try producer.observe { clock.host += 2_000_000_001; return tree(highlight: true) }.snapshot
        XCTAssertNil(slow.timing); XCTAssertEqual(slow.state, "unreadable"); XCTAssertNil(slow.feishuUserId)
    }
    func testStartupAndUnreadabilityDoNotFabricateActivationButObservedClearThenHighlightDoes() throws {
        let source = SyntheticPairClock()
        let producer = UiSnapshotProducer(clock: try CaptureClockPairSampler(clockDomainId: "source-process", source: source), labels: .bundled, identity: SnapshotIdentity())
        let trees: [AccessibilityNode?] = [tree(highlight: true), tree(highlight: true), tree(highlight: false), tree(highlight: true), nil, tree(highlight: true)]
        for (index, tree) in trees.enumerated() {
            source.host += 250_000_000
            let observed = try producer.observe { tree }.snapshot
            XCTAssertEqual(observed.observedSpeakerChange, index == 3 ? .uiExact(feishuUserId: "user-1") : nil)
        }
    }
    func testEveryActualSnapshotIncludingUnchangedStateHasItsOwnOrderedBracket() throws {
        let clock = SyntheticPairClock()
        let producer = UiSnapshotProducer(clock: try CaptureClockPairSampler(clockDomainId: "source-process", source: clock), labels: .bundled, identity: SnapshotIdentity())
        for attempt in 1...3 {
            clock.host = UInt64(attempt) * 250_000_000
            let observation = try producer.observe {
                XCTAssertEqual(clock.calls.last, "host")
                clock.host += 100
                return self.tree(highlight: true)
            }
            XCTAssertEqual(observation.snapshot.sequence, attempt)
            XCTAssertEqual(observation.snapshot.state, "ui_exact")
            XCTAssertEqual(observation.snapshot.feishuUserId, "user-1")
            XCTAssertEqual(observation.snapshot.barrierBefore, attempt == 1 ? "stream_start" : nil)
            XCTAssertEqual(observation.snapshot.timing?.hostAfterNs, UInt64(attempt) * 250_000_000 + 100)
        }
        clock.host += 2_000_000_001
        XCTAssertEqual(try producer.observe { self.tree(highlight: true) }.snapshot.barrierBefore, "poll_gap")
    }
    func testUnreadableUnknownAmbiguousAndUnidentifiedTilesCannotSupplyExactCoverage() throws {
        let observer = AccessibilityObserver(identity: SnapshotIdentity())
        XCTAssertEqual(observer.snapshotState(from: nil).state, "unreadable")
        XCTAssertEqual(observer.snapshotState(from: tree(highlight: false)).reason, "no_highlight")
        XCTAssertEqual(observer.snapshotState(from: tree(highlight: nil)).reason, "identity_unavailable")
        let ambiguous = tree(highlight: true, extra: AccessibilityNode(role: "AXGroup", identifier: FeishuUiLabels.bundled.identifiers.speakerTilePrefix + "2", isHighlighted: true, highlightRead: true))
        XCTAssertEqual(observer.snapshotState(from: ambiguous).state, "ambiguous")
        let partial = tree(highlight: true, extra: AccessibilityNode(role: "AXGroup", identifierRead: .malformed))
        XCTAssertEqual(observer.snapshotState(from: partial).state, "unreadable")
    }
    private func tree(highlight: Bool?, extra: AccessibilityNode? = nil) -> AccessibilityNode {
        let labels = FeishuUiLabels.bundled.identifiers
        var tiles = [AccessibilityNode(role: "AXGroup", identifier: labels.speakerTilePrefix + "1", isHighlighted: highlight ?? false, highlightRead: highlight)]
        if let extra { tiles.append(extra) }
        return AccessibilityNode(role: "AXWindow", identifier: labels.meetingWindow, children: [AccessibilityNode(role: "AXGroup", identifier: labels.speakerGrid, children: tiles)])
    }
}
private struct SnapshotIdentity: UiIdentityResolver {
    func identify(uiElementId: String) -> String? { "user-" + uiElementId }
}
