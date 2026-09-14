import XCTest

@testable import FeishuBridgeSpike

/// Adapter tests against fake accessibility trees: every control is located by a
/// stable accessibility identifier, with a localized-title fallback whose strings
/// all live in `LocalizedLabels.swift`.
final class FeishuClientAdapterTests: XCTestCase {

    private let occurrence = "900000001@2026-09-02T14:00:00Z"

    private func adapter(_ snapshots: [AccessibilityNode?]) -> (
        FeishuClientAdapter, FakeAccessibilityDriver
    ) {
        let driver = FakeAccessibilityDriver(snapshots: snapshots)
        return (FeishuClientAdapter(driver: driver), driver)
    }

    // MARK: - join

    func testJoinPreflightRejectsCandidateFreeTreeEvenWithReachableControls() {
        let controls = FakeTree.idleWithJoinSurface().children
        for children in [controls, [AccessibilityNode(role: "AXGroup", children: controls)]] {
            let tree = AccessibilityNode(role: "AXApplication", identifier: "synthetic.app", title: "synthetic app", children: children)
            let (adapter, driver) = self.adapter([tree, FakeTree.inMeeting(meetingNo: "900000001")])
            XCTAssertEqual(adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001"), .failed(reason: "client_not_idle"))
            XCTAssertTrue(driver.typed.isEmpty)
            XCTAssertTrue(driver.pressed.isEmpty)
            XCTAssertFalse(adapter.joinActionIssued)
        }
    }

    func testJoinPreflightRejectsExistingOrUnreadableMeetingBeforeAnyUIWrite() {
        for possible in [FakeTree.inMeeting(), AccessibilityNode(role: "AXWindow"), AccessibilityNode(role: "AXSheet")] {
            let tree = AccessibilityNode(role: "AXApplication", children: [FakeTree.idleWithJoinSurface(), possible])
            let (adapter, driver) = self.adapter([tree, FakeTree.inMeeting(meetingNo: "900000001")])
            XCTAssertEqual(adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001"), .failed(reason: "client_not_idle"))
            XCTAssertTrue(driver.typed.isEmpty)
            XCTAssertTrue(driver.pressed.isEmpty)
        }
    }

    func testAmbiguousMeetingWindowsAreNotPositiveAbsenceAfterLeave() {
        let duplicate = AccessibilityNode(role: "AXApplication", children: [FakeTree.inMeeting(), FakeTree.inMeeting()])
        let (adapter, _) = self.adapter([FakeTree.inMeeting(), duplicate, duplicate])
        XCTAssertEqual(adapter.leave(), .failed(reason: "still_in_meeting"))
    }

    func testJoinsByMeetingNumberAndConfirmsTheMeetingItLandedIn() {
        let (adapter, driver) = self.adapter([
            FakeTree.idleWithJoinSurface(),
            FakeTree.inMeeting(meetingNo: "900000001"),
        ])
        XCTAssertEqual(
            adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001"),
            .joined(meetingOccurrenceId: occurrence))
        XCTAssertEqual(driver.typed.map(\.text), ["900000001"])
        XCTAssertEqual(driver.pressed, [FeishuUiLabels.bundled.identifiers.joinButton])
    }

    func testRefusesToClaimAJoinWhenTheClientLandedInADifferentMeeting() {
        let (adapter, _) = self.adapter([
            FakeTree.idleWithJoinSurface(),
            FakeTree.inMeeting(meetingNo: "900000999"),
        ])
        XCTAssertEqual(
            adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001"),
            .rejected(reason: "joined_meeting_number_mismatch"),
            "a wrong meeting is reported, never reported as the requested one")
    }

    func testRefusesToClaimAJoinWhenNoMeetingWindowAppears() {
        let (adapter, _) = self.adapter([
            FakeTree.idleWithJoinSurface(),
            FakeTree.idleWithJoinSurface(),
        ])
        XCTAssertEqual(
            adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001"),
            .failed(reason: "meeting_window_not_observed"))
    }

    func testReportsAFailureWhenTheClientIsNotRunning() {
        let (adapter, _) = self.adapter([nil])
        XCTAssertEqual(
            adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001"),
            .failed(reason: "client_not_observable"))
    }

    func testJoinsThroughLocalizedTitlesWhenIdentifiersAreMissing() {
        let (adapter, _) = self.adapter([
            FakeTree.idleWithJoinSurface(localizedOnly: true),
            FakeTree.inMeeting(meetingNo: "900000001", localizedOnly: true),
        ])
        XCTAssertEqual(
            adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001"),
            .joined(meetingOccurrenceId: occurrence))
    }

    func testWaitsForTheClientToSettleBeforeJudgingTheJoin() {
        let (adapter, driver) = self.adapter([
            FakeTree.idleWithJoinSurface(),
            FakeTree.inMeeting(meetingNo: "900000001"),
        ])
        _ = adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001")
        XCTAssertEqual(
            driver.waits, [0, 60],
            "read now before pressing; then give the client the join deadline to show the window")
    }

    // MARK: - leave

    func testUnreadablePostActionTreeIsNotProofOfLeaving() {
        let (adapter, _) = self.adapter([FakeTree.inMeeting(), nil])
        XCTAssertEqual(adapter.leave(), .failed(reason: "client_not_observable"))
    }

    func testDuplicateJoinControlsCannotChooseAnArbitraryFirstMatch() {
        let idle = FakeTree.idleWithJoinSurface()
        let duplicate = AccessibilityNode(role: idle.role, identifier: idle.identifier, title: idle.title, children: idle.children + idle.children)
        let (adapter, driver) = self.adapter([duplicate, FakeTree.inMeeting()])
        XCTAssertEqual(adapter.join(meetingOccurrenceId: occurrence, meetingNo: "900000001"),
                       .failed(reason: "join_controls_not_reachable"))
        XCTAssertTrue(driver.typed.isEmpty)
        XCTAssertTrue(driver.pressed.isEmpty)
    }

    func testLeavesAndConfirmsTheMeetingWindowIsGone() {
        let (adapter, driver) = self.adapter([
            FakeTree.inMeeting(),
            FakeTree.idleWithJoinSurface(),
        ])
        XCTAssertEqual(adapter.leave(), .left)
        XCTAssertEqual(driver.pressed, [FeishuUiLabels.bundled.identifiers.leaveButton])
    }

    func testDismissesTheLeaveConfirmationWhenTheClientShowsOne() {
        let (adapter, driver) = self.adapter([
            FakeTree.inMeeting(confirmsLeave: true),
            FakeTree.inMeeting(confirmsLeave: true),
            FakeTree.idleWithJoinSurface(),
        ])
        XCTAssertEqual(adapter.leave(), .left)
        XCTAssertEqual(
            driver.pressed,
            [
                FeishuUiLabels.bundled.identifiers.leaveButton,
                FeishuUiLabels.bundled.identifiers.leaveConfirmButton,
            ])
    }

    func testDoesNotClaimToHaveLeftWhileTheMeetingWindowIsStillUp() {
        let (adapter, _) = self.adapter([FakeTree.inMeeting(), FakeTree.inMeeting()])
        XCTAssertEqual(adapter.leave(), .failed(reason: "still_in_meeting"))
    }

    // MARK: - disclosure

    func testTypesTheDisclosureIntoTheMeetingChat() {
        let (adapter, driver) = self.adapter([FakeTree.inMeeting(chat: .reachable)])
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .sent)
        XCTAssertEqual(driver.typed.map(\.text), ["A meeting agent is present."])
        XCTAssertEqual(
            driver.pressed.last, FeishuUiLabels.bundled.identifiers.chatSendButton)
    }

    func testRereadsTheTreeAfterOpeningACollapsedChatPanel() {
        // The toggle reveals the input: it is absent from the pre-press tree and
        // present in the next one. Searching the stale snapshot would report a
        // false `unavailable` and, since the attempt is already spent, skip the
        // disclosure for the whole occurrence.
        let (adapter, driver) = self.adapter([
            FakeTree.inMeeting(chat: .revealedByToggle),
            FakeTree.inMeeting(chat: .reachable),
        ])
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .sent)
        XCTAssertEqual(
            driver.pressed,
            [
                FeishuUiLabels.bundled.identifiers.chatToggle,
                FeishuUiLabels.bundled.identifiers.chatSendButton,
            ])
    }

    func testLeavesAnAlreadyOpenChatPanelAloneRatherThanTogglingItShut() {
        let (adapter, driver) = self.adapter([FakeTree.inMeeting(chat: .reachable)])
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .sent)
        XCTAssertFalse(
            driver.pressed.contains(FeishuUiLabels.bundled.identifiers.chatToggle),
            "the input was already reachable; pressing the toggle would have hidden it")
    }

    func testReportsUnavailableWhenTheChatControlIsNotThere() {
        let (adapter, driver) = self.adapter([FakeTree.inMeeting(chat: .absent)])
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .unavailable)
        XCTAssertEqual(driver.typed.count, 0, "nothing is typed when there is nowhere to type it")
    }

    func testReportsUnavailableWhenTheChatInputIsPresentButDisabled() {
        let (adapter, _) = self.adapter([FakeTree.inMeeting(chat: .disabledInput)])
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .unavailable)
    }

    func testReportsFailedWhenTheSendControlRefusesThePress() {
        let (adapter, driver) = self.adapter([FakeTree.inMeeting(chat: .reachable)])
        driver.refusePress = [FeishuUiLabels.bundled.identifiers.chatSendButton]
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .failed)
    }

    func testAttemptsTheDisclosureAtMostOncePerSession() {
        let (adapter, driver) = self.adapter([FakeTree.inMeeting(chat: .reachable)])
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .sent)
        XCTAssertNil(
            adapter.postDisclosureOnce(text: "A meeting agent is present."),
            "a second attempt is refused outright, so a duplicate disclosure cannot happen")
        XCTAssertEqual(driver.typed.count, 1)
    }

    func testASecondAttemptIsRefusedEvenAfterTheFirstOneFailed() {
        let (adapter, _) = self.adapter([FakeTree.inMeeting(chat: .absent), FakeTree.inMeeting()])
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .unavailable)
        XCTAssertNil(adapter.postDisclosureOnce(text: "A meeting agent is present."))
    }

    func testAnUnavailableDisclosureDoesNotStopTheAdapterFromLeaving() {
        let (adapter, _) = self.adapter([
            FakeTree.inMeeting(chat: .absent),
            FakeTree.inMeeting(chat: .absent),
            FakeTree.idleWithJoinSurface(),
        ])
        XCTAssertEqual(adapter.postDisclosureOnce(text: "A meeting agent is present."), .unavailable)
        XCTAssertEqual(adapter.leave(), .left)
    }
}
