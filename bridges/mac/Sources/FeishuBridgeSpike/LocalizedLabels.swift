import Foundation

/// **The only file in this package that contains user-interface strings.**
///
/// Everything else locates a control by an accessibility identifier or by asking
/// this table for the identifier's known titles. Nothing else compares a title,
/// a button caption, or a panel name, so re-pointing the bridge at a new client
/// build or a new display language is one file's worth of change.
///
/// Two kinds of string live here and they are not equally trustworthy:
///
/// - **Identifiers** (`AXIdentifier`) are the stable locator and the preferred
///   one: they do not move when the display language changes.
/// - **Titles** are the localized fallback for controls that expose no
///   identifier. They are display text and will drift between client releases.
///
/// **Both sets below are placeholders.** No value here was captured from a real
/// Feishu client — this package has never been run against one, and inventing a
/// measurement is worse than admitting there isn't one. Capturing the real
/// values is a human-gated step: see `docs/HUMAN-CHECKLIST.md`, Plan 1 Task 3.
/// The fake accessibility trees in the test target use these same placeholders,
/// so the tests prove the *locating strategy*, never the values.
public struct FeishuUiLabels: Sendable, Equatable {

    /// Stable accessibility identifiers, preferred over any localized title.
    public struct Identifiers: Sendable, Equatable {
        public let appWindow: String
        public let joinMeetingNumberField: String
        public let joinButton: String
        public let meetingWindow: String
        public let meetingNumberLabel: String
        public let leaveButton: String
        public let leaveConfirmButton: String
        public let chatToggle: String
        public let chatInput: String
        public let chatSendButton: String
        public let participantsPanel: String
        /// Each roster row's identifier is this prefix plus an opaque row id.
        public let participantRowPrefix: String
        public let speakerGrid: String
        /// Each speaker tile's identifier is this prefix plus an opaque tile id.
        public let speakerTilePrefix: String

        public init(
            appWindow: String,
            joinMeetingNumberField: String,
            joinButton: String,
            meetingWindow: String,
            meetingNumberLabel: String,
            leaveButton: String,
            leaveConfirmButton: String,
            chatToggle: String,
            chatInput: String,
            chatSendButton: String,
            participantsPanel: String,
            participantRowPrefix: String,
            speakerGrid: String,
            speakerTilePrefix: String
        ) {
            self.appWindow = appWindow
            self.joinMeetingNumberField = joinMeetingNumberField
            self.joinButton = joinButton
            self.meetingWindow = meetingWindow
            self.meetingNumberLabel = meetingNumberLabel
            self.leaveButton = leaveButton
            self.leaveConfirmButton = leaveConfirmButton
            self.chatToggle = chatToggle
            self.chatInput = chatInput
            self.chatSendButton = chatSendButton
            self.participantsPanel = participantsPanel
            self.participantRowPrefix = participantRowPrefix
            self.speakerGrid = speakerGrid
            self.speakerTilePrefix = speakerTilePrefix
        }
    }

    public let identifiers: Identifiers
    /// identifier -> the localized titles that same control is known to show.
    public let titlesByIdentifier: [String: [String]]

    public init(identifiers: Identifiers, titlesByIdentifier: [String: [String]]) {
        self.identifiers = identifiers
        self.titlesByIdentifier = titlesByIdentifier
    }

    /// Localized titles that may stand in for a control with no identifier.
    public func titles(for identifier: String) -> [String] {
        titlesByIdentifier[identifier] ?? []
    }

    public static let bundled = FeishuUiLabels(
        identifiers: Identifiers(
            appWindow: "feishu.app.window",
            joinMeetingNumberField: "feishu.join.meetingNumberField",
            joinButton: "feishu.join.confirmButton",
            meetingWindow: "feishu.meeting.window",
            meetingNumberLabel: "feishu.meeting.numberLabel",
            leaveButton: "feishu.meeting.leaveButton",
            leaveConfirmButton: "feishu.meeting.leaveConfirmButton",
            chatToggle: "feishu.meeting.chatToggle",
            chatInput: "feishu.meeting.chatInput",
            chatSendButton: "feishu.meeting.chatSendButton",
            participantsPanel: "feishu.meeting.participantsPanel",
            participantRowPrefix: "feishu.meeting.participantRow.",
            speakerGrid: "feishu.meeting.speakerGrid",
            speakerTilePrefix: "feishu.meeting.speakerTile."
        ),
        titlesByIdentifier: [
            "feishu.join.meetingNumberField": ["输入会议号", "Enter meeting number"],
            "feishu.join.confirmButton": ["加入会议", "Join"],
            "feishu.meeting.numberLabel": ["会议号", "Meeting number"],
            "feishu.meeting.leaveButton": ["离开会议", "Leave"],
            "feishu.meeting.leaveConfirmButton": ["确认离开", "Leave meeting"],
            "feishu.meeting.chatToggle": ["聊天", "Chat"],
            "feishu.meeting.chatInput": ["发送消息", "Send a message"],
            "feishu.meeting.chatSendButton": ["发送", "Send"],
            "feishu.meeting.participantsPanel": ["参会人", "Participants"],
        ]
    )
}
