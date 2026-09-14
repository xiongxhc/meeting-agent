import Foundation

public protocol BridgeDeadlineClock {
    func monotonicSeconds() -> TimeInterval
    func pause(seconds: TimeInterval)
}

public struct SystemBridgeClock: BridgeClock, BridgeDeadlineClock {
    public init() {}
    public func now() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = .gmt
        return formatter.string(from: Date())
    }
    public func monotonicSeconds() -> TimeInterval { ProcessInfo.processInfo.systemUptime }
    public func pause(seconds: TimeInterval) { Thread.sleep(forTimeInterval: seconds) }
}

/// Only shared flag: signal/I/O callbacks never mutate the serialized owner.
public final class BridgeCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    public init() {}
    public var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return value }
    public func cancel() { lock.lock(); value = true; lock.unlock() }
    /// Only after the input worker is reaped; permits one bounded cleanup pass.
    public func beginCleanup() { lock.lock(); value = false; lock.unlock() }
}
