import Foundation
import Darwin

/// Input lifecycle boundary: the owner must distinguish EOF from failed reaping.
public protocol BridgeInputSource: AnyObject {
    var reachedEOF: Bool { get }
    var failed: Bool { get }
    func start()
    func next(wait: TimeInterval) -> Data?
    func finish(timeout: TimeInterval) -> Bool
}

/// The only worker owns no UI or protocol state. At most sixteen 4 KiB chunks
/// wait for the serialized owner; EOF cancels a pending native wait immediately.
public final class BridgeInputPump: BridgeInputSource, @unchecked Sendable {
    private let fd: Int32
    private let cancellation: BridgeCancellation
    private let condition = NSCondition()
    private var chunks: [Data] = []
    private var done = false
    private var eof = false
    private var readFailed = false
    private var started = false
    public init(fd: Int32, cancellation: BridgeCancellation) { self.fd = fd; self.cancellation = cancellation }
    public var reachedEOF: Bool { condition.lock(); defer { condition.unlock() }; return eof }
    public var failed: Bool { condition.lock(); defer { condition.unlock() }; return readFailed }
    public func start() {
        condition.lock(); guard !started else { condition.unlock(); return }; started = true; condition.unlock()
        Thread.detachNewThread { [self] in readLoop() }
    }
    private func readLoop() {
        defer { condition.lock(); done = true; condition.broadcast(); condition.unlock() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while !cancellation.isCancelled {
            condition.lock()
            while chunks.count >= 16 && !cancellation.isCancelled {
                // Detect a closed writer even when bounded storage is full;
                // otherwise EOF cannot cancel a pending native join wait.
                var state = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                if poll(&state, 1, 0) > 0, state.revents & Int16(POLLHUP | POLLERR | POLLNVAL) != 0 {
                    eof = state.revents & Int16(POLLHUP) != 0
                    readFailed = !eof; cancellation.cancel(); break
                }
                _ = condition.wait(until: Date(timeIntervalSinceNow: 0.05))
            }
            condition.unlock()
            if cancellation.isCancelled { break }
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 50)
            if ready < 0 && errno == EINTR { continue }
            if ready == 0 { continue }
            guard ready > 0, descriptor.revents & Int16(POLLNVAL | POLLERR) == 0 else {
                condition.lock(); readFailed = true; condition.unlock(); cancellation.cancel(); break
            }
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
            if count <= 0 {
                condition.lock(); eof = count == 0; readFailed = count < 0; condition.unlock()
                cancellation.cancel(); break
            }
            condition.lock(); chunks.append(Data(buffer.prefix(count))); condition.broadcast(); condition.unlock()
        }
    }
    public func next(wait: TimeInterval) -> Data? {
        condition.lock(); defer { condition.unlock() }
        let deadline = Date(timeIntervalSinceNow: wait)
        while chunks.isEmpty && !done && !cancellation.isCancelled {
            if !condition.wait(until: deadline) { break }
        }
        guard !chunks.isEmpty else { return nil }
        let data = chunks.removeFirst(); condition.broadcast(); return data
    }
    public func finish(timeout: TimeInterval) -> Bool {
        cancellation.cancel()
        condition.lock(); defer { condition.unlock() }
        condition.broadcast()
        let deadline = Date(timeIntervalSinceNow: timeout)
        while started && !done { if !condition.wait(until: deadline) { return false } }
        chunks.removeAll(); return true
    }
}

/// Production and fake-native tests share this exact serialized lifecycle.
/// EOF discards unissued commands, but still validates buffered framing. The
/// process factory keeps stdin open until results, then leaves/releases or
/// requests cancellation. A new occurrence needs a new process generation.
public func runBridgeControl(process: BridgeProcess, input: any BridgeInputSource,
                             cancellation: BridgeCancellation, clock: any BridgeDeadlineClock,
                             observationInterval: TimeInterval,
                             cleanupFailed: () -> Void = {}) throws {
    input.start()
    var decoder = BoundedCommandLines()
    var failure: Error?
    var nextObservation = clock.monotonicSeconds() + observationInterval
    do {
        while !cancellation.isCancelled {
            if let data = input.next(wait: 0.05) {
                for command in try decoder.append(data) {
                    guard !cancellation.isCancelled else { break }
                    try process.accept(command)
                }
            }
            guard !cancellation.isCancelled else { break }
            if clock.monotonicSeconds() >= nextObservation {
                try process.pollObservation()
                nextObservation = clock.monotonicSeconds() + observationInterval
            }
        }
        if input.reachedEOF {
            while let data = input.next(wait: 0) { _ = try decoder.append(data) }
            try decoder.finish()
        }
        if input.failed { throw BridgeProcessError.invalidInput }
    } catch { failure = error }
    guard input.finish(timeout: 1) else {
        // An unreaped worker must not overlap a fresh UI cleanup attempt. Still
        // close the owner/evidence and make the unconfirmed departure explicit.
        do { try process.shutdown(allowUIActions: false) }
        catch { failure = failure ?? error }
        cleanupFailed()
        throw failure ?? BridgeProcessError.closed
    }
    cancellation.beginCleanup()
    do { try process.shutdown() }
    catch { cleanupFailed(); failure = failure ?? error }
    if let failure { throw failure }
}

/// stdout is nonblocking: a stalled reader cannot pin a UI-owning process.
public final class BridgeOutputWriter {
    private let fd: Int32, oldFlags: Int32
    private let cancellation: BridgeCancellation
    private let deadline: TimeInterval
    public init(fd: Int32, cancellation: BridgeCancellation, deadline: TimeInterval = 1) throws {
        self.fd = fd; self.cancellation = cancellation; self.deadline = deadline
        oldFlags = fcntl(fd, F_GETFL)
        guard oldFlags >= 0, fcntl(fd, F_SETFL, oldFlags | O_NONBLOCK) == 0 else { throw BridgeProcessError.outputUnavailable }
    }
    public func write(_ data: Data) throws {
        guard data.count <= 131_072 else { throw BridgeProcessError.outputUnavailable }
        let end = ProcessInfo.processInfo.systemUptime + deadline
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                guard !cancellation.isCancelled, ProcessInfo.processInfo.systemUptime < end else { throw BridgeProcessError.outputUnavailable }
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count > 0 { offset += count; continue }
                if count < 0 && errno == EINTR { continue }
                guard count < 0, errno == EAGAIN || errno == EWOULDBLOCK else { throw BridgeProcessError.outputUnavailable }
                var descriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                _ = poll(&descriptor, 1, 25)
            }
        }
    }
    deinit { _ = fcntl(fd, F_SETFL, oldFlags) }
}
