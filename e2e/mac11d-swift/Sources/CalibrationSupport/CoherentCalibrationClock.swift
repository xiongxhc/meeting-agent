import Foundation
import FeishuBridgeSpike

public struct CoherentCalibrationClock: CapturePairClockSource {
    private let host: @Sendable () throws -> UInt64
    private let anchorHost: UInt64
    private let anchorUnixNs: Int64
    public init(anchorHost: UInt64, anchorUnixNs: Int64, host: @escaping @Sendable () throws -> UInt64) {
        self.host = host; self.anchorHost = anchorHost; self.anchorUnixNs = anchorUnixNs
    }
    public func hostNanoseconds() throws -> UInt64 { try host() }
    public func wallSample() throws -> (unixNs: Int64, resolutionNs: UInt64) {
        let now = try host()
        guard now >= anchorHost, let delta = Int64(exactly: now - anchorHost) else { throw BridgeProcessError.invalidInput }
        let sum = anchorUnixNs.addingReportingOverflow(delta)
        guard !sum.overflow else { throw BridgeProcessError.invalidInput }
        return (sum.partialValue, 1)
    }
}
