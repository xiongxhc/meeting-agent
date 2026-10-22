import Foundation
import Darwin

public struct BridgeCustodyBinding: Equatable, Sendable {
    public let physicalClientId: String, physicalGenerationId: String, occurrenceId: String, bridgeSessionId: String
    var object: [String: String] { ["physicalClientId": physicalClientId, "physicalGenerationId": physicalGenerationId, "occurrenceId": occurrenceId, "bridgeSessionId": bridgeSessionId] }
    public init(object: [String: Any]) throws {
        guard Set(object.keys) == ["physicalClientId", "physicalGenerationId", "occurrenceId", "bridgeSessionId"],
              let slot = object["physicalClientId"] as? String, let generation = object["physicalGenerationId"] as? String,
              let occurrence = object["occurrenceId"] as? String, let session = object["bridgeSessionId"] as? String,
              slot.range(of: "\\A[A-Za-z0-9._-]{1,128}\\z", options: .regularExpression) != nil, slot != ".", slot != "..",
              generation.range(of: "\\A[a-f0-9]{32}\\z", options: .regularExpression) != nil,
              occurrence.utf8.count <= 4096, session.utf8.count <= 4096, !session.isEmpty,
              let separator = occurrence.lastIndex(of: "@"), separator != occurrence.startIndex,
              !occurrence[..<separator].unicodeScalars.contains(where: { $0.value <= 31 || $0.value == 127 }),
              validAuditInstant(String(occurrence[occurrence.index(after: separator)...]), fractions: false),
              BridgeCommandMessage.contractViolation(sessionId: session, commandId: "binding", command: .join(meetingOccurrenceId: occurrence, meetingNo: "000000001", leaseId: "binding")) == nil else { throw BridgeProcessError.invalidInput }
        physicalClientId = slot; physicalGenerationId = generation; occurrenceId = occurrence; bridgeSessionId = session
        var maximum = self.object
        maximum["schema"] = "bridge-process-outcome/v1"; maximum["outcome"] = "departure_unconfirmed"
        maximum["reason"] = "departure_not_observed"; maximum["observedAt"] = "9999-12-31T23:59:59.999Z"
        guard try JSONSerialization.data(withJSONObject: maximum, options: [.withoutEscapingSlashes]).count + 1 <= 4096 else { throw BridgeProcessError.inputTooLarge }
    }
}

private func validAuditInstant(_ value: String, fractions: Bool = true) -> Bool {
    let pattern = fractions ? "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{3})?Z$" : "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
    guard value.range(of: pattern, options: .regularExpression) != nil else { return false }
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian); formatter.timeZone = TimeZone(secondsFromGMT: 0)
    formatter.dateFormat = value.contains(".") ? "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'" : "yyyy-MM-dd'T'HH:mm:ss'Z'"
    formatter.isLenient = false
    guard let date = formatter.date(from: value) else { return false }
    return formatter.string(from: date) == value
}

public struct BridgeCleanupStatus: Equatable, Sendable {
    public let outcome: String, reason: String
    static let noAction = Self(outcome: "no_join_action", reason: "join_not_issued")
    static let confirmed = Self(outcome: "departure_confirmed", reason: "departure_observed")
    static func unconfirmed(_ reason: String) -> Self { Self(outcome: "departure_unconfirmed", reason: reason) }
    /// No client could be bound at launch, so no join was ever issued.
    public static func clientUnavailable(_ failure: ClientResolutionFailure) -> Self { Self(outcome: "no_join_action", reason: failure.rawValue) }
}

public struct BridgeProcessOutcome: Equatable, Sendable {
    public let binding: BridgeCustodyBinding
    public let outcome: String, reason: String, observedAt: String
    public init(binding: BridgeCustodyBinding, status: BridgeCleanupStatus, observedAt: String) throws {
        guard validAuditInstant(observedAt),
              status == .confirmed || status == .noAction || status.outcome == "no_join_action" && ClientResolutionFailure(rawValue: status.reason) != nil || status.outcome == "departure_unconfirmed" && ["departure_not_observed", "evidence_unavailable", "input_reap_failed", "cleanup_failed"].contains(status.reason) else { throw BridgeProcessError.invalidInput }
        self.binding = binding; outcome = status.outcome; reason = status.reason; self.observedAt = observedAt
    }
    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= 4096, let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(raw.keys) == ["schema", "physicalClientId", "physicalGenerationId", "occurrenceId", "bridgeSessionId", "outcome", "reason", "observedAt"],
              raw["schema"] as? String == "bridge-process-outcome/v1", let outcome = raw["outcome"] as? String,
              let reason = raw["reason"] as? String, let at = raw["observedAt"] as? String else { throw BridgeProcessError.invalidInput }
        // Every accepted member is string-valued and the object is flat. An
        // extra structural colon therefore exposes a duplicate JSON member.
        var quoted = false, escaped = false, members = 0
        for byte in data {
            if quoted {
                if escaped { escaped = false }
                else if byte == 92 { escaped = true }
                else if byte == 34 { quoted = false }
            } else if byte == 34 { quoted = true }
            else if byte == 58 { members += 1 }
        }
        guard members == 8 else { throw BridgeProcessError.invalidInput }
        let binding = try BridgeCustodyBinding(object: raw.filter { ["physicalClientId", "physicalGenerationId", "occurrenceId", "bridgeSessionId"].contains($0.key) })
        return try Self(binding: binding, status: BridgeCleanupStatus(outcome: outcome, reason: reason), observedAt: at)
    }
    public func line() throws -> Data {
        var object = binding.object
        object["schema"] = "bridge-process-outcome/v1"; object["outcome"] = outcome
        object["reason"] = reason; object["observedAt"] = observedAt
        let line = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]) + Data([10])
        guard line.count <= 4096 else { throw BridgeProcessError.inputTooLarge }; return line
    }
}

/// Dedicated inherited outcome pipe; independent of stdout cancellation.
public final class BridgeOutcomeWriter {
    private var fd: Int32
    public convenience init() throws { try self.init(fd: 3) }
    init(fd: Int32) throws {
        let flags = fcntl(fd, F_GETFL); var info = stat()
        guard flags >= 0, flags & O_ACCMODE != O_RDONLY, fstat(fd, &info) == 0,
              [S_IFIFO, S_IFSOCK].contains(info.st_mode & S_IFMT),
              fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { throw BridgeProcessError.outputUnavailable }
        self.fd = fd
    }
    public func write(_ outcome: BridgeProcessOutcome) throws {
        guard fd >= 0 else { throw BridgeProcessError.closed }
        defer { close() }
        let line = try outcome.line(), end = ProcessInfo.processInfo.systemUptime + 1
        try line.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard ProcessInfo.processInfo.systemUptime < end else { throw BridgeProcessError.outputUnavailable }
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count; continue }
                if count < 0 && errno == EINTR { continue }
                guard count < 0, errno == EAGAIN || errno == EWOULDBLOCK else { throw BridgeProcessError.outputUnavailable }
                var state = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0); _ = poll(&state, 1, 25)
            }
        }
    }
    public func close() { if fd >= 0 { Darwin.close(fd); fd = -1 } }
    deinit { close() }
}
