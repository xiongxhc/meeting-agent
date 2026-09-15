import Foundation
import CoreMedia
import Darwin

public struct CaptureClockPair: Sendable {
    public let clockDomainId: String
    public let epoch: UInt64, sequence: UInt64, hostBeforeNs: UInt64, hostAfterNs: UInt64
    public let localUnixNs: Int64
    public let wallResolutionNs: UInt64
    public let externalUtcAccuracyNs: UInt64? = nil
}
public protocol CapturePairClockSource: Sendable {
    func hostNanoseconds() throws -> UInt64
    func wallSample() throws -> (unixNs: Int64, resolutionNs: UInt64)
}
public struct SystemCapturePairClock: CapturePairClockSource {
    public init() {}
    public func hostNanoseconds() throws -> UInt64 {
        let time = CMTimeConvertScale(CMClockGetTime(CMClockGetHostTimeClock()), timescale: 1_000_000_000, method: .roundTowardZero)
        guard time.isNumeric, time.value >= 0 else { throw BridgeProcessError.invalidInput }
        return UInt64(time.value)
    }
    public func wallSample() throws -> (unixNs: Int64, resolutionNs: UInt64) {
        var wall = timespec(), resolution = timespec()
        guard clock_gettime(CLOCK_REALTIME, &wall) == 0, clock_getres(CLOCK_REALTIME, &resolution) == 0,
              wall.tv_sec >= 0, wall.tv_sec <= Int64.max / 1_000_000_000,
              (0..<1_000_000_000).contains(wall.tv_nsec), resolution.tv_sec >= 0,
              resolution.tv_sec <= Int64.max / 1_000_000_000, resolution.tv_nsec >= 0 else { throw BridgeProcessError.invalidInput }
        let unix = Int64(wall.tv_sec * 1_000_000_000).addingReportingOverflow(Int64(wall.tv_nsec))
        let precision = UInt64(resolution.tv_sec * 1_000_000_000).addingReportingOverflow(UInt64(resolution.tv_nsec))
        guard !unix.overflow, !precision.overflow, precision.partialValue > 0 else { throw BridgeProcessError.invalidInput }
        return (unix.partialValue, precision.partialValue)
    }
}

/// One process domain shared by capture and actual AX read brackets. Sampling is
/// serialized, never a receipt-time origin or an assertion of UTC accuracy.
public final class CaptureClockPairSampler: @unchecked Sendable {
    public let clockDomainId: String
    private let source: any CapturePairClockSource
    private let lock = NSLock()
    private var previous: CaptureClockPair?
    public init(clockDomainId: String = UUID().uuidString.lowercased(), source: any CapturePairClockSource = SystemCapturePairClock()) throws {
        guard TimedMediaLease.identifier(clockDomainId) else { throw BridgeProcessError.invalidInput }
        self.clockDomainId = clockDomainId; self.source = source
    }
    public func hostNanoseconds() throws -> UInt64 { try lock.withLock { try source.hostNanoseconds() } }
    public func sample() throws -> CaptureClockPair {
        try lock.withLock {
            let before = try source.hostNanoseconds()
            let wall = try source.wallSample()
            let after = try source.hostNanoseconds()
            guard after >= before, wall.resolutionNs > 0 else { throw BridgeProcessError.invalidInput }
            var epoch: UInt64 = previous?.epoch ?? 1
            let sequence = (previous?.sequence ?? 0).addingReportingOverflow(1)
            guard !sequence.overflow else { throw BridgeProcessError.stateLimit }
            if let previous {
                let midpoint = before + (after - before) / 2
                let oldMidpoint = previous.hostBeforeNs + (previous.hostAfterNs - previous.hostBeforeNs) / 2
                guard before >= previous.hostAfterNs, midpoint > oldMidpoint,
                      let hostDelta = Int64(exactly: midpoint - oldMidpoint) else { throw BridgeProcessError.invalidInput }
                let delta = wall.unixNs.subtractingReportingOverflow(previous.localUnixNs)
                let residual = delta.partialValue.subtractingReportingOverflow(hostDelta)
                if delta.overflow || residual.overflow || residual.partialValue > 10_000_000 || residual.partialValue < -10_000_000 {
                    guard epoch < UInt64.max else { throw BridgeProcessError.stateLimit }; epoch += 1
                }
            }
            let result = CaptureClockPair(clockDomainId: clockDomainId, epoch: epoch, sequence: sequence.partialValue,
                hostBeforeNs: before, hostAfterNs: after, localUnixNs: wall.unixNs, wallResolutionNs: wall.resolutionNs)
            previous = result
            return result
        }
    }
}
