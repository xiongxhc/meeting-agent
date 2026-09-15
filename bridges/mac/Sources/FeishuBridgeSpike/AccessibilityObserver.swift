import Foundation

/// A missing or malformed identifying attribute cannot exclude a locator match.
public enum AXStringRead: Equatable, Sendable {
    case value(String), absent, malformed
    public init(rawValue: Any?) {
        guard let rawValue else { self = .absent; return }
        if let text = rawValue as? String { self = .value(text) } else { self = .malformed }
    }
    public var text: String? { if case .value(let text) = self { text } else { nil } }
    var identifies: Bool { text?.isEmpty == false }
}

/// One accessibility element as read off the Feishu client, flattened to the few
/// attributes the bridge actually needs. A real implementation fills this from
/// `AXUIElement` copy-attribute calls; the tests fill it from synthetic trees.
/// Keeping the tree a plain value is what lets every observation rule be tested
/// without a running client, a tenant, or an Accessibility grant.
public struct AccessibilityNode: Equatable, Sendable {
    /// Internal native snapshot capability; never serialized onto control wire.
    public let nativeKey: String?
    /// `AXRole`, e.g. `AXWindow`, `AXButton`, `AXRow`.
    public let role: String
    /// `AXIdentifier` — the stable locator, unaffected by display language.
    public var identifier: String? { identifierRead.text }
    public let identifierRead: AXStringRead
    /// `AXTitle` — display text, localized, used only as a fallback locator.
    public var title: String? { titleRead.text }
    public let titleRead: AXStringRead
    public let value: String?
    public let isEnabled: Bool
    /// Whether the element carries the client's active-speaking highlight.
    public let isHighlighted: Bool
    /// V2 evidence requires a measured readable highlight channel. Native AX
    /// projection currently has none: nil is unsupported/unknown, never false.
    public let highlightRead: Bool?
    public let children: [AccessibilityNode]

    public init(
        role: String,
        identifier: String? = nil,
        title: String? = nil,
        value: String? = nil,
        isEnabled: Bool = true,
        isHighlighted: Bool = false,
        children: [AccessibilityNode] = [], nativeKey: String? = nil,
        identifierRead: AXStringRead? = nil, titleRead: AXStringRead? = nil, highlightRead: Bool? = nil
    ) {
        self.role = role
        self.identifierRead = identifierRead ?? AXStringRead(rawValue: identifier)
        self.titleRead = titleRead ?? AXStringRead(rawValue: title)
        self.value = value
        self.isEnabled = isEnabled
        self.isHighlighted = isHighlighted
        self.highlightRead = highlightRead
        self.children = children
        self.nativeKey = nativeKey
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        // Polling compares UI content, not freshly minted snapshot capabilities.
        lhs.role == rhs.role && lhs.identifierRead == rhs.identifierRead && lhs.titleRead == rhs.titleRead
            && lhs.value == rhs.value && lhs.isEnabled == rhs.isEnabled
            && lhs.isHighlighted == rhs.isHighlighted && lhs.children == rhs.children
            && lhs.highlightRead == rhs.highlightRead
    }

    /// Depth-first, tree order — the order the client lays the UI out in.
    public func descendants(where matches: (AccessibilityNode) -> Bool) -> [AccessibilityNode] {
        var found: [AccessibilityNode] = []
        if matches(self) { found.append(self) }
        for child in children { found.append(contentsOf: child.descendants(where: matches)) }
        return found
    }

    public func firstDescendant(where matches: (AccessibilityNode) -> Bool) -> AccessibilityNode? {
        descendants(where: matches).first
    }
}

/// One participant as the roster panel showed them at an instant.
public struct RosterEntry: Equatable, Sendable {
    public let feishuUserId: String
    public let displayName: String

    public init(feishuUserId: String, displayName: String) {
        self.feishuUserId = feishuUserId
        self.displayName = displayName
    }
}

/// A single instant of what the client UI showed. This mirrors `UiObservation`
/// in `spikes/feishu/src/reducer.ts`, with three cases the TypeScript reference
/// does not have, all of them things only a bridge watching a real client can
/// see: `joined`, the counterpart of `meetingEnded`; `unobservable`, one frame
/// the bridge could not read; and `clientUnreadable`, enough consecutive such
/// frames that the bridge gives up. The TypeScript reducer is fed observations
/// by whatever is watching the UI and never watches one itself, so it has no
/// occasion to report any of the three.
public enum UiObservation: Equatable, Sendable {
    case joined(observedAt: String, meetingOccurrenceId: String)
    /// The tree could not be read as a meeting: the client is backgrounded, the
    /// read came back partial, or the meeting window exposes nothing the label
    /// table knows. This says nothing about whether the meeting is still on, and
    /// the reducer emits nothing for it.
    case unobservable(observedAt: String)
    /// The meeting window could not be located for `absentFramesBeforeEnded`
    /// consecutive frames, so the bridge stops watching. What was observed is
    /// that the bridge could not read the client — never that the meeting
    /// ended, which is a claim only the client's own ended notice supports.
    case clientUnreadable(observedAt: String)
    case rosterSnapshot(observedAt: String, participants: [RosterEntry])
    case speakerHighlight(observedAt: String, highlightedTileIds: [String])
    case meetingEnded(observedAt: String)
    case disclosureAttempt(observedAt: String, text: String)
}

/// Resolves an opaque UI element id (a roster row, a speaker tile) to a Feishu
/// user id. Returning nil means "could not resolve" — a legal, expected answer,
/// never a cue to guess.
public protocol UiIdentityResolver {
    func identify(uiElementId: String) -> String?
}

/// Attempts to type the disclosure into the meeting chat. A missing or
/// unreachable control is a normal outcome (`unavailable`), never an exception,
/// and never a reason to speak instead — there is no speech path in this package.
public protocol ChatControlPort {
    func postDisclosure(text: String) -> DisclosureOutcome
}

/// Reads raw observations off an accessibility tree. It reports what the UI
/// showed and nothing more: no speaker is chosen here, an unresolvable identity
/// is left out rather than filled in, and a tree it cannot read is reported as
/// unreadable rather than as an ended meeting.
///
/// The end of a meeting is claimed on positive evidence only — the client's
/// meeting-ended notice. One unreadable frame is `unobservable`;
/// `absentFramesBeforeEnded` consecutive unreadable frames is `clientUnreadable`,
/// which the reducer reports as `left(reason: "bridge_failure")`, because a
/// bridge that cannot read the client has observed its own blindness and not the
/// end of a meeting. This is the same asymmetry the roster rule uses: a panel
/// that is not on screen is unknown membership, not an empty meeting.
///
/// Stateful, hence a class: the consecutive-absence count is what separates a
/// backgrounded client from a meeting that is over.
public final class AccessibilityObserver {
    private let labels: FeishuUiLabels
    private let identity: any UiIdentityResolver
    private let absentFramesBeforeEnded: Int
    private var consecutiveAbsentFrames = 0

    public init(
        labels: FeishuUiLabels = .bundled,
        identity: any UiIdentityResolver,
        absentFramesBeforeEnded: Int = 3
    ) {
        precondition(absentFramesBeforeEnded >= 1, "at least one absent frame is needed")
        self.labels = labels
        self.identity = identity
        self.absentFramesBeforeEnded = absentFramesBeforeEnded
    }

    public func observations(from tree: AccessibilityNode, at observedAt: String) -> [UiObservation] {
        if tree.locate(labels.identifiers.meetingEndedNotice, labels) != nil {
            consecutiveAbsentFrames = 0
            return [.meetingEnded(observedAt: observedAt)]
        }

        guard let window = tree.locate(labels.identifiers.meetingWindow, labels) else {
            consecutiveAbsentFrames += 1
            return consecutiveAbsentFrames >= absentFramesBeforeEnded
                ? [.clientUnreadable(observedAt: observedAt)]
                : [.unobservable(observedAt: observedAt)]
        }
        consecutiveAbsentFrames = 0

        var observations: [UiObservation] = []

        // A roster panel that is not on screen is unknown membership. Reporting
        // an empty roster would say everybody left, which is a different claim.
        if let panel = window.locate(labels.identifiers.participantsPanel, labels) {
            let prefix = labels.identifiers.participantRowPrefix
            let participants = panel.descendants { $0.identifier?.hasPrefix(prefix) == true }
                .compactMap { row -> RosterEntry? in
                    guard let rowId = row.identifier?.dropFirst(prefix.count),
                        let userId = identity.identify(uiElementId: String(rowId)),
                        let displayName = row.title, !displayName.isEmpty
                    else { return nil }
                    return RosterEntry(feishuUserId: userId, displayName: displayName)
                }
            observations.append(.rosterSnapshot(observedAt: observedAt, participants: participants))
        }

        if let grid = window.locate(labels.identifiers.speakerGrid, labels) {
            let prefix = labels.identifiers.speakerTilePrefix
            let highlighted = grid.descendants {
                $0.identifier?.hasPrefix(prefix) == true && $0.isHighlighted
            }.compactMap { $0.identifier.map { String($0.dropFirst(prefix.count)) } }
            observations.append(
                .speakerHighlight(observedAt: observedAt, highlightedTileIds: highlighted))
        }

        return observations
    }

    public func snapshotState(from tree: AccessibilityNode?) -> UiSnapshotState {
        guard let tree, let window = tree.locate(labels.identifiers.meetingWindow, labels) else {
            return UiSnapshotState(state: "unreadable", feishuUserId: nil, reason: "snapshot_unreadable")
        }
        guard let grid = window.locate(labels.identifiers.speakerGrid, labels), !labels.identifiers.speakerTilePrefix.isEmpty else {
            return UiSnapshotState(state: "unreadable", feishuUserId: nil, reason: "grid_unavailable")
        }
        let prefix = labels.identifiers.speakerTilePrefix
        let possible = grid.children.flatMap { $0.descendants { node in
            node.identifier?.hasPrefix(prefix) == true || ["AXGroup", "AXCell", "AXImage", "AXUnknown"].contains(node.role)
        } }
        guard !possible.isEmpty, possible.allSatisfy({ $0.identifier?.hasPrefix(prefix) == true && $0.identifier != prefix }) else {
            return UiSnapshotState(state: "unreadable", feishuUserId: nil, reason: "snapshot_unreadable")
        }
        guard possible.allSatisfy({ $0.highlightRead != nil }) else {
            return UiSnapshotState(state: "unknown", feishuUserId: nil, reason: "identity_unavailable")
        }
        let highlighted = possible.filter { $0.highlightRead == true }
        if highlighted.isEmpty { return UiSnapshotState(state: "unknown", feishuUserId: nil, reason: "no_highlight") }
        guard highlighted.count == 1 else { return UiSnapshotState(state: "ambiguous", feishuUserId: nil, reason: nil) }
        let element = String(highlighted[0].identifier!.dropFirst(prefix.count))
        guard let id = identity.identify(uiElementId: element), !id.isEmpty else {
            return UiSnapshotState(state: "ambiguous", feishuUserId: nil, reason: "identity_unavailable")
        }
        guard id.utf8.count <= 1024 else { return UiSnapshotState(state: "unknown", feishuUserId: nil, reason: "identity_unavailable") }
        return UiSnapshotState(state: "ui_exact", feishuUserId: id, reason: nil)
    }
}

public struct UiSnapshotState: Sendable {
    public let state: String, feishuUserId: String?, reason: String?
}
public struct UiSnapshotEvidence: Sendable {
    public let sequence: Int
    public let timing: ObservationTiming?
    public let state: String, feishuUserId: String?, reason: String?, barrierBefore: String?
    public let observedSpeakerChange: ActiveSpeaker?
    var object: [String: Any] {
        ["type": "ui_snapshot", "snapshotSequence": sequence, "observationTiming": timing?.object ?? NSNull(),
         "state": state, "feishuUserId": feishuUserId ?? NSNull(), "reason": reason ?? NSNull(), "barrierBefore": barrierBefore ?? NSNull()]
    }
}
public final class UiSnapshotProducer {
    private let clock: CaptureClockPairSampler
    private let observer: AccessibilityObserver
    private var sequence = 0
    private var previous: ObservationTiming?
    private var missing = false
    private var previousState: UiSnapshotState?
    public init(clock: CaptureClockPairSampler, labels: FeishuUiLabels, identity: any UiIdentityResolver) {
        self.clock = clock; observer = AccessibilityObserver(labels: labels, identity: identity)
    }
    public func observe(_ snapshot: () -> AccessibilityNode?) throws -> (tree: AccessibilityNode?, snapshot: UiSnapshotEvidence) {
        guard sequence < 9_007_199_254_740_991 else { throw BridgeProcessError.stateLimit }
        sequence += 1
        let before = try? clock.hostNanoseconds()
        let tree = snapshot() // Exactly one actual read, even when host timing failed.
        let after = try? clock.hostNanoseconds()
        var timing: ObservationTiming?
        if let before, let after { timing = try? ObservationTiming(clockDomainId: clock.clockDomainId, hostBeforeNs: before, hostAfterNs: after) }
        var barrier: String? = sequence == 1 ? "stream_start" : (missing ? "observation_drop" : nil)
        if let prior = previous, let current = timing {
            if current.hostBeforeNs < prior.hostAfterNs { barrier = "clock_reset"; timing = nil }
            else if current.hostBeforeNs - prior.hostBeforeNs > 2_000_000_000 { barrier = "poll_gap" }
        }
        let state = timing == nil ? UiSnapshotState(state: "unreadable", feishuUserId: nil, reason: "timing_unavailable") : observer.snapshotState(from: tree)
        var change: ActiveSpeaker?
        if barrier == nil, let prior = previousState,
           ["ui_exact", "ambiguous"].contains(prior.state) || prior.reason == "no_highlight",
           state.state != prior.state || state.feishuUserId != prior.feishuUserId {
            if state.state == "ui_exact", let id = state.feishuUserId { change = .uiExact(feishuUserId: id) }
            else if state.state == "ambiguous" { change = .ambiguous }
        }
        missing = timing == nil
        if let timing { previous = timing }
        previousState = timing == nil ? nil : state
        return (tree, UiSnapshotEvidence(sequence: sequence, timing: timing, state: state.state,
            feishuUserId: state.feishuUserId, reason: state.reason, barrierBefore: barrier, observedSpeakerChange: change))
    }
}

extension AccessibilityNode {
    func hasCompleteDepartureLocators(_ identifier: String, _ labels: FeishuUiLabels, matchedRoles: [String]) -> Bool {
        let roles = Set(["AXWindow", "AXSheet", "AXDialog"] + matchedRoles)
        let usesTitle = !labels.titles(for: identifier).isEmpty
        return descendants { roles.contains($0.role) }.allSatisfy {
            $0.identifierRead.identifies && (!usesTitle || $0.titleRead.identifies)
        }
    }
    func hasPossibleMatch(_ identifier: String, _ labels: FeishuUiLabels) -> Bool {
        !possibleMatches(identifier, labels).isEmpty
    }
    func possibleMatches(_ identifier: String, _ labels: FeishuUiLabels) -> [AccessibilityNode] {
        guard !identifier.isEmpty else { return [] }
        let titles = labels.titles(for: identifier)
        return descendants { $0.identifier == identifier || ($0.title.map { titles.contains($0) } ?? false) }
    }
    /// Locates a control by its stable accessibility identifier, falling back to
    /// the localized titles that identifier is known by. Every string used here
    /// comes from `LocalizedLabels.swift`; no other file compares UI text.
    func locate(_ identifier: String, _ labels: FeishuUiLabels) -> AccessibilityNode? {
        guard !identifier.isEmpty else { return nil }
        let identified = descendants(where: { $0.identifier == identifier })
        if !identified.isEmpty { return identified.count == 1 ? identified[0] : nil }
        let titles = labels.titles(for: identifier)
        guard !titles.isEmpty else { return nil }
        let matched = descendants { node in
            guard let title = node.title else { return false }
            return titles.contains(title)
        }
        return matched.count == 1 ? matched[0] : nil
    }
}

/// Folds observations into the frozen event stream for one session.
///
/// The ambiguity policy is the one in `spikes/feishu/src/reducer.ts`, restated
/// here because this is the second implementation of it, not a second definition:
///   - exactly one highlighted tile, identity resolved   -> `ui_exact`
///   - exactly one highlighted tile, identity unresolved -> `ambiguous`
///   - two or more highlighted tiles                     -> `ambiguous`, even
///     when every tile's identity is individually resolvable: overlap means the
///     UI cannot say who is speaking, not merely who is on screen
///   - no highlighted tile                               -> no change at all;
///     the speaker is never inferred from the attendee list or from how long a
///     tile has been lit
///   - a resolved state is re-emitted only when it changes, mirroring a UI whose
///     highlight persists across frames until a different tile lights up.
///
/// **A session is terminal after any `left`.** Once this reducer has reported a
/// departure it emits nothing further — not a roster change, not a speaker, not
/// a second `left`. The observer deliberately recovers: a meeting window that
/// comes back resets its absence count, so the same session can go on producing
/// readable frames after the bridge already gave up on it. Emitting from those
/// frames would report activity inside a meeting this bridge said it had left,
/// and the contract has no way to say "still here after all".
public final class SessionObservationReducer {
    public let sessionId: String
    private let identity: any UiIdentityResolver
    private let chatControl: any ChatControlPort
    private var sequence = 0
    private var activeSpeaker: ActiveSpeaker?
    /// Set by the first `left` this reducer emits, for either reason. It gates
    /// every emission, not just a second `left`.
    private var hasLeft = false
    private var roster: [String: String] = [:]

    /// Every event this reducer refused to build because it would have failed
    /// the contract it claims to speak — see `emit`. Readable rather than
    /// silent: a refusal means an upstream port handed the reducer something
    /// unusable, and that is a defect to find, not to swallow.
    public private(set) var refusedEvents: [BridgeContractError] = []

    public init(
        sessionId: String, identity: any UiIdentityResolver, chatControl: any ChatControlPort
    ) {
        self.sessionId = sessionId
        self.identity = identity
        self.chatControl = chatControl
    }

    public func reduce(_ observation: UiObservation) -> [BridgeEventMessage] {
        // Terminal after a departure: a session that has reported `left` says
        // nothing more, whatever the client goes on showing.
        guard !hasLeft else { return [] }

        switch observation {
        case .joined(let observedAt, let meetingOccurrenceId):
            return emit(observedAt, .joined(meetingOccurrenceId: meetingOccurrenceId))

        case .unobservable:
            return []

        case .meetingEnded(let observedAt):
            // `ended` is reserved for a positively observed end: the client's
            // own meeting-ended notice, which is what produced this case.
            let events = emit(observedAt, .left(reason: .ended))
            hasLeft = !events.isEmpty
            return events

        case .clientUnreadable(let observedAt):
            // What was observed is that the bridge could not read the client for
            // long enough to give up. Calling that `ended` would claim knowledge
            // of the meeting the bridge does not have.
            let events = emit(observedAt, .left(reason: .bridgeFailure))
            hasLeft = !events.isEmpty
            return events

        case .disclosureAttempt(let observedAt, let text):
            return emit(observedAt, .chatDisclosure(outcome: chatControl.postDisclosure(text: text)))

        case .rosterSnapshot(let observedAt, let participants):
            return reduceRoster(observedAt: observedAt, participants: participants)

        case .speakerHighlight(let observedAt, let highlightedTileIds):
            return reduceHighlight(observedAt: observedAt, tileIds: highlightedTileIds)
        }
    }

    /// Zero or one event: the message is checked against the contract before a
    /// sequence number is spent on it, so this reducer cannot put an event on
    /// the wire that the decoder in `BridgeProtocol.swift` would reject. A
    /// `UiIdentityResolver` returning `""` is the case this exists for — the
    /// recorder would write it and nothing could read it back. The refusal is
    /// recorded in `refusedEvents` rather than thrown, so one unusable
    /// observation does not take the session down with it.
    private func emit(_ observedAt: String, _ event: BridgeEvent) -> [BridgeEventMessage] {
        if let violation = BridgeEventMessage.contractViolation(
            sessionId: sessionId, sequence: sequence + 1, observedAt: observedAt, event: event)
        {
            refusedEvents.append(violation)
            return []
        }
        sequence += 1
        return [
            BridgeEventMessage(
                sessionId: sessionId, sequence: sequence, observedAt: observedAt, event: event)
        ]
    }

    private func reduceRoster(observedAt: String, participants: [RosterEntry])
        -> [BridgeEventMessage]
    {
        let next = Dictionary(
            participants.map { ($0.feishuUserId, $0.displayName) }, uniquingKeysWith: { first, _ in
                first
            })
        var events: [BridgeEventMessage] = []

        for userId in roster.keys.filter({ next[$0] == nil }).sorted() {
            events.append(contentsOf: emit(observedAt, .participantLeft(feishuUserId: userId)))
        }
        for userId in next.keys.filter({ roster[$0] == nil }).sorted() {
            guard let displayName = next[userId] else { continue }
            events.append(
                contentsOf: emit(
                    observedAt, .participantJoined(feishuUserId: userId, displayName: displayName)))
        }

        roster = next
        return events
    }

    private func reduceHighlight(observedAt: String, tileIds: [String]) -> [BridgeEventMessage] {
        let next: ActiveSpeaker?
        switch tileIds.count {
        case 0:
            next = nil
        case 1:
            next =
                identity.identify(uiElementId: tileIds[0]).map(ActiveSpeaker.uiExact(feishuUserId:))
                ?? .ambiguous
        default:
            next = .ambiguous
        }

        guard let next, next != activeSpeaker else { return [] }
        let events = emit(observedAt, .activeSpeaker(next))
        // The remembered state is what suppresses a repeat, so it is committed
        // only when an event actually went out; a refused speaker must not
        // silence the next observation of the same one.
        if !events.isEmpty { activeSpeaker = next }
        return events
    }
}
