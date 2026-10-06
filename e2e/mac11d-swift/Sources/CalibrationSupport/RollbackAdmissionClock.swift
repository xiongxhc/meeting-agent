import Foundation
import FeishuBridgeSpike

public final class RollbackAdmissionClock: @unchecked Sendable {
    private let source: CoherentCalibrationClock
    private let lock = NSLock()
    private var rolledBack = false
    public let expiryDeadline: TimeInterval
    public init(source: CoherentCalibrationClock, expiresAtMs: UInt64) throws {
        let before = ProcessInfo.processInfo.systemUptime
        let wall = try source.wallSample().unixNs
        guard wall >= 60_000_000_000 else { throw BridgeProcessError.invalidInput }
        let milliseconds = UInt64(wall / 1_000_000)
        guard expiresAtMs > milliseconds else { throw BridgeProcessError.invalidInput }
        self.source = source
        expiryDeadline = before + Double(expiresAtMs - milliseconds) / 1_000
        guard expiryDeadline.isFinite else { throw BridgeProcessError.invalidInput }
    }
    public var rollbackApplied: Bool { lock.withLock { rolledBack } }
    public func rollbackAfterExpiry() throws {
        guard ProcessInfo.processInfo.systemUptime >= expiryDeadline else { throw BridgeProcessError.invalidInput }
        lock.withLock { rolledBack = true }
    }
    public func nowUnixMs() throws -> UInt64 {
        let wall = try source.wallSample().unixNs
        guard wall >= 60_000_000_000 else { throw BridgeProcessError.invalidInput }
        let milliseconds = UInt64(wall / 1_000_000)
        return rollbackApplied ? milliseconds - 60_000 : milliseconds
    }
}
