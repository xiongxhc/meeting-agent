import Foundation
import FeishuBridgeSpike

/// Private harness counters only; no endpoint, credential or media bodies.
public struct ExpiryFaultConnectionSnapshot: Codable, Sendable {
    public var connectionsCreated = 0, openedConnections = 0, captureWrites = 0, clockPairWrites = 0
    public var injectedWriteFailures = 0, expiredCaptureWrites = 0
}

public final class ExpiryFaultConnectionState: @unchecked Sendable {
    private let lock = NSLock()
    private var counts = ExpiryFaultConnectionSnapshot()
    private let connectionFactory: @Sendable (String) throws -> any RuntimeMediaConnection
    public init() { connectionFactory = { try RuntimeMediaEndpointClient(endpoint: $0) } }
    init(connectionFactory: @escaping @Sendable (String) throws -> any RuntimeMediaConnection) {
        self.connectionFactory = connectionFactory
    }
    public var snapshot: ExpiryFaultConnectionSnapshot { lock.withLock { counts } }
    fileprivate func update(_ change: (inout ExpiryFaultConnectionSnapshot) -> Void) { lock.withLock { change(&counts) } }
    public func create(endpoint: String, expiryDeadline: TimeInterval,
                       progress: @escaping @Sendable () -> Bool,
                       onFault: @escaping @Sendable () throws -> Void) throws -> any RuntimeMediaConnection {
        guard expiryDeadline.isFinite, expiryDeadline > 0 else { throw BridgeProcessError.invalidInput }
        let first = try lock.withLock {
            // Later owner admission attempts stay visible even after expiry or a
            // failed factory. The oracle must reject them, not hide them here.
            if counts.connectionsCreated == 0, expiryDeadline <= ProcessInfo.processInfo.systemUptime {
                throw BridgeProcessError.invalidInput
            }
            counts.connectionsCreated += 1
            return counts.connectionsCreated == 1
        }
        return ExpiryFaultConnection(connection: try connectionFactory(endpoint), state: self, first: first,
            expiryDeadline: expiryDeadline, progress: progress, onFault: onFault)
    }
}

/// Test-only decorator over the real endpoint. The immutable cutoff uses real
/// uptime; a rollback of the injected admission wall cannot move this fault.
private final class ExpiryFaultConnection: RuntimeMediaConnection, @unchecked Sendable {
    private let connection: any RuntimeMediaConnection
    private let state: ExpiryFaultConnectionState
    private let first: Bool
    private let expiryDeadline: TimeInterval
    private let progress: @Sendable () -> Bool
    private let onFault: @Sendable () throws -> Void
    private let lock = NSLock()
    private var completedPairs = 0, completedExpiredCaptures = 0
    private var faultUsed = false, cancelled = false

    init(connection: any RuntimeMediaConnection, state: ExpiryFaultConnectionState, first: Bool,
         expiryDeadline: TimeInterval, progress: @escaping @Sendable () -> Bool,
         onFault: @escaping @Sendable () throws -> Void) {
        self.connection = connection; self.state = state; self.first = first
        self.expiryDeadline = expiryDeadline; self.progress = progress; self.onFault = onFault
    }
    func open(deadline: TimeInterval) async throws {
        try await connection.open(deadline: deadline)
        state.update { $0.openedConnections += 1 }
    }
    func write(_ data: Data, deadline: TimeInterval) async throws {
        let kind = timedKind(data)
        let inject = try lock.withLock {
            guard !cancelled else { throw RuntimeMediaConnectionError.closed }
            guard first, !faultUsed, kind == 7, completedPairs > 0,
                  completedExpiredCaptures > 0, ProcessInfo.processInfo.systemUptime >= expiryDeadline,
                  progress() else { return false }
            faultUsed = true
            return true
        }
        if inject {
            state.update { $0.injectedWriteFailures += 1 }
            try onFault()
            // The shipped writer records this primary error before cancellation.
            throw RuntimeMediaConnectionError.unavailable
        }
        try await connection.write(data, deadline: deadline)
        let expired = ProcessInfo.processInfo.systemUptime >= expiryDeadline
        lock.withLock {
            if kind == 7 { completedPairs += 1 }
            if kind == 2, expired { completedExpiredCaptures += 1 }
            state.update {
                if kind == 7 { $0.clockPairWrites += 1 }
                if kind == 2 {
                    $0.captureWrites += 1
                    if expired { $0.expiredCaptureWrites += 1 }
                }
            }
        }
    }
    func read(maximum: Int, deadline: TimeInterval?) async throws -> Data {
        try await connection.read(maximum: maximum, deadline: deadline)
    }
    func cancel() {
        let firstCancel = lock.withLock {
            guard !cancelled else { return false }
            cancelled = true; return true
        }
        if firstCancel { connection.cancel() }
    }
    func close() async -> Bool {
        cancel()
        return await connection.close()
    }
    /// Inspect only the fixed envelope header. All bytes reach the underlying
    /// connection unchanged; malformed headers cannot select/count timed traffic.
    private func timedKind(_ data: Data) -> UInt8? {
        let header = Array(data.prefix(10))
        guard header.count == 10,
              Array(header.prefix(5)) == [77, 69, 68, 50, 2] || Array(header.prefix(5)) == [77, 69, 68, 51, 3] else { return nil }
        let length = header[6..<10].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard Int(length) == data.count - 10 else { return nil }
        return header[5]
    }
}
