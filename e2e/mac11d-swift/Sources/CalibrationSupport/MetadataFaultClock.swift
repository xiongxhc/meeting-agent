import Foundation
import FeishuBridgeSpike

public struct MetadataFaultSnapshot: Encodable, Sendable {
    public var connectionsCreated = 0, metadataInvalidations = 0, rejectedWallSamples = 0
}
public final class MetadataFaultClock: CapturePairClockSource, @unchecked Sendable {
    private let source: any CapturePairClockSource
    private let onFault: @Sendable () throws -> Void
    private let lock = NSLock()
    private var counts = MetadataFaultSnapshot()
    public init(source: any CapturePairClockSource, onFault: @escaping @Sendable () throws -> Void) {
        self.source = source; self.onFault = onFault
    }
    public var snapshot: MetadataFaultSnapshot { lock.withLock { counts } }
    public func connectionCreated() { lock.withLock { counts.connectionsCreated += 1 } }
    public func invalidateMetadata() { lock.withLock { counts.metadataInvalidations = 1 } }
    public func hostNanoseconds() throws -> UInt64 { try source.hostNanoseconds() }
    public func wallSample() throws -> (unixNs: Int64, resolutionNs: UInt64) {
        try lock.withLock {
            guard counts.metadataInvalidations > 0 else { return try source.wallSample() }
            counts.rejectedWallSamples += 1
            if counts.rejectedWallSamples == 1 { try onFault() }
            throw BridgeProcessError.invalidInput
        }
    }
}
