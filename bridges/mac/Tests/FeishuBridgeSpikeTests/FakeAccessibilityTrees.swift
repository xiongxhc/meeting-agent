import Foundation

@testable import FeishuBridgeSpike

/// Synthetic accessibility trees. Nothing here was captured from a real Feishu
/// client, a real tenant, or a real person: tile and row ids are opaque
/// placeholders, display names are `Test Participant N`, and user ids follow the
/// `ou_0000...` pattern the frozen contract fixture already uses.
enum FakeTree {

    static let labels = FeishuUiLabels.bundled

    /// Localized titles come from the one mapping file, never from a literal
    /// pasted into a fixture — so a title the fakes match is by construction a
    /// title the adapter knows how to fall back to.
    static func localizedTitle(_ identifier: String) -> String? {
        labels.titles(for: identifier).first
    }

    static func participantRow(_ rowId: String, _ displayName: String) -> AccessibilityNode {
        AccessibilityNode(
            role: "AXRow",
            identifier: labels.identifiers.participantRowPrefix + rowId,
            title: displayName
        )
    }

    static func speakerTile(_ tileId: String, highlighted: Bool = false) -> AccessibilityNode {
        AccessibilityNode(
            role: "AXGroup",
            identifier: labels.identifiers.speakerTilePrefix + tileId,
            isHighlighted: highlighted
        )
    }

    /// A Feishu client sitting in a meeting.
    static func inMeeting(
        meetingNo: String = "900000001",
        roster: [(rowId: String, name: String)]? = [("row-1", "Test Participant One")],
        tiles: [(tileId: String, highlighted: Bool)] = [("tile-1", false)],
        chat: ChatAvailability = .reachable,
        confirmsLeave: Bool = false,
        localizedOnly: Bool = false
    ) -> AccessibilityNode {
        var children: [AccessibilityNode] = [
            AccessibilityNode(
                role: "AXStaticText",
                identifier: localizedOnly ? nil : labels.identifiers.meetingNumberLabel,
                title: localizedOnly ? localizedTitle(labels.identifiers.meetingNumberLabel) : nil,
                value: meetingNo
            ),
            AccessibilityNode(
                role: "AXButton",
                identifier: localizedOnly ? nil : labels.identifiers.leaveButton,
                title: localizedOnly ? localizedTitle(labels.identifiers.leaveButton) : nil
            ),
            AccessibilityNode(
                role: "AXGroup",
                identifier: labels.identifiers.speakerGrid,
                children: tiles.map { speakerTile($0.tileId, highlighted: $0.highlighted) }
            ),
        ]

        if let roster {
            children.append(
                AccessibilityNode(
                    role: "AXOutline",
                    identifier: localizedOnly ? nil : labels.identifiers.participantsPanel,
                    title: localizedOnly ? localizedTitle(labels.identifiers.participantsPanel) : nil,
                    children: roster.map { participantRow($0.rowId, $0.name) }
                )
            )
        }

        if confirmsLeave {
            children.append(
                AccessibilityNode(
                    role: "AXButton", identifier: labels.identifiers.leaveConfirmButton))
        }

        children.append(contentsOf: chat.nodes(labels: labels, localizedOnly: localizedOnly))

        return AccessibilityNode(
            role: "AXWindow",
            identifier: labels.identifiers.meetingWindow,
            children: children
        )
    }

    /// The client showing its positive "this meeting has ended" notice.
    static func meetingEndedNotice() -> AccessibilityNode {
        AccessibilityNode(
            role: "AXWindow",
            identifier: labels.identifiers.appWindow,
            children: [
                AccessibilityNode(
                    role: "AXStaticText", identifier: labels.identifiers.meetingEndedNotice)
            ])
    }

    /// The client running but backgrounded, or a tree read that came back
    /// partial: the app window is there, the meeting window is not readable.
    static func backgroundedClient() -> AccessibilityNode {
        AccessibilityNode(role: "AXWindow", identifier: labels.identifiers.appWindow)
    }

    /// The client running, but not in a meeting: only the join surface is present.
    static func idleWithJoinSurface(localizedOnly: Bool = false) -> AccessibilityNode {
        AccessibilityNode(
            role: "AXWindow",
            identifier: labels.identifiers.appWindow,
            children: [
                AccessibilityNode(
                    role: "AXTextField",
                    identifier: localizedOnly ? nil : labels.identifiers.joinMeetingNumberField,
                    title: localizedOnly ? localizedTitle(labels.identifiers.joinMeetingNumberField) : nil,
                    value: ""
                ),
                AccessibilityNode(
                    role: "AXButton",
                    identifier: localizedOnly ? nil : labels.identifiers.joinButton,
                    title: localizedOnly ? localizedTitle(labels.identifiers.joinButton) : nil
                ),
            ]
        )
    }

    enum ChatAvailability {
        /// Chat panel present, input and send button enabled.
        case reachable
        /// No chat control anywhere in the meeting window.
        case absent
        /// Chat panel present but the input is disabled (client still loading it).
        case disabledInput
        /// The chat panel is collapsed: the toggle is on screen, the input and
        /// send control only appear in a tree read *after* the toggle is pressed.
        case revealedByToggle

        func nodes(labels: FeishuUiLabels, localizedOnly: Bool) -> [AccessibilityNode] {
            switch self {
            case .absent:
                return []
            case .revealedByToggle:
                return [
                    AccessibilityNode(
                        role: "AXButton",
                        identifier: localizedOnly ? nil : labels.identifiers.chatToggle,
                        title: localizedOnly
                            ? labels.titles(for: labels.identifiers.chatToggle).first : nil)
                ]
            case .reachable, .disabledInput:
                let enabled = self == .reachable
                return [
                    AccessibilityNode(
                        role: "AXButton",
                        identifier: localizedOnly ? nil : labels.identifiers.chatToggle,
                        title: localizedOnly ? labels.titles(for: labels.identifiers.chatToggle).first : nil
                    ),
                    AccessibilityNode(
                        role: "AXTextArea",
                        identifier: labels.identifiers.chatInput,
                        value: "",
                        isEnabled: enabled
                    ),
                    AccessibilityNode(
                        role: "AXButton",
                        identifier: labels.identifiers.chatSendButton,
                        isEnabled: enabled
                    ),
                ]
            }
        }
    }
}

/// Resolves opaque UI element ids to synthetic Feishu user ids. Anything not in
/// the table is unresolvable — a legal answer, never a cue to guess.
struct FakeIdentityResolver: UiIdentityResolver {
    let table: [String: String]
    func identify(uiElementId: String) -> String? { table[uiElementId] }
}

/// Records what the reducer asked of the chat control and answers with a fixed
/// outcome. There is no "speak" method here because there is no speech path
/// anywhere in this package.
final class FakeChatControl: ChatControlPort {
    let outcome: DisclosureOutcome
    private(set) var attempts: [String] = []

    init(outcome: DisclosureOutcome) { self.outcome = outcome }

    func postDisclosure(text: String) -> DisclosureOutcome {
        attempts.append(text)
        return outcome
    }
}

/// Serves a scripted sequence of snapshots and records every UI action.
final class FakeAccessibilityDriver: AccessibilityDriver {
    private var snapshots: [AccessibilityNode?]
    private(set) var pressed: [String] = []
    /// Every deadline the adapter asked to wait for, in call order.
    private(set) var waits: [TimeInterval] = []
    private(set) var typed: [(identifier: String, text: String)] = []
    var refusePress: Set<String> = []
    var refuseSetValue: Set<String> = []

    init(snapshots: [AccessibilityNode?]) { self.snapshots = snapshots }

    func snapshot(waitingUpTo seconds: TimeInterval) -> AccessibilityNode? {
        waits.append(seconds)
        guard !snapshots.isEmpty else { return snapshots.last ?? nil }
        return snapshots.count == 1 ? snapshots[0] : snapshots.removeFirst()
    }

    func press(_ node: AccessibilityNode) -> Bool {
        let id = node.identifier ?? node.title ?? node.role
        if refusePress.contains(id) { return false }
        pressed.append(id)
        return true
    }

    func setValue(_ text: String, on node: AccessibilityNode) -> Bool {
        let id = node.identifier ?? node.title ?? node.role
        if refuseSetValue.contains(id) { return false }
        typed.append((identifier: id, text: text))
        return true
    }
}
