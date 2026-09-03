import Foundation

/// The bridge's only source of "now". Nothing in this package calls `Date()`
/// inline, so recorded evidence is reproducible byte for byte in tests.
public protocol BridgeClock {
    /// Current instant as a Z-suffixed UTC timestamp.
    func now() -> String
}

/// A clock that never reads the wall clock: it starts at `start` and steps
/// forward on every call after the first. The counterpart of
/// `createSequentialClock` in `spikes/feishu/src/replay.ts`.
public final class SequentialClock: BridgeClock {
    private var milliseconds: Int
    private let step: Int
    private var calls = 0

    public init(start: String, stepMilliseconds: Int = 1000) {
        self.milliseconds = SequentialClock.parse(start)
        self.step = stepMilliseconds
    }

    public func now() -> String {
        if calls > 0 { milliseconds += step }
        calls += 1
        return SequentialClock.format(milliseconds)
    }

    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }()

    private static func parse(_ iso: String) -> Int {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) {
            return Int((date.timeIntervalSince1970 * 1000).rounded())
        }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: iso) else {
            // Falling back to the epoch would turn a typo into plausible-looking
            // 1970 evidence rather than a failure.
            preconditionFailure("SequentialClock start is not a UTC timestamp: \(iso)")
        }
        return Int((date.timeIntervalSince1970 * 1000).rounded())
    }

    private static func format(_ milliseconds: Int) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1000))
    }
}

public enum BridgeRecord: Equatable, Sendable {
    case command(recordedAt: String, message: EvidenceCommandMessage)
    case event(recordedAt: String, message: BridgeEventMessage)
}

/// The persisted command payload. Its cases deliberately cannot represent a
/// `connect_media.sessionToken`.
private enum EvidenceCommand: Equatable, Sendable {
    case join(meetingOccurrenceId: String, meetingNo: String, leaseId: String)
    case connectMedia(endpoint: String, format: String, expiresAt: String)
    case postDisclosure(text: String)
    case leave(reason: LeaveReason)
    case releaseLease(leaseId: String)
}

/// The persisted command shape. `connect_media.sessionToken` remains in the
/// live bridge command only; it is absent from both evidence memory and JSONL.
public struct EvidenceCommandMessage: Equatable, Sendable, Encodable {
    private let sessionId: String
    private let commandId: String
    private let command: EvidenceCommand

    init(_ source: BridgeCommandMessage) {
        sessionId = source.sessionId
        commandId = source.commandId
        switch source.command {
        case .join(let meetingOccurrenceId, let meetingNo, let leaseId):
            command = .join(
                meetingOccurrenceId: meetingOccurrenceId, meetingNo: meetingNo, leaseId: leaseId)
        case .connectMedia(let endpoint, _, let format, let expiresAt):
            command = .connectMedia(endpoint: endpoint, format: format, expiresAt: expiresAt)
        case .postDisclosure(let text):
            command = .postDisclosure(text: text)
        case .leave(let reason):
            command = .leave(reason: reason)
        case .releaseLease(let leaseId):
            command = .releaseLease(leaseId: leaseId)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: BridgeCodingKey.self)
        try container.encode(bridgeSessionSchema, forKey: .schema)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(commandId, forKey: .commandId)

        switch command {
        case .join(let meetingOccurrenceId, let meetingNo, let leaseId):
            try container.encode("join", forKey: .type)
            try container.encode(meetingOccurrenceId, forKey: .meetingOccurrenceId)
            try container.encode(meetingNo, forKey: .meetingNo)
            try container.encode(leaseId, forKey: .leaseId)
        case .connectMedia(let endpoint, let format, let expiresAt):
            try container.encode("connect_media", forKey: .type)
            try container.encode(endpoint, forKey: .endpoint)
            try container.encode(format, forKey: .format)
            try container.encode(expiresAt, forKey: .expiresAt)
        case .postDisclosure(let text):
            try container.encode("post_disclosure", forKey: .type)
            try container.encode(text, forKey: .text)
        case .leave(let reason):
            try container.encode("leave", forKey: .type)
            try container.encode(reason.rawValue, forKey: .reason)
        case .releaseLease(let leaseId):
            try container.encode("release_lease", forKey: .type)
            try container.encode(leaseId, forKey: .leaseId)
        }
    }
}

/// JSONL evidence recorder for one bridge session — the Swift counterpart of
/// `spikes/feishu/src/recorder.ts`, writing the same record shape:
/// `{"direction":…,"message":{…},"recordedAt":…}`, one JSON object per line.
///
/// Keys are written sorted, because Swift's encoder does not promise insertion
/// order and deterministic bytes matter more than matching JavaScript's key
/// order. Every direct constructor is validated here, where persistence starts;
/// stream and command-result references are validated alongside it.
public final class BridgeRecorder {
    public let sessionId: String
    public private(set) var records: [BridgeRecord] = []
    private let clock: any BridgeClock
    private var lastSequence = 0
    private var issuedCommandIds: Set<String> = []

    public init(sessionId: String, clock: any BridgeClock) {
        self.sessionId = sessionId
        self.clock = clock
    }

    /// - Returns: whether the message was recorded. A rejected message never
    ///   reaches the evidence file.
    @discardableResult
    public func record(command: BridgeCommandMessage) -> Bool {
        guard command.sessionId == sessionId,
            BridgeCommandMessage.contractViolation(
                sessionId: command.sessionId, commandId: command.commandId, command: command.command) == nil
        else { return false }
        records.append(.command(recordedAt: clock.now(), message: EvidenceCommandMessage(command)))
        issuedCommandIds.insert(command.commandId)
        return true
    }

    @discardableResult
    public func record(event: BridgeEventMessage) -> Bool {
        guard event.sessionId == sessionId, event.sequence > lastSequence,
            BridgeEventMessage.contractViolation(
                sessionId: event.sessionId, sequence: event.sequence,
                observedAt: event.observedAt, event: event.event) == nil
        else { return false }
        if case .commandResult(let commandId, _, _) = event.event,
            !issuedCommandIds.contains(commandId)
        {
            return false
        }
        lastSequence = event.sequence
        records.append(.event(recordedAt: clock.now(), message: event))
        return true
    }

    /// One JSON object per line, trailing newline; "" when nothing was recorded.
    public func jsonl() throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var out = ""
        for record in records {
            let data: Data
            switch record {
            case .command(let recordedAt, let message):
                data = try encoder.encode(
                    RecordLine(recordedAt: recordedAt, direction: "command", message: message))
            case .event(let recordedAt, let message):
                data = try encoder.encode(
                    RecordLine(recordedAt: recordedAt, direction: "event", message: message))
            }
            out += String(decoding: data, as: UTF8.self) + "\n"
        }
        return out
    }
}

private struct RecordLine<Message: Encodable>: Encodable {
    let recordedAt: String
    let direction: String
    let message: Message
}
