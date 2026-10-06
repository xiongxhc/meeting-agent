import Foundation
import FeishuBridgeSpike

public final class SyntheticAccessibility: AccessibilityDriver {
    private let labels: FeishuUiLabels
    private var inMeeting = false
    private var number = ""
    public init(labels: FeishuUiLabels) { self.labels = labels }
    public func snapshot(waitingUpTo seconds: TimeInterval) -> AccessibilityNode? {
        let ids = labels.identifiers
        if !inMeeting {
            return AccessibilityNode(role: "AXWindow", identifier: ids.appWindow, children: [
                AccessibilityNode(role: "AXTextField", identifier: ids.joinMeetingNumberField, value: number),
                AccessibilityNode(role: "AXButton", identifier: ids.joinButton),
            ])
        }
        return AccessibilityNode(role: "AXWindow", identifier: ids.meetingWindow, children: [
            AccessibilityNode(role: "AXStaticText", identifier: ids.meetingNumberLabel, value: number),
            AccessibilityNode(role: "AXButton", identifier: ids.leaveButton),
            AccessibilityNode(role: "AXTextArea", identifier: ids.chatInput),
            AccessibilityNode(role: "AXButton", identifier: ids.chatSendButton),
        ])
    }
    public func press(_ node: AccessibilityNode) -> Bool {
        switch node.identifier {
        case labels.identifiers.joinButton: inMeeting = true; return true
        case labels.identifiers.leaveButton: inMeeting = false; return true
        case labels.identifiers.chatSendButton: return inMeeting
        default: return false
        }
    }
    public func setValue(_ text: String, on node: AccessibilityNode) -> Bool {
        if node.identifier == labels.identifiers.joinMeetingNumberField { number = text; return true }
        return node.identifier == labels.identifiers.chatInput && inMeeting
    }
}
