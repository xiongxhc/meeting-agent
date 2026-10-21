import Foundation
import AppKit
import ApplicationServices

public struct NativeAXAttributes: Equatable {
    public let role: String
    public var identifier: String? { identifierRead.text }
    public var title: String? { titleRead.text }
    public let identifierRead: AXStringRead, titleRead: AXStringRead
    public let value: String?
    public let enabled: Bool
    public let canPress: Bool
    public let canSetValue: Bool
    public init(role: String, identifier: String? = nil, title: String? = nil, value: String? = nil,
                enabled: Bool = false, canPress: Bool = false, canSetValue: Bool = false,
                identifierRead: AXStringRead? = nil, titleRead: AXStringRead? = nil) {
        self.role = role; self.value = value
        self.identifierRead = identifierRead ?? AXStringRead(rawValue: identifier)
        self.titleRead = titleRead ?? AXStringRead(rawValue: title)
        self.enabled = enabled; self.canPress = canPress; self.canSetValue = canSetValue
    }
}

/// Native-only operations. Tests replace this boundary, not the AX driver or control owner.
public protocol AXNativeBackend {
    func isApplicationValid() -> Bool
    func beginSnapshot() -> String?
    func attributes(_ handle: String) -> NativeAXAttributes?
    func children(_ handle: String, limit: Int) -> [String]?
    func press(_ handle: String) -> Bool
    func setValue(_ value: String, handle: String) -> Bool
    /// One named attribute, read only for configured measured selectors.
    /// A failed read is `.malformed` (unknown), never a guessed value.
    func attribute(_ name: String, handle: String) -> AXStringRead
}
extension AXNativeBackend {
    public func attribute(_ name: String, handle: String) -> AXStringRead { .absent }
}

public final class AXAccessibilityDriver: AccessibilityDriver {
    private let backend: any AXNativeBackend
    private let clock: any BridgeDeadlineClock
    private let cancellation: BridgeCancellation
    private let maxNodes: Int, maxDepth: Int, maxStringBytes: Int
    private let readDeadline: TimeInterval
    private let measured: MeasuredSpeakerSelectors
    private let rowPrefix: String, tilePrefix: String
    private var handles: [String: (String, NativeAXAttributes)] = [:]
    private var previous: AccessibilityNode?

    public init(backend: any AXNativeBackend, clock: any BridgeDeadlineClock,
                cancellation: BridgeCancellation, maxNodes: Int = 512, maxDepth: Int = 16,
                maxStringBytes: Int = 4096, readDeadline: TimeInterval = 2,
                measured: MeasuredSpeakerSelectors = .unmeasured, labels: FeishuUiLabels = .bundled) {
        self.backend = backend; self.clock = clock; self.cancellation = cancellation
        self.maxNodes = maxNodes; self.maxDepth = maxDepth; self.maxStringBytes = maxStringBytes
        self.readDeadline = readDeadline
        self.measured = measured
        rowPrefix = labels.identifiers.participantRowPrefix; tilePrefix = labels.identifiers.speakerTilePrefix
    }

    public func snapshot(waitingUpTo seconds: TimeInterval) -> AccessibilityNode? {
        let deadline = clock.monotonicSeconds() + max(0, seconds)
        let baseline = previous
        repeat {
            handles.removeAll(keepingCapacity: true)
            guard !cancellation.isCancelled, backend.isApplicationValid(), let root = backend.beginSnapshot() else { previous = nil; return nil }
            var visited = Set<String>()
            let readEnd = min(deadline, clock.monotonicSeconds() + readDeadline)
            // A non-waiting observation still gets one bounded native read.
            let end = seconds == 0 ? clock.monotonicSeconds() + readDeadline : readEnd
            let tree = project(root, depth: 0, visited: &visited, deadline: end)
            previous = tree
            if tree == nil || tree != baseline || clock.monotonicSeconds() >= deadline { return tree }
            clock.pause(seconds: min(0.05, max(0, deadline - clock.monotonicSeconds())))
        } while !cancellation.isCancelled
        handles.removeAll(); return nil
    }

    private func project(_ handle: String, depth: Int, visited: inout Set<String>, deadline: TimeInterval) -> AccessibilityNode? {
        guard !cancellation.isCancelled, clock.monotonicSeconds() <= deadline,
              depth <= maxDepth, visited.count < maxNodes, visited.insert(handle).inserted,
              let fields = backend.attributes(handle), !fields.role.isEmpty,
              [fields.role, fields.identifier ?? "", fields.title ?? "", fields.value ?? ""].allSatisfy({ $0.utf8.count <= maxStringBytes }),
              let children = backend.children(handle, limit: maxNodes - visited.count),
              children.count <= maxNodes - visited.count else { return nil }
        var nodes: [AccessibilityNode] = []
        for child in children {
            guard let node = project(child, depth: depth + 1, visited: &visited, deadline: deadline) else { return nil }
            nodes.append(node)
        }
        let (identity, highlight) = measuredReads(handle, identifier: fields.identifier)
        guard !cancellation.isCancelled, clock.monotonicSeconds() <= deadline else { return nil }
        let key = UUID().uuidString
        handles[key] = (handle, fields)
        return AccessibilityNode(role: fields.role, identifier: fields.identifier, title: fields.title,
                                 value: fields.value, isEnabled: fields.enabled, isHighlighted: highlight == true,
                                 children: nodes, nativeKey: key,
                                 identifierRead: fields.identifierRead, titleRead: fields.titleRead,
                                 highlightRead: highlight, measuredIdentity: identity)
    }

    /// Extra reads happen only for configured selectors on roster rows and
    /// speaker tiles. An absent, malformed or failed highlight stays nil.
    private func measuredReads(_ handle: String, identifier: String?) -> (AXStringRead, Bool?) {
        guard let identifier, measured != .unmeasured else { return (.absent, nil) }
        func scoped(_ prefix: String) -> Bool { !prefix.isEmpty && identifier.hasPrefix(prefix) && identifier != prefix }
        func read(_ name: String) -> AXStringRead {
            let value = backend.attribute(name, handle: handle)
            return (value.text?.utf8.count ?? 0) > maxStringBytes ? .malformed : value
        }
        let tile = scoped(tilePrefix)
        var identity = AXStringRead.absent
        if tile || scoped(rowPrefix), let attribute = measured.identity?.attribute, attribute != "AXIdentifier" {
            identity = read(attribute)
        }
        var highlight: Bool?
        if tile, let selector = measured.highlight, let value = read(selector.attribute).text {
            highlight = value == selector.speakingValue
        }
        return (identity, highlight)
    }

    private func actionable(_ node: AccessibilityNode) -> (String, NativeAXAttributes)? {
        guard !cancellation.isCancelled, backend.isApplicationValid(), let key = node.nativeKey,
              let (handle, old) = handles[key], let fresh = backend.attributes(handle),
              !cancellation.isCancelled,
              fresh.role == old.role, fresh.identifier == old.identifier, fresh.title == old.title,
              node.role == old.role, node.identifier == old.identifier, fresh.enabled else { return nil }
        return (handle, fresh)
    }
    public func press(_ node: AccessibilityNode) -> Bool {
        guard let (handle, fields) = actionable(node), fields.canPress, fields.role == "AXButton" else { return false }
        return backend.press(handle)
    }
    public func setValue(_ text: String, on node: AccessibilityNode) -> Bool {
        guard text.utf8.count <= maxStringBytes, let (handle, fields) = actionable(node), fields.canSetValue,
              ["AXTextField", "AXTextArea"].contains(fields.role) else { return false }
        return backend.setValue(text, handle: handle)
    }
}

/// Public AX APIs only. Explicit PID + bundle path/ID/build + launch time prevent
/// similarly named applications or recycled PIDs from inheriting native handles.
public final class SystemAXBackend: AXNativeBackend {
    private let pid: pid_t
    private let bundlePath: String, bundleId: String, build: String
    private let launchDate: Date?
    private let callTimeout: Float
    private var elements: [String: AXUIElement] = [:]
    private var attributeReadFailed = false
    public init(pid: pid_t, bundlePath: String, bundleId: String, build: String, callTimeout: Float) {
        self.pid = pid; self.bundlePath = bundlePath; self.bundleId = bundleId; self.build = build
        self.callTimeout = callTimeout
        self.launchDate = NSRunningApplication(processIdentifier: pid)?.launchDate
    }
    public func isApplicationValid() -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              let launchDate, app.launchDate == launchDate, app.bundleIdentifier == bundleId,
              app.bundleURL?.path == bundlePath,
              Bundle(url: URL(fileURLWithPath: bundlePath))?.object(forInfoDictionaryKey: "CFBundleVersion") as? String == build else { return false }
        return AXIsProcessTrusted()
    }
    public func beginSnapshot() -> String? {
        elements.removeAll()
        guard isApplicationValid() else { return nil }
        let app = AXUIElementCreateApplication(pid)
        guard AXUIElementSetMessagingTimeout(app, callTimeout) == .success else { return nil }
        elements["root"] = app
        return "root"
    }
    private func read(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        guard status == .success else {
            if status != .attributeUnsupported && status != .noValue { attributeReadFailed = true }
            return nil
        }
        return value
    }
    public func attributes(_ handle: String) -> NativeAXAttributes? {
        attributeReadFailed = false
        guard let element = elements[handle], let role = read(element, kAXRoleAttribute) as? String else { return nil }
        var actions: CFArray?
        let canPress = AXUIElementCopyActionNames(element, &actions) == .success && (actions as? [String])?.contains(kAXPressAction) == true
        var settable = DarwinBoolean(false)
        let canSet = AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
        let identifier = AXStringRead(rawValue: read(element, kAXIdentifierAttribute))
        let title = AXStringRead(rawValue: read(element, kAXTitleAttribute))
        let result = NativeAXAttributes(role: role, value: read(element, kAXValueAttribute) as? String,
                                  enabled: (read(element, kAXEnabledAttribute) as? Bool) == true, canPress: canPress, canSetValue: canSet,
                                  identifierRead: identifier, titleRead: title)
        return attributeReadFailed ? nil : result
    }
    public func children(_ handle: String, limit: Int) -> [String]? {
        guard let element = elements[handle] else { return nil }
        var count: CFIndex = 0
        let status = AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count)
        if status == .attributeUnsupported || status == .noValue {
            guard let role = read(element, kAXRoleAttribute) as? String,
                  ["AXButton", "AXStaticText", "AXTextField", "AXTextArea", "AXImage", "AXCheckBox", "AXRadioButton"].contains(role) else { return nil }
            return []
        }
        guard status == .success, count <= limit, count >= 0 else { return nil }
        if count == 0 { return [] }
        var values: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, count, &values) == .success,
              let children = values as? [AXUIElement], children.count == count else { return nil }
        var keys: [String] = []
        for child in children {
            let key = UUID().uuidString
            guard AXUIElementSetMessagingTimeout(child, callTimeout) == .success else { return nil }
            elements[key] = child
            keys.append(key)
        }
        return keys
    }
    public func press(_ handle: String) -> Bool {
        guard isApplicationValid(), let element = elements[handle] else { return false }
        return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }
    public func setValue(_ value: String, handle: String) -> Bool {
        guard isApplicationValid(), let element = elements[handle] else { return false }
        return AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success
    }
    public func attribute(_ name: String, handle: String) -> AXStringRead {
        guard let element = elements[handle] else { return .malformed }
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if status == .attributeUnsupported || status == .noValue { return .absent }
        guard status == .success, let value else { return .malformed }
        if CFGetTypeID(value) == CFBooleanGetTypeID() { return .value(CFBooleanGetValue((value as! CFBoolean)) ? "true" : "false") }
        if let text = value as? String { return .value(text) }
        if let number = value as? NSNumber { return .value(number.stringValue) }
        return .malformed
    }
}
