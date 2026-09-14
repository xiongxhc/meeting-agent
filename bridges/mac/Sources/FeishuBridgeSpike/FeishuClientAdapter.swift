import Foundation

/// Drives the Feishu client's UI. A real implementation wraps `AXUIElement`
/// actions (`AXUIElementPerformAction`, `kAXValueAttribute` writes) and needs the
/// macOS Accessibility grant; the tests substitute a fake that serves scripted
/// trees and records what was pressed and typed.
public protocol AccessibilityDriver {
    /// The client's accessibility tree, or nil when the client is not running or
    /// cannot be read.
    ///
    /// **Timing contract, and it is load-bearing.** `seconds` is how long the
    /// caller is willing to wait for a UI transition it just triggered. An
    /// implementation must keep re-reading until either the tree changes from
    /// the one the previous call returned or `seconds` elapses, and must return
    /// the last tree it read either way — it must not return a stale tree
    /// immediately and call that the outcome. A driver that ignores `seconds`
    /// makes every post-action check race the client: a real join takes seconds,
    /// and a waiting-room join takes as long as the host takes to admit, so an
    /// immediate read reports `meeting_window_not_observed` on essentially every
    /// real run. `seconds == 0` means "read now, do not wait" and is what the
    /// adapter passes before it has pressed anything.
    func snapshot(waitingUpTo seconds: TimeInterval) -> AccessibilityNode?
    func press(_ node: AccessibilityNode) -> Bool
    func setValue(_ text: String, on node: AccessibilityNode) -> Bool
}

public enum JoinOutcome: Equatable, Sendable {
    case joined(meetingOccurrenceId: String)
    /// The client is somewhere else than asked — reported, never relabelled as
    /// the requested meeting.
    case rejected(reason: String)
    case failed(reason: String)
}

public enum LeaveOutcome: Equatable, Sendable {
    case left
    case failed(reason: String)
}

/// The smallest adapter that can join, leave, and type one disclosure.
///
/// Two rules shape it. First, a claim is only made once the UI shows it: `join`
/// returns `.joined` only after the meeting window is on screen *and* shows the
/// meeting number that was asked for, and `leave` returns `.left` only after the
/// meeting window is gone. Second, the disclosure is attempted at most once per
/// adapter — the attempt is marked before it is made, so even a failure mid-way
/// cannot become a second message in the meeting chat.
public final class FeishuClientAdapter {
    private let driver: any AccessibilityDriver
    private let labels: FeishuUiLabels
    private let joinDeadline: TimeInterval
    private let actionDeadline: TimeInterval
    private var disclosureAttempted = false
    public private(set) var departureUnconfirmed = false
    public private(set) var joinActionIssued = false

    /// - Parameters:
    ///   - joinDeadline: how long to let the client take to show the meeting
    ///     window after the join is pressed. Generous by default because a
    ///     waiting-room join takes as long as the host takes to admit.
    ///   - actionDeadline: how long to let a within-meeting control take to
    ///     redraw after a press.
    public init(
        driver: any AccessibilityDriver,
        labels: FeishuUiLabels = .bundled,
        joinDeadline: TimeInterval = 60,
        actionDeadline: TimeInterval = 5
    ) {
        self.driver = driver
        self.labels = labels
        self.joinDeadline = joinDeadline
        self.actionDeadline = actionDeadline
    }

    public func join(meetingOccurrenceId: String, meetingNo: String) -> JoinOutcome {
        guard let tree = driver.snapshot(waitingUpTo: 0) else {
            return .failed(reason: "client_not_observable")
        }
        guard !tree.hasPossibleMatch(labels.identifiers.meetingWindow, labels),
              tree.hasCompleteDepartureLocators(labels.identifiers.meetingWindow, labels, matchedRoles: []) else {
            return .failed(reason: "client_not_idle")
        }
        guard let field = tree.locate(labels.identifiers.joinMeetingNumberField, labels),
            let button = tree.locate(labels.identifiers.joinButton, labels)
        else {
            return .failed(reason: "join_controls_not_reachable")
        }
        guard driver.setValue(meetingNo, on: field) else {
            return .failed(reason: "meeting_number_not_accepted")
        }
        guard button.isEnabled else { return .failed(reason: "join_control_not_actionable") }
        joinActionIssued = true
        departureUnconfirmed = true // A native action timeout may still have joined.
        guard driver.press(button) else {
            return .failed(reason: "join_control_not_actionable")
        }

        guard
            let joined = driver.snapshot(waitingUpTo: joinDeadline)?
                .locate(labels.identifiers.meetingWindow, labels)
        else {
            return .failed(reason: "meeting_window_not_observed")
        }
        guard let shown = joined.locate(labels.identifiers.meetingNumberLabel, labels)?.value else {
            return .failed(reason: "joined_meeting_number_not_observable")
        }
        guard shown == meetingNo else { return .rejected(reason: "joined_meeting_number_mismatch") }

        return .joined(meetingOccurrenceId: meetingOccurrenceId)
    }

    public func leave() -> LeaveOutcome {
        guard let tree = driver.snapshot(waitingUpTo: 0) else {
            return .failed(reason: "client_not_observable")
        }
        guard let leaveButton = tree.locate(labels.identifiers.leaveButton, labels) else {
            return .failed(reason: "leave_control_not_reachable")
        }
        guard driver.press(leaveButton) else { return .failed(reason: "leave_control_not_actionable") }

        guard let after = driver.snapshot(waitingUpTo: actionDeadline) else {
            return .failed(reason: "client_not_observable")
        }
        if let confirm = after.locate(labels.identifiers.leaveConfirmButton, labels) {
            guard driver.press(confirm) else { return .failed(reason: "leave_control_not_actionable") }
        }
        guard let final = driver.snapshot(waitingUpTo: actionDeadline) else {
            return .failed(reason: "client_not_observable")
        }
        guard !final.hasPossibleMatch(labels.identifiers.meetingWindow, labels) else {
            return .failed(reason: "still_in_meeting")
        }
        guard final.hasCompleteDepartureLocators(labels.identifiers.meetingWindow, labels,
                matchedRoles: tree.possibleMatches(labels.identifiers.meetingWindow, labels).map(\.role)) else {
            return .failed(reason: "client_not_observable")
        }
        departureUnconfirmed = false
        return .left
    }

    /// Types the disclosure into the meeting chat, at most once for the life of
    /// this adapter. Returns nil when an attempt was already made — the caller
    /// gets a refusal, not a second message. Nothing here speaks: an unreachable
    /// chat control is reported as `unavailable` and the session carries on.
    public func postDisclosureOnce(text: String) -> DisclosureOutcome? {
        guard !disclosureAttempted else { return nil }
        disclosureAttempted = true

        guard var tree = driver.snapshot(waitingUpTo: 0) else { return .unavailable }

        // Only toggle a panel that is actually collapsed, and re-read the tree
        // afterwards. Pressing an open panel's toggle would hide the input, and
        // searching the pre-press tree for a control the press was meant to
        // reveal reports a false `unavailable` — which, since the one attempt is
        // already spent, silently skips the disclosure for the occurrence.
        if tree.locate(labels.identifiers.chatInput, labels) == nil,
            let toggle = tree.locate(labels.identifiers.chatToggle, labels), toggle.isEnabled
        {
            guard driver.press(toggle),
                let revealed = driver.snapshot(waitingUpTo: actionDeadline)
            else { return .unavailable }
            tree = revealed
        }

        guard let input = tree.locate(labels.identifiers.chatInput, labels), input.isEnabled,
            let send = tree.locate(labels.identifiers.chatSendButton, labels), send.isEnabled
        else {
            return .unavailable
        }
        guard driver.setValue(text, on: input) else { return .failed }
        guard driver.press(send) else { return .failed }
        return .sent
    }
}
