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
    case command(recordedAt: String, message: BridgeCommandMessage)
    case event(recordedAt: String, message: BridgeEventMessage)
}

/// JSONL evidence recorder for one bridge session — the Swift counterpart of
/// `spikes/feishu/src/recorder.ts`, writing the same record shape:
/// `{"direction":…,"message":{…},"recordedAt":…}`, one JSON object per line.
///
/// Two differences from the TypeScript recorder, both deliberate. Keys are
/// written sorted, because Swift's encoder does not promise insertion order and
/// deterministic bytes matter more than matching JavaScript's key order. And the
/// per-message shape checks happen before a message gets here rather than in
/// this file: the types rule out one combination on their own — `ActiveSpeaker`
/// cannot hold a user id beside an ambiguous confidence — but they do not make a
/// non-empty string, a Z-suffixed UTC timestamp or a `sequence` of at least 1
/// unrepresentable, since every initialiser takes a bare `String`/`Int`. Those
/// are checked by `BridgeEventMessage.contractViolation`, which
/// `SessionObservationReducer.emit` runs before it builds an event. A message
/// built by some other means is recorded as it was given, so a producer that
/// skips that check can still put an unreadable line in the evidence.
///
/// What this file checks is the stream rules, which no type expresses: the
/// session must match, and `sequence` must strictly increase (gaps allowed,
/// repeats and regressions rejected).
public final class BridgeRecorder {
    public let sessionId: String
    public private(set) var records: [BridgeRecord] = []
    private let clock: any BridgeClock
    private var lastSequence = 0

    public init(sessionId: String, clock: any BridgeClock) {
        self.sessionId = sessionId
        self.clock = clock
    }

    /// - Returns: whether the message was recorded. A rejected message never
    ///   reaches the evidence file.
    @discardableResult
    public func record(command: BridgeCommandMessage) -> Bool {
        guard command.sessionId == sessionId else { return false }
        records.append(.command(recordedAt: clock.now(), message: command))
        return true
    }

    @discardableResult
    public func record(event: BridgeEventMessage) -> Bool {
        guard event.sessionId == sessionId, event.sequence > lastSequence else { return false }
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
