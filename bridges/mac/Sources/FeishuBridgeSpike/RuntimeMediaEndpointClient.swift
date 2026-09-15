import Foundation
import Network

public enum RuntimeMediaConnectionError: Error { case invalidEndpoint, unavailable, timedOut, closed, busy }
public protocol RuntimeMediaConnection: AnyObject, Sendable {
    func open(deadline: TimeInterval) async throws
    func write(_ data: Data, deadline: TimeInterval) async throws
    func read(maximum: Int, deadline: TimeInterval?) async throws -> Data
    func close() async -> Bool
    func cancel()
}

/// A single lazy connection owner, not an authentication or native-start gate.
/// The session must consume the exact mandatory auth confirmation separately.
public final class RuntimeMediaEndpointClient: RuntimeMediaConnection, @unchecked Sendable {
    private enum State { case idle, connecting, ready, closing, closed }
    private let queue = DispatchQueue(label: "meeting.runtime.media.connection")
    private let host: String, port: UInt16, tls: Bool
    private var connection: NWConnection?
    private var state: State = .idle
    private var opened: CheckedContinuation<Void, Error>?
    private var written: CheckedContinuation<Void, Error>?
    private var received: CheckedContinuation<Data, Error>?
    private var timers: [String: DispatchWorkItem] = [:]
    private var closers: [CheckedContinuation<Bool, Never>] = []
    private var closeConfirmed = false

    public init(endpoint: String) throws {
        guard endpoint.utf8.count <= 2048, let value = URLComponents(string: endpoint),
              ["tcp", "tls"].contains(value.scheme), let host = value.host, !host.isEmpty,
              value.user == nil, value.password == nil, value.path.isEmpty, value.query == nil, value.fragment == nil,
              let port = value.port, (1...65535).contains(port),
              value.scheme == "tls" || ["127.0.0.1", "::1", "[::1]"].contains(host) else { throw RuntimeMediaConnectionError.invalidEndpoint }
        self.host = host.hasPrefix("[") ? String(host.dropFirst().dropLast()) : host
        self.port = UInt16(port); tls = value.scheme == "tls"
    }
    public func open(deadline: TimeInterval) async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                queue.async { [self] in
                    guard state == .idle, valid(deadline) else { continuation.resume(throwing: RuntimeMediaConnectionError.closed); return }
                    state = .connecting; opened = continuation
                    // Normal system TLS/certificate validation; no custom trust,
                    // route, proxy, resolver or fallback is installed.
                    let candidate = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: tls ? .tls : .tcp)
                    connection = candidate
                    candidate.stateUpdateHandler = { [weak self] value in self?.changed(value) }
                    arm("open", deadline: deadline)
                    candidate.start(queue: queue)
                }
            }
        } onCancel: { self.cancel() }
    }
    public func write(_ data: Data, deadline: TimeInterval) async throws {
        guard !data.isEmpty, data.count <= 65_792 else { throw RuntimeMediaConnectionError.unavailable }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                queue.async { [self] in
                    guard state == .ready, valid(deadline), let connection else { continuation.resume(throwing: RuntimeMediaConnectionError.closed); return }
                    guard written == nil else { continuation.resume(throwing: RuntimeMediaConnectionError.busy); return }
                    written = continuation; arm("write", deadline: deadline)
                    connection.send(content: data, completion: .contentProcessed { [weak self] error in
                        guard let self else { return }
                        disarm("write")
                        let callback = written; written = nil
                        if error != nil { callback?.resume(throwing: RuntimeMediaConnectionError.unavailable); beginClose() }
                        else { callback?.resume() }
                    })
                }
            }
        } onCancel: { self.cancel() }
    }
    public func read(maximum: Int, deadline: TimeInterval?) async throws -> Data {
        guard (1...4096).contains(maximum) else { throw RuntimeMediaConnectionError.unavailable }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                queue.async { [self] in
                    guard state == .ready, deadline.map(valid) ?? true, let connection else { continuation.resume(throwing: RuntimeMediaConnectionError.closed); return }
                    guard received == nil else { continuation.resume(throwing: RuntimeMediaConnectionError.busy); return }
                    received = continuation
                    if let deadline { arm("read", deadline: deadline) }
                    connection.receive(minimumIncompleteLength: 1, maximumLength: maximum) { [weak self] data, _, complete, error in
                        guard let self else { return }
                        disarm("read")
                        let callback = received; received = nil
                        if error != nil || (data?.isEmpty != false && !complete) {
                            callback?.resume(throwing: RuntimeMediaConnectionError.unavailable); beginClose()
                        } else { callback?.resume(returning: data ?? Data()) }
                    }
                }
            }
        } onCancel: { self.cancel() }
    }
    public func close() async -> Bool {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                if state == .closed { continuation.resume(returning: closeConfirmed); return }
                guard closers.count < 4 else { continuation.resume(returning: false); return }
                closers.append(continuation); beginClose()
            }
        }
    }
    public func cancel() { queue.async { [weak self] in self?.beginClose() } }
    func hasPendingRead() async -> Bool {
        await withCheckedContinuation { continuation in queue.async { [self] in continuation.resume(returning: received != nil) } }
    }
    private func valid(_ deadline: TimeInterval) -> Bool {
        deadline.isFinite && deadline > ProcessInfo.processInfo.systemUptime && deadline - ProcessInfo.processInfo.systemUptime <= 30
    }
    private func arm(_ name: String, deadline: TimeInterval) {
        let timer = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if name == "open" { opened?.resume(throwing: RuntimeMediaConnectionError.timedOut); opened = nil }
            if name == "write" { written?.resume(throwing: RuntimeMediaConnectionError.timedOut); written = nil }
            if name == "read" { received?.resume(throwing: RuntimeMediaConnectionError.timedOut); received = nil }
            beginClose()
        }
        timers[name]?.cancel(); timers[name] = timer
        queue.asyncAfter(deadline: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime), execute: timer)
    }
    private func disarm(_ name: String) { timers.removeValue(forKey: name)?.cancel() }
    private func changed(_ value: NWConnection.State) {
        switch value {
        case .ready:
            guard state == .connecting else { return }
            state = .ready; disarm("open")
            let callback = opened; opened = nil; callback?.resume()
        case .failed: beginClose()
        case .cancelled: finishClose(confirmed: true)
        default: break
        }
    }
    private func beginClose() {
        guard state != .closed, state != .closing else { return }
        state = .closing
        for timer in timers.values { timer.cancel() }; timers.removeAll()
        opened?.resume(throwing: RuntimeMediaConnectionError.closed); opened = nil
        written?.resume(throwing: RuntimeMediaConnectionError.closed); written = nil
        received?.resume(throwing: RuntimeMediaConnectionError.closed); received = nil
        guard let connection else { finishClose(confirmed: true); return }
        connection.cancel()
        let deadline = DispatchWorkItem { [weak self] in self?.finishClose(confirmed: false) }
        timers["close"] = deadline
        queue.asyncAfter(deadline: .now() + 1, execute: deadline)
    }
    private func finishClose(confirmed: Bool) {
        guard state != .closed else { return }
        state = .closed; closeConfirmed = confirmed
        for timer in timers.values { timer.cancel() }; timers.removeAll()
        connection?.stateUpdateHandler = nil; connection = nil
        let callbacks = closers; closers.removeAll()
        callbacks.forEach { $0.resume(returning: confirmed) }
    }
    deinit { connection?.cancel() }
}
