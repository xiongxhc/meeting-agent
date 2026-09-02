import Foundation

/// Drives the Feishu client's UI. A real implementation wraps `AXUIElement`
/// actions (`AXUIElementPerformAction`, `kAXValueAttribute` writes) and needs the
/// macOS Accessibility grant; the tests substitute a fake that serves scripted
/// trees and records what was pressed and typed.
public protocol AccessibilityDriver {
    /// The client's current accessibility tree, or nil when the client is not
    /// running or cannot be read.
    func snapshot() -> AccessibilityNode?
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
    private var disclosureAttempted = false

    public init(driver: any AccessibilityDriver, labels: FeishuUiLabels = .bundled) {
        self.driver = driver
        self.labels = labels
    }

    public func join(meetingOccurrenceId: String, meetingNo: String) -> JoinOutcome {
        guard let tree = driver.snapshot() else { return .failed(reason: "client_not_observable") }
        guard let field = tree.locate(labels.identifiers.joinMeetingNumberField, labels),
            let button = tree.locate(labels.identifiers.joinButton, labels)
        else {
            return .failed(reason: "join_controls_not_reachable")
        }
        guard driver.setValue(meetingNo, on: field) else {
            return .failed(reason: "meeting_number_not_accepted")
        }
        guard button.isEnabled, driver.press(button) else {
            return .failed(reason: "join_control_not_actionable")
        }

        guard let joined = driver.snapshot()?.locate(labels.identifiers.meetingWindow, labels) else {
            return .failed(reason: "meeting_window_not_observed")
        }
        guard let shown = joined.locate(labels.identifiers.meetingNumberLabel, labels)?.value else {
            return .failed(reason: "joined_meeting_number_not_observable")
        }
        guard shown == meetingNo else { return .rejected(reason: "joined_meeting_number_mismatch") }

        return .joined(meetingOccurrenceId: meetingOccurrenceId)
    }

    public func leave() -> LeaveOutcome {
        guard let tree = driver.snapshot() else { return .failed(reason: "client_not_observable") }
        guard let leaveButton = tree.locate(labels.identifiers.leaveButton, labels) else {
            return .failed(reason: "leave_control_not_reachable")
        }
        guard driver.press(leaveButton) else { return .failed(reason: "leave_control_not_actionable") }

        let after = driver.snapshot()
        if let confirm = after?.locate(labels.identifiers.leaveConfirmButton, labels) {
            guard driver.press(confirm) else { return .failed(reason: "leave_control_not_actionable") }
        }
        guard driver.snapshot()?.locate(labels.identifiers.meetingWindow, labels) == nil else {
            return .failed(reason: "still_in_meeting")
        }
        return .left
    }

    /// Types the disclosure into the meeting chat, at most once for the life of
    /// this adapter. Returns nil when an attempt was already made — the caller
    /// gets a refusal, not a second message. Nothing here speaks: an unreachable
    /// chat control is reported as `unavailable` and the session carries on.
    public func postDisclosureOnce(text: String) -> DisclosureOutcome? {
        guard !disclosureAttempted else { return nil }
        disclosureAttempted = true

        guard let tree = driver.snapshot() else { return .unavailable }
        if let toggle = tree.locate(labels.identifiers.chatToggle, labels), toggle.isEnabled {
            _ = driver.press(toggle)
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
