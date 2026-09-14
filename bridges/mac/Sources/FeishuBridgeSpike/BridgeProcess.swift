import Foundation
import CryptoKit

public enum BridgeProcessError: String, Error {
    case invalidInput = "invalid_input", inputTooLarge = "input_too_large"
    case ownershipConflict = "ownership_conflict", commandConflict = "command_conflict"
    case stateLimit = "state_limit", evidenceUnavailable = "evidence_unavailable"
    case closed = "bridge_closed", outputUnavailable = "output_unavailable"
}

/// One serialized process generation owns exactly one session/occurrence/lease.
/// Release is terminal; a new generation requires a new process, never ID reuse.
public final class BridgeProcess {
    private let driver: any AccessibilityDriver
    private let adapter: FeishuClientAdapter
    private let cleanupAdapter: FeishuClientAdapter
    private let labels: FeishuUiLabels
    private let clock: any BridgeClock
    private let sink: any BridgeEvidenceSink
    private let output: (Data) throws -> Void
    private let maxCommands: Int
    private var recorder: BridgeRecorder?
    private var observer: AccessibilityObserver?
    private var reducer: SessionObservationReducer?
    private var owner: (session: String, occurrence: String, lease: String)?
    private var results: [String: (digest: Data, outcome: CommandOutcome, detail: String?)] = [:]
    private var sequence = 0
    private var joined = false
    private var released = false
    private var stopped = false
    private var shutdownCompleted = false
    private var departureConfirmed = false
    private var leftPublished = false
    public var retainedRecordCount: Int { recorder?.records.count ?? 0 }

    public init(driver: any AccessibilityDriver, labels: FeishuUiLabels,
                clock: any BridgeClock, sink: any BridgeEvidenceSink, maxCommands: Int = 256,
                joinDeadline: TimeInterval = 60, actionDeadline: TimeInterval = 5,
                output: @escaping (Data) throws -> Void) {
        self.driver = driver; self.labels = labels; self.clock = clock; self.sink = sink
        self.output = output; self.maxCommands = maxCommands
        adapter = FeishuClientAdapter(driver: driver, labels: labels, joinDeadline: joinDeadline, actionDeadline: actionDeadline)
        cleanupAdapter = FeishuClientAdapter(driver: driver, labels: labels, actionDeadline: min(actionDeadline, 1))
    }

    public func accept(_ message: BridgeCommandMessage) throws {
        guard !stopped else { throw BridgeProcessError.closed }
        guard BridgeCommandMessage.contractViolation(sessionId: message.sessionId, commandId: message.commandId, command: message.command) == nil else { throw BridgeProcessError.invalidInput }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(message)
        guard bytes.count <= 65_536 else { throw BridgeProcessError.inputTooLarge }
        let digest = Data(SHA256.hash(data: bytes))
        if let owner, owner.session != message.sessionId { throw BridgeProcessError.ownershipConflict }
        if let old = results[message.commandId] {
            guard old.digest == digest else { throw BridgeProcessError.commandConflict }
            try emit(.commandResult(commandId: message.commandId, outcome: old.outcome, detail: old.detail))
            return
        }
        guard !released else { throw BridgeProcessError.closed }
        guard results.count < maxCommands else { throw BridgeProcessError.stateLimit }
        if owner == nil {
            guard case .join(let occurrence, let number, let lease) = message.command,
                  number.utf8.count == 9, number.allSatisfy({ $0.isASCII && $0.isNumber }) else {
                throw BridgeProcessError.ownershipConflict
            }
            owner = (message.sessionId, occurrence, lease)
            recorder = BridgeRecorder(sessionId: message.sessionId, clock: clock, sink: sink, retainRecords: false)
            observer = AccessibilityObserver(labels: labels, identity: UnknownUiIdentity())
            reducer = SessionObservationReducer(sessionId: message.sessionId, identity: UnknownUiIdentity(), chatControl: UnavailableChat())
        }
        guard recorder?.record(command: message) == true else {
            stopped = true; throw BridgeProcessError.evidenceUnavailable
        }
        // Reserve before any side effect. A failure cannot be retried under a new ID.
        results[message.commandId] = (digest, .failed, "command_incomplete")
        var outcome: CommandOutcome = .ok
        var detail: String?
        switch message.command {
        case .join(let occurrence, let number, let lease):
            guard results.count == 1, owner?.occurrence == occurrence, owner?.lease == lease else {
                outcome = .rejected; detail = "session_already_owned"; break
            }
            switch adapter.join(meetingOccurrenceId: occurrence, meetingNo: number) {
            case .joined:
                joined = true
                try emit(.joined(meetingOccurrenceId: occurrence))
            case .failed(let reason): outcome = .failed; detail = reason
            case .rejected(let reason): outcome = .rejected; detail = reason
            }
        case .connectMedia:
            outcome = .failed; detail = "media_adapter_unavailable"
        case .postDisclosure(let text):
            guard joined else { outcome = .rejected; detail = "not_joined"; break }
            if let disclosure = adapter.postDisclosureOnce(text: text) {
                try emit(.chatDisclosure(outcome: disclosure))
                if disclosure != .sent { outcome = .failed; detail = "disclosure_unavailable" }
            } else { outcome = .rejected; detail = "disclosure_already_attempted" }
        case .leave:
            guard joined || adapter.departureUnconfirmed else { outcome = .rejected; detail = "not_joined"; break }
            switch adapter.leave() {
            case .left: joined = false; departureConfirmed = true; try emit(.left(reason: .removed))
            case .failed(let reason): outcome = .failed; detail = reason
            }
        case .releaseLease(let lease):
            guard owner?.lease == lease, !joined, !adapter.departureUnconfirmed || departureConfirmed else { outcome = .rejected; detail = "lease_not_releasable"; break }
            released = true
        }
        results[message.commandId] = (digest, outcome, detail)
        try emit(.commandResult(commandId: message.commandId, outcome: outcome, detail: detail))
    }

    public func pollObservation() throws {
        guard joined, !stopped, let observer, let reducer else { return }
        let tree = driver.snapshot(waitingUpTo: 0) ?? AccessibilityNode(role: "unreadable")
        for observation in observer.observations(from: tree, at: clock.now()) {
            for message in reducer.reduce(observation) {
                try emit(message.event, at: message.observedAt)
                if case .left(let reason) = message.event {
                    joined = false
                    departureConfirmed = reason != .bridgeFailure
                }
            }
        }
    }

    private func emit(_ event: BridgeEvent, at observedAt: String? = nil, publish: Bool = true) throws {
        guard let owner, sequence < Int.max else { throw BridgeProcessError.stateLimit }
        let message = BridgeEventMessage(sessionId: owner.session, sequence: sequence + 1, observedAt: observedAt ?? clock.now(), event: event)
        guard recorder?.record(event: message) == true else { stopped = true; throw BridgeProcessError.evidenceUnavailable }
        sequence += 1
        guard publish else { return }
        if case .left = event {
            // Physical cleanup after bridge_failure remains durable evidence,
            // not a second departure on an already-terminal frozen session.
            guard !leftPublished else { return }
            leftPublished = true
        }
        do { try output(JSONEncoder().encode(message) + Data([10])) }
        catch { stopped = true; throw BridgeProcessError.outputUnavailable }
    }

    public func shutdown(allowUIActions: Bool = true) throws {
        guard !shutdownCompleted else { return }
        shutdownCompleted = true
        stopped = true
        var failure: Error?
        if allowUIActions, let owner, !departureConfirmed, joined || adapter.departureUnconfirmed {
            let command = BridgeCommandMessage(sessionId: owner.session, commandId: "shutdown-" + UUID().uuidString, command: .leave(reason: .coordinatorStop))
            do {
                guard recorder?.record(command: command) == true else { throw BridgeProcessError.evidenceUnavailable }
                switch cleanupAdapter.leave() {
                case .left:
                    joined = false; departureConfirmed = true
                    try emit(.left(reason: .removed))
                    try emit(.commandResult(commandId: command.commandId, outcome: .ok, detail: nil), publish: false)
                case .failed:
                    try emit(.commandResult(commandId: command.commandId, outcome: .failed, detail: "shutdown_departure_unconfirmed"), publish: false)
                    throw BridgeProcessError.closed
                }
            } catch { failure = error }
        }
        do { try sink.close() } catch { failure = failure ?? error }
        if let failure { throw failure }
    }
}

public struct UnknownUiIdentity: UiIdentityResolver {
    public init() {}
    public func identify(uiElementId: String) -> String? { nil }
}
private struct UnavailableChat: ChatControlPort {
    func postDisclosure(text: String) -> DisclosureOutcome { .unavailable }
}

public struct BoundedCommandLines {
    private var bytes = Data()
    private let maxBytes: Int
    public init(maxBytes: Int = 65_536) { self.maxBytes = maxBytes }
    public mutating func append(_ incoming: Data) throws -> [BridgeCommandMessage] {
        guard incoming.count <= maxBytes else { throw BridgeProcessError.inputTooLarge }
        var messages: [BridgeCommandMessage] = []
        for byte in incoming {
            if byte == 10 {
                guard !bytes.isEmpty, String(data: bytes, encoding: .utf8) != nil else { throw BridgeProcessError.invalidInput }
                do { messages.append(try JSONDecoder().decode(BridgeCommandMessage.self, from: bytes)) }
                catch { throw BridgeProcessError.invalidInput }
                bytes.removeAll(keepingCapacity: true)
            } else {
                guard bytes.count < maxBytes else { throw BridgeProcessError.inputTooLarge }
                bytes.append(byte)
            }
        }
        return messages
    }
    public func finish() throws { if !bytes.isEmpty { throw BridgeProcessError.invalidInput } }
}
