import Foundation
import FeishuBridgeSpike

/// Private harness counters only; no record bodies or endpoint/lease identifiers.
public struct FaultConnectionSnapshot: Codable, Sendable {
    public var connectionsCreated = 0, openedConnections = 0, captureWrites = 0, clockPairWrites = 0
    public var injectedWriteFailures = 0, heldReads = 0, releasedHeldReads = 0, pendingHeldReads = 0
}

public final class FaultConnectionState: @unchecked Sendable {
    private let lock = NSLock()
    private var counts = FaultConnectionSnapshot()
    private let connectionFactory: @Sendable (String) throws -> any RuntimeMediaConnection
    public init() { connectionFactory = { try RuntimeMediaEndpointClient(endpoint: $0) } }
    // Only wrapper component tests replace the socket. The executable uses the real client above.
    init(connectionFactory: @escaping @Sendable (String) throws -> any RuntimeMediaConnection) {
        self.connectionFactory = connectionFactory
    }
    public var snapshot: FaultConnectionSnapshot { lock.withLock { counts } }
    fileprivate func update(_ change: (inout FaultConnectionSnapshot) -> Void) { lock.withLock { change(&counts) } }
    public func create(endpoint: String, captureReady: @escaping @Sendable () -> Bool,
                       captureProgress: @escaping @Sendable () -> Bool,
                       onFault: @escaping @Sendable () throws -> Void) throws -> any RuntimeMediaConnection {
        let connection = try connectionFactory(endpoint)
        let first = lock.withLock { counts.connectionsCreated += 1; return counts.connectionsCreated == 1 }
        return FaultRuntimeConnection(connection: connection, state: self, first: first,
            captureReady: captureReady, captureProgress: captureProgress, onFault: onFault)
    }
}

/// Test-only decorator. Authentication bytes are always read from the underlying
/// socket before native readiness; later connections forward all traffic.
private final class FaultRuntimeConnection: RuntimeMediaConnection, @unchecked Sendable {
    private let connection: any RuntimeMediaConnection
    private let state: FaultConnectionState
    private let first: Bool
    private let captureReady: @Sendable () -> Bool, captureProgress: @Sendable () -> Bool
    private let onFault: @Sendable () throws -> Void
    private let lock = NSLock()
    private let heldReadExit = DispatchGroup()
    private var pairAttempts = 0
    private var heldUsed = false, cancelled = false
    private var held: CheckedContinuation<Data, Error>?
    private var watchdog: DispatchWorkItem?

    init(connection: any RuntimeMediaConnection, state: FaultConnectionState, first: Bool,
         captureReady: @escaping @Sendable () -> Bool, captureProgress: @escaping @Sendable () -> Bool,
         onFault: @escaping @Sendable () throws -> Void) {
        self.connection = connection; self.state = state; self.first = first
        self.captureReady = captureReady; self.captureProgress = captureProgress; self.onFault = onFault
    }
    func open(deadline: TimeInterval) async throws {
        try await connection.open(deadline: deadline)
        state.update { $0.openedConnections += 1 }
    }
    func write(_ data: Data, deadline: TimeInterval) async throws {
        let kind = timedKind(data)
        let inject = try lock.withLock {
            guard !cancelled else { throw RuntimeMediaConnectionError.closed }
            if kind == 7 { pairAttempts += 1 }
            return first && kind == 7 && pairAttempts == 2 && captureProgress() && held != nil
        }
        if inject {
            state.update { $0.injectedWriteFailures += 1 }
            try onFault()
            // The shipped writer records this primary error before it cancels us.
            throw RuntimeMediaConnectionError.unavailable
        }
        try await connection.write(data, deadline: deadline)
        state.update {
            if kind == 2 { $0.captureWrites += 1 }
            if kind == 7 { $0.clockPairWrites += 1 }
        }
    }
    func read(maximum: Int, deadline: TimeInterval?) async throws -> Data {
        let hold = try lock.withLock {
            guard !cancelled else { throw RuntimeMediaConnectionError.closed }
            guard first && !heldUsed && captureReady() else { return false }
            heldUsed = true; heldReadExit.enter()
            state.update { $0.heldReads += 1; $0.pendingHeldReads += 1 }
            return true
        }
        if !hold { return try await connection.read(maximum: maximum, deadline: deadline) }
        defer {
            state.update { $0.pendingHeldReads -= 1 }
            heldReadExit.leave()
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { reply in
                lock.lock()
                guard !cancelled else {
                    state.update { $0.releasedHeldReads += 1 }
                    lock.unlock(); reply.resume(throwing: RuntimeMediaConnectionError.closed); return
                }
                held = reply
                let now = ProcessInfo.processInfo.systemUptime
                let limit = min(now + 2, deadline.flatMap { $0.isFinite ? $0 : nil } ?? now + 2)
                let timer = DispatchWorkItem { [weak self] in self?.releaseHeld(RuntimeMediaConnectionError.timedOut) }
                watchdog = timer
                DispatchQueue.global().asyncAfter(deadline: .now() + max(0, limit - now), execute: timer)
                lock.unlock()
            }
        } onCancel: { self.cancel() }
    }
    func cancel() {
        lock.withLock { cancelled = true }
        releaseHeld(RuntimeMediaConnectionError.closed)
        connection.cancel()
    }
    func close() async -> Bool {
        cancel()
        let underlyingClosed = await connection.close()
        // Join the held read's method exit, not merely continuation resumption.
        // The group wait uses a bounded worker, never the cooperative caller.
        let joined = await withCheckedContinuation { reply in
            DispatchQueue.global().async { [self] in
                reply.resume(returning: heldReadExit.wait(timeout: .now() + 2) == .success)
            }
        }
        return underlyingClosed && joined
    }
    private func releaseHeld(_ error: Error) {
        let reply = lock.withLock {
            watchdog?.cancel(); watchdog = nil
            let reply = held; held = nil
            if reply != nil { state.update { $0.releasedHeldReads += 1 } }
            return reply
        }
        reply?.resume(throwing: error)
    }
    /// Inspect only the fixed envelope header. A mismatched tag/version or body
    /// length cannot select the fault, and no media body is decoded or retained.
    private func timedKind(_ data: Data) -> UInt8? {
        let header = Array(data.prefix(10))
        guard header.count == 10,
              Array(header.prefix(5)) == [77, 69, 68, 50, 2] || Array(header.prefix(5)) == [77, 69, 68, 51, 3] else { return nil }
        let length = header[6..<10].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard Int(length) == data.count - 10 else { return nil }
        return header[5]
    }
}
