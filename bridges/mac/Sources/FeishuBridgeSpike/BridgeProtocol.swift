import Foundation

/// bridge-session/v1 — derived Swift view of the frozen bridge contract.
///
/// The normative definition is `protocols/bridge-session-v1.schema.json` plus the
/// canonical bytes in `fixtures/contracts/bridge-session-v1.json`. This file and
/// `spikes/feishu/src/protocol.ts` are two views of those same bytes; the test
/// target reads the fixture from disk and round-trips it, which is what keeps the
/// two languages from drifting apart.
///
/// The same fail-closed rules the TypeScript view encodes are encoded here:
/// an unrecognised `schema` is rejected rather than upgraded, unknown fields are
/// rejected rather than ignored, required strings are non-empty, timestamps are
/// Z-suffixed UTC, and speaker identity is never guessed — `ui_exact` requires a
/// user id and `ambiguous` requires a null one. The last rule is enforced twice
/// over: `ActiveSpeaker` cannot even *represent* the rejected combination, so no
/// code path in this package can emit a speaker id beside an ambiguous
/// confidence.
public let bridgeSessionSchema = "bridge-session/v1"

// MARK: - rejections

/// Machine-readable rejection reasons. Every case below spells the same string
/// as its `BridgeRejectionCode` counterpart in the TypeScript view, but the set
/// is a strict subset of it: five of that type's codes have no producer here.
///
///   - `not_an_object` — `JSONDecoder` fails with its own type mismatch before
///     any contract check in this file runs, so nothing here can raise it.
///   - `session_mismatch`, `sequence_duplicate`, `sequence_out_of_order` — the
///     stream rules, which live in `BridgeRecorder` and are reported by
///     returning `false` from `record`, not by throwing a contract error.
///   - `unknown_command_id` — needs the set of commands a session issued, which
///     the coordinator holds. This package never validates a `command_result`
///     against it.
///
/// A Swift case is added here only when Swift code can actually produce it.
public struct BridgeContractError: Error, Equatable, CustomStringConvertible {
    public enum Code: String, Sendable {
        case schemaUnknown = "schema_unknown"
        case unknownType = "unknown_type"
        case missingField = "missing_field"
        case unknownField = "unknown_field"
        case fieldType = "field_type"
        case enumValue = "enum_value"
        case timestampFormat = "timestamp_format"
        case speakerIdentityRequired = "speaker_identity_required"
        case speakerIdentityForbidden = "speaker_identity_forbidden"
    }

    public let code: Code
    /// JSON pointer to the offending member; "" when the whole message is wrong.
    public let path: String
    public let detail: String

    public var description: String { "\(code.rawValue) at \(path.isEmpty ? "/" : path): \(detail)" }
}

// MARK: - payload vocabularies

/// The active speaker as the client UI reported it. Two cases, not a struct with
/// an optional id and a separate confidence: the combination the contract rejects
/// is unrepresentable rather than merely validated.
public enum ActiveSpeaker: Equatable, Sendable {
    case uiExact(feishuUserId: String)
    case ambiguous

    /// Optional by construction — `ambiguous` has no identity, and the frozen
    /// fixture carries an explicit null for it.
    public var feishuUserId: String? {
        if case .uiExact(let id) = self { return id }
        return nil
    }

    public var confidence: String {
        switch self {
        case .uiExact: "ui_exact"
        case .ambiguous: "ambiguous"
        }
    }
}

public enum LeaveReason: String, Sendable, CaseIterable {
    case meetingEnded = "meeting_ended"
    case coordinatorStop = "coordinator_stop"
}

public enum LeftReason: String, Sendable, CaseIterable {
    case ended
    case removed
    case bridgeFailure = "bridge_failure"
}

public enum AudioDirection: String, Sendable, CaseIterable {
    case capture
    case playback
}

public enum DisclosureOutcome: String, Sendable, CaseIterable {
    case sent
    case unavailable
    case failed
}

public enum CommandOutcome: String, Sendable, CaseIterable {
    case ok
    case rejected
    case failed
}

// MARK: - commands

public enum BridgeCommand: Equatable, Sendable {
    case join(meetingOccurrenceId: String, meetingNo: String, leaseId: String)
    case connectMedia(endpoint: String, sessionToken: String, format: String, expiresAt: String)
    case postDisclosure(text: String)
    case leave(reason: LeaveReason)
    case releaseLease(leaseId: String)

    public var typeName: String {
        switch self {
        case .join: "join"
        case .connectMedia: "connect_media"
        case .postDisclosure: "post_disclosure"
        case .leave: "leave"
        case .releaseLease: "release_lease"
        }
    }

    /// Declaration order is the contract's canonical order.
    public static let allTypeNames = [
        "join", "connect_media", "post_disclosure", "leave", "release_lease",
    ]

    fileprivate var payloadKeys: [BridgeCodingKey] {
        switch self {
        case .join: [.meetingOccurrenceId, .meetingNo, .leaseId]
        case .connectMedia: [.endpoint, .sessionToken, .format, .expiresAt]
        case .postDisclosure: [.text]
        case .leave: [.reason]
        case .releaseLease: [.leaseId]
        }
    }
}

// MARK: - events

public enum BridgeEvent: Equatable, Sendable {
    case joined(meetingOccurrenceId: String)
    case left(reason: LeftReason)
    case participantJoined(feishuUserId: String, displayName: String)
    case participantLeft(feishuUserId: String)
    case activeSpeaker(ActiveSpeaker)
    case audioGap(direction: AudioDirection, startedAt: String, endedAt: String?)
    case chatDisclosure(outcome: DisclosureOutcome)
    case mediaConnected(endpoint: String)
    case mediaDisconnected(reason: String)
    case commandResult(commandId: String, outcome: CommandOutcome, detail: String?)
    case reconnecting(attempt: Int)
    case reconnected(attempt: Int)

    public var typeName: String {
        switch self {
        case .joined: "joined"
        case .left: "left"
        case .participantJoined: "participant_joined"
        case .participantLeft: "participant_left"
        case .activeSpeaker: "active_speaker"
        case .audioGap: "audio_gap"
        case .chatDisclosure: "chat_disclosure"
        case .mediaConnected: "media_connected"
        case .mediaDisconnected: "media_disconnected"
        case .commandResult: "command_result"
        case .reconnecting: "reconnecting"
        case .reconnected: "reconnected"
        }
    }

    /// Declaration order is the contract's canonical order.
    public static let allTypeNames = [
        "joined", "left", "participant_joined", "participant_left", "active_speaker",
        "audio_gap", "chat_disclosure", "media_connected", "media_disconnected",
        "command_result", "reconnecting", "reconnected",
    ]

    fileprivate var payloadKeys: [BridgeCodingKey] {
        switch self {
        case .joined: [.meetingOccurrenceId]
        case .left: [.reason]
        case .participantJoined: [.feishuUserId, .displayName]
        case .participantLeft: [.feishuUserId]
        case .activeSpeaker: [.feishuUserId, .confidence]
        case .audioGap: [.direction, .startedAt, .endedAt]
        case .chatDisclosure: [.outcome]
        case .mediaConnected: [.endpoint]
        case .mediaDisconnected: [.reason]
        case .commandResult: [.commandId, .outcome, .detail]
        case .reconnecting: [.attempt]
        case .reconnected: [.attempt]
        }
    }
}

// MARK: - wire messages

/// A command as it appears on the wire: envelope fields plus one payload.
public struct BridgeCommandMessage: Equatable, Sendable {
    public let sessionId: String
    public let commandId: String
    public let command: BridgeCommand

    public init(sessionId: String, commandId: String, command: BridgeCommand) {
        self.sessionId = sessionId
        self.commandId = commandId
        self.command = command
    }
}

/// An event as it appears on the wire: envelope fields plus one payload.
public struct BridgeEventMessage: Equatable, Sendable {
    public let sessionId: String
    public let sequence: Int
    public let observedAt: String
    public let event: BridgeEvent

    public init(sessionId: String, sequence: Int, observedAt: String, event: BridgeEvent) {
        self.sessionId = sessionId
        self.sequence = sequence
        self.observedAt = observedAt
        self.event = event
    }
}

private func contractNonEmpty(_ value: String, _ path: String) -> BridgeContractError? {
    value.isEmpty
        ? BridgeContractError(code: .fieldType, path: path, detail: "expected a non-empty string")
        : nil
}

private func contractUtcTimestamp(_ value: String, _ path: String) -> BridgeContractError? {
    if let failure = contractNonEmpty(value, path) { return failure }
    return value.range(of: utcTimestampPattern, options: .regularExpression) == nil
        ? BridgeContractError(
            code: .timestampFormat, path: path, detail: "expected a Z-suffixed UTC timestamp")
        : nil
}

private func contractPositiveInt(_ value: Int, _ path: String) -> BridgeContractError? {
    value >= 1
        ? nil
        : BridgeContractError(code: .fieldType, path: path, detail: "expected an integer >= 1")
}

extension BridgeEventMessage {
    /// The contract's shape rules, applied to a message about to be built rather
    /// than one being decoded — the counterpart of the `parseEventShape`
    /// self-check `spikes/feishu/src/reducer.ts` runs before it returns an event.
    ///
    /// The types alone are not enough. They do make one rejected combination
    /// unrepresentable — `ui_exact` beside a nil identity — but every initialiser
    /// above takes a bare `String`/`Int`, so a non-empty string, a Z-suffixed UTC
    /// timestamp and a sequence of at least 1 are all still checkable claims. A
    /// producer that fills an identity with `""` would otherwise write a
    /// transcript this package's own decoder rejects.
    ///
    /// - Returns: nil when the message would decode, otherwise the rejection it
    ///   would decode into, with the same code and path the decoder uses.
    public static func contractViolation(
        sessionId: String, sequence: Int, observedAt: String, event: BridgeEvent
    ) -> BridgeContractError? {
        if let failure = contractNonEmpty(sessionId, "/sessionId") { return failure }
        if let failure = contractPositiveInt(sequence, "/sequence") { return failure }
        if let failure = contractUtcTimestamp(observedAt, "/observedAt") { return failure }

        switch event {
        case .joined(let meetingOccurrenceId):
            return contractNonEmpty(meetingOccurrenceId, "/meetingOccurrenceId")
        case .left, .chatDisclosure:
            // Both payloads are enums: no case of either can be malformed.
            return nil
        case .participantJoined(let feishuUserId, let displayName):
            return contractNonEmpty(feishuUserId, "/feishuUserId")
                ?? contractNonEmpty(displayName, "/displayName")
        case .participantLeft(let feishuUserId):
            return contractNonEmpty(feishuUserId, "/feishuUserId")
        case .activeSpeaker(let speaker):
            guard case .uiExact(let feishuUserId) = speaker else { return nil }
            return contractNonEmpty(feishuUserId, "/feishuUserId")
        case .audioGap(_, let startedAt, let endedAt):
            return contractUtcTimestamp(startedAt, "/startedAt")
                ?? endedAt.flatMap { contractUtcTimestamp($0, "/endedAt") }
        case .mediaConnected(let endpoint):
            return contractNonEmpty(endpoint, "/endpoint")
        case .mediaDisconnected(let reason):
            return contractNonEmpty(reason, "/reason")
        case .commandResult(let commandId, _, let detail):
            return contractNonEmpty(commandId, "/commandId")
                ?? detail.flatMap { contractNonEmpty($0, "/detail") }
        case .reconnecting(let attempt), .reconnected(let attempt):
            return contractPositiveInt(attempt, "/attempt")
        }
    }
}

extension BridgeCommandMessage {
    /// The command counterpart of `BridgeEventMessage.contractViolation`.
    /// Recorder callers can construct these values directly, so recording must
    /// apply the same checks the decoder applies before evidence is accepted.
    public static func contractViolation(
        sessionId: String, commandId: String, command: BridgeCommand
    ) -> BridgeContractError? {
        if let failure = contractNonEmpty(sessionId, "/sessionId") { return failure }
        if let failure = contractNonEmpty(commandId, "/commandId") { return failure }

        switch command {
        case .join(let meetingOccurrenceId, let meetingNo, let leaseId):
            return contractNonEmpty(meetingOccurrenceId, "/meetingOccurrenceId")
                ?? contractNonEmpty(meetingNo, "/meetingNo")
                ?? contractNonEmpty(leaseId, "/leaseId")
        case .connectMedia(let endpoint, let sessionToken, let format, let expiresAt):
            return contractNonEmpty(endpoint, "/endpoint")
                ?? contractNonEmpty(sessionToken, "/sessionToken")
                ?? contractNonEmpty(format, "/format")
                ?? contractUtcTimestamp(expiresAt, "/expiresAt")
        case .postDisclosure(let text):
            return contractNonEmpty(text, "/text")
        case .leave:
            return nil
        case .releaseLease(let leaseId):
            return contractNonEmpty(leaseId, "/leaseId")
        }
    }
}

/// One whole recorded session: exactly the shape of
/// `fixtures/contracts/bridge-session-v1.json`.
public struct BridgeSessionTranscript: Equatable, Sendable {
    public let sessionId: String
    public let commands: [BridgeCommandMessage]
    public let events: [BridgeEventMessage]

    public init(
        sessionId: String, commands: [BridgeCommandMessage], events: [BridgeEventMessage]
    ) {
        self.sessionId = sessionId
        self.commands = commands
        self.events = events
    }
}

// MARK: - coding

enum BridgeCodingKey: String, CodingKey {
    case schema, type
    case sessionId, commandId, sequence, observedAt
    case commands, events
    case meetingOccurrenceId, meetingNo, leaseId
    case endpoint, sessionToken, format, expiresAt
    case text, reason
    case feishuUserId, displayName, confidence
    case direction, startedAt, endedAt
    case outcome, detail, attempt
}

/// A key that accepts anything, so the decoder can see the members the JSON
/// actually carries and reject the ones the contract does not declare.
private struct AnyCodingKey: CodingKey {
    let stringValue: String
    init?(stringValue: String) { self.stringValue = stringValue }
    var intValue: Int? { nil }
    init?(intValue _: Int) { nil }
}

private let utcTimestampPattern =
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{3})?Z$"

extension KeyedDecodingContainer where Key == BridgeCodingKey {

    fileprivate func present(_ key: Key) throws -> Bool {
        guard contains(key) else {
            throw BridgeContractError(
                code: .missingField, path: "/\(key.stringValue)",
                detail: "\(key.stringValue) is required")
        }
        return true
    }

    fileprivate func nonEmptyString(_ key: Key) throws -> String {
        _ = try present(key)
        guard let value = try? decode(String.self, forKey: key), !value.isEmpty else {
            throw BridgeContractError(
                code: .fieldType, path: "/\(key.stringValue)",
                detail: "expected a non-empty string")
        }
        return value
    }

    fileprivate func nullableNonEmptyString(_ key: Key) throws -> String? {
        _ = try present(key)
        if try decodeNil(forKey: key) { return nil }
        return try nonEmptyString(key)
    }

    fileprivate func utcTimestamp(_ key: Key) throws -> String {
        let value = try nonEmptyString(key)
        guard value.range(of: utcTimestampPattern, options: .regularExpression) != nil else {
            throw BridgeContractError(
                code: .timestampFormat, path: "/\(key.stringValue)",
                detail: "expected a Z-suffixed UTC timestamp")
        }
        return value
    }

    fileprivate func nullableUtcTimestamp(_ key: Key) throws -> String? {
        _ = try present(key)
        if try decodeNil(forKey: key) { return nil }
        return try utcTimestamp(key)
    }

    fileprivate func positiveInt(_ key: Key) throws -> Int {
        _ = try present(key)
        guard let value = try? decode(Int.self, forKey: key), value >= 1 else {
            throw BridgeContractError(
                code: .fieldType, path: "/\(key.stringValue)", detail: "expected an integer >= 1")
        }
        return value
    }

    fileprivate func enumValue<T: RawRepresentable & CaseIterable>(_ key: Key, _: T.Type) throws -> T
    where T.RawValue == String {
        let raw = try nonEmptyString(key)
        guard let value = T(rawValue: raw) else {
            throw BridgeContractError(
                code: .enumValue, path: "/\(key.stringValue)",
                detail: "expected one of: " + T.allCases.map(\.rawValue).joined(separator: ", "))
        }
        return value
    }

    fileprivate func checkedSchema() throws {
        guard try nonEmptyString(.schema) == bridgeSessionSchema else {
            throw BridgeContractError(
                code: .schemaUnknown, path: "/schema", detail: "expected \(bridgeSessionSchema)")
        }
    }
}

extension Decoder {
    /// Rejects any member the contract does not declare for this message. `in`-style
    /// leniency is exactly how an unknown field slips through unnoticed.
    fileprivate func rejectUnknownMembers(allowing declared: [BridgeCodingKey]) throws {
        let present = try container(keyedBy: AnyCodingKey.self).allKeys.map(\.stringValue)
        let allowed = Set(declared.map(\.stringValue))
        for key in present where !allowed.contains(key) {
            throw BridgeContractError(
                code: .unknownField, path: "/\(key)",
                detail: "unknown fields are rejected, not ignored")
        }
    }
}

extension BridgeCommandMessage: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: BridgeCodingKey.self)
        try container.checkedSchema()
        sessionId = try container.nonEmptyString(.sessionId)
        commandId = try container.nonEmptyString(.commandId)

        switch try container.nonEmptyString(.type) {
        case "join":
            command = .join(
                meetingOccurrenceId: try container.nonEmptyString(.meetingOccurrenceId),
                meetingNo: try container.nonEmptyString(.meetingNo),
                leaseId: try container.nonEmptyString(.leaseId))
        case "connect_media":
            command = .connectMedia(
                endpoint: try container.nonEmptyString(.endpoint),
                sessionToken: try container.nonEmptyString(.sessionToken),
                format: try container.nonEmptyString(.format),
                expiresAt: try container.utcTimestamp(.expiresAt))
        case "post_disclosure":
            command = .postDisclosure(text: try container.nonEmptyString(.text))
        case "leave":
            command = .leave(reason: try container.enumValue(.reason, LeaveReason.self))
        case "release_lease":
            command = .releaseLease(leaseId: try container.nonEmptyString(.leaseId))
        case let other:
            throw BridgeContractError(
                code: .unknownType, path: "/type", detail: "unrecognised type: \(other)")
        }

        try decoder.rejectUnknownMembers(
            allowing: [.schema, .type, .sessionId, .commandId] + command.payloadKeys)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: BridgeCodingKey.self)
        try container.encode(bridgeSessionSchema, forKey: .schema)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(commandId, forKey: .commandId)
        try container.encode(command.typeName, forKey: .type)

        switch command {
        case .join(let meetingOccurrenceId, let meetingNo, let leaseId):
            try container.encode(meetingOccurrenceId, forKey: .meetingOccurrenceId)
            try container.encode(meetingNo, forKey: .meetingNo)
            try container.encode(leaseId, forKey: .leaseId)
        case .connectMedia(let endpoint, let sessionToken, let format, let expiresAt):
            try container.encode(endpoint, forKey: .endpoint)
            try container.encode(sessionToken, forKey: .sessionToken)
            try container.encode(format, forKey: .format)
            try container.encode(expiresAt, forKey: .expiresAt)
        case .postDisclosure(let text):
            try container.encode(text, forKey: .text)
        case .leave(let reason):
            try container.encode(reason.rawValue, forKey: .reason)
        case .releaseLease(let leaseId):
            try container.encode(leaseId, forKey: .leaseId)
        }
    }
}

extension BridgeEventMessage: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: BridgeCodingKey.self)
        try container.checkedSchema()
        sessionId = try container.nonEmptyString(.sessionId)
        sequence = try container.positiveInt(.sequence)
        observedAt = try container.utcTimestamp(.observedAt)

        switch try container.nonEmptyString(.type) {
        case "joined":
            event = .joined(meetingOccurrenceId: try container.nonEmptyString(.meetingOccurrenceId))
        case "left":
            event = .left(reason: try container.enumValue(.reason, LeftReason.self))
        case "participant_joined":
            event = .participantJoined(
                feishuUserId: try container.nonEmptyString(.feishuUserId),
                displayName: try container.nonEmptyString(.displayName))
        case "participant_left":
            event = .participantLeft(feishuUserId: try container.nonEmptyString(.feishuUserId))
        case "active_speaker":
            // feishuUserId is required-but-nullable here, and decoded as an
            // optional: a decoder that demands a string reads the frozen fixture
            // fine and then throws the first time a real meeting cannot say who
            // is speaking.
            let identity = try container.nullableNonEmptyString(.feishuUserId)
            switch try container.nonEmptyString(.confidence) {
            case "ui_exact":
                guard let identity else {
                    throw BridgeContractError(
                        code: .speakerIdentityRequired, path: "/feishuUserId",
                        detail: "ui_exact requires an observed user id")
                }
                event = .activeSpeaker(.uiExact(feishuUserId: identity))
            case "ambiguous":
                guard identity == nil else {
                    throw BridgeContractError(
                        code: .speakerIdentityForbidden, path: "/feishuUserId",
                        detail:
                            "ambiguous must stay anonymous; speaker identity is never guessed")
                }
                event = .activeSpeaker(.ambiguous)
            case let other:
                throw BridgeContractError(
                    code: .enumValue, path: "/confidence",
                    detail: "expected one of: ui_exact, ambiguous (got \(other))")
            }
        case "audio_gap":
            event = .audioGap(
                direction: try container.enumValue(.direction, AudioDirection.self),
                startedAt: try container.utcTimestamp(.startedAt),
                endedAt: try container.nullableUtcTimestamp(.endedAt))
        case "chat_disclosure":
            event = .chatDisclosure(outcome: try container.enumValue(.outcome, DisclosureOutcome.self))
        case "media_connected":
            event = .mediaConnected(endpoint: try container.nonEmptyString(.endpoint))
        case "media_disconnected":
            event = .mediaDisconnected(reason: try container.nonEmptyString(.reason))
        case "command_result":
            event = .commandResult(
                commandId: try container.nonEmptyString(.commandId),
                outcome: try container.enumValue(.outcome, CommandOutcome.self),
                detail: try container.nullableNonEmptyString(.detail))
        case "reconnecting":
            event = .reconnecting(attempt: try container.positiveInt(.attempt))
        case "reconnected":
            event = .reconnected(attempt: try container.positiveInt(.attempt))
        case let other:
            throw BridgeContractError(
                code: .unknownType, path: "/type", detail: "unrecognised type: \(other)")
        }

        try decoder.rejectUnknownMembers(
            allowing: [.schema, .type, .sessionId, .sequence, .observedAt] + event.payloadKeys)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: BridgeCodingKey.self)
        try container.encode(bridgeSessionSchema, forKey: .schema)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(sequence, forKey: .sequence)
        try container.encode(observedAt, forKey: .observedAt)
        try container.encode(event.typeName, forKey: .type)

        switch event {
        case .joined(let meetingOccurrenceId):
            try container.encode(meetingOccurrenceId, forKey: .meetingOccurrenceId)
        case .left(let reason):
            try container.encode(reason.rawValue, forKey: .reason)
        case .participantJoined(let feishuUserId, let displayName):
            try container.encode(feishuUserId, forKey: .feishuUserId)
            try container.encode(displayName, forKey: .displayName)
        case .participantLeft(let feishuUserId):
            try container.encode(feishuUserId, forKey: .feishuUserId)
        case .activeSpeaker(let speaker):
            // Explicitly null, never an omitted key: the contract declares the
            // member required and nullable, and those are different wire shapes.
            if let identity = speaker.feishuUserId {
                try container.encode(identity, forKey: .feishuUserId)
            } else {
                try container.encodeNil(forKey: .feishuUserId)
            }
            try container.encode(speaker.confidence, forKey: .confidence)
        case .audioGap(let direction, let startedAt, let endedAt):
            try container.encode(direction.rawValue, forKey: .direction)
            try container.encode(startedAt, forKey: .startedAt)
            if let endedAt {
                try container.encode(endedAt, forKey: .endedAt)
            } else {
                try container.encodeNil(forKey: .endedAt)
            }
        case .chatDisclosure(let outcome):
            try container.encode(outcome.rawValue, forKey: .outcome)
        case .mediaConnected(let endpoint):
            try container.encode(endpoint, forKey: .endpoint)
        case .mediaDisconnected(let reason):
            try container.encode(reason, forKey: .reason)
        case .commandResult(let commandId, let outcome, let detail):
            try container.encode(commandId, forKey: .commandId)
            try container.encode(outcome.rawValue, forKey: .outcome)
            if let detail {
                try container.encode(detail, forKey: .detail)
            } else {
                try container.encodeNil(forKey: .detail)
            }
        case .reconnecting(let attempt), .reconnected(let attempt):
            try container.encode(attempt, forKey: .attempt)
        }
    }
}

extension BridgeSessionTranscript: Codable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: BridgeCodingKey.self)
        try container.checkedSchema()
        sessionId = try container.nonEmptyString(.sessionId)
        commands = try container.decode([BridgeCommandMessage].self, forKey: .commands)
        events = try container.decode([BridgeEventMessage].self, forKey: .events)
        try decoder.rejectUnknownMembers(allowing: [.schema, .sessionId, .commands, .events])
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: BridgeCodingKey.self)
        try container.encode(bridgeSessionSchema, forKey: .schema)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(commands, forKey: .commands)
        try container.encode(events, forKey: .events)
    }
}
