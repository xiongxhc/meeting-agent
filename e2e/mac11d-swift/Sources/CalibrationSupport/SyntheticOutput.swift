import Foundation
import FeishuBridgeSpike

public struct SyntheticOutputLookup: OutputDeviceLookup {
    public init() {}
    public func resolve(uid: String) throws -> UInt32 { 42 }
    public func usable(_ device: UInt32) -> Bool { device == 42 }
}
public final class SyntheticOutput: OutputEngineBackend, @unchecked Sendable {
    // SelectedAudioOutputBackend confines this engine to its native queue.
    private var device: UInt32 = 0
    private let state: CalibrationState
    private let barrier: @Sendable (CalibrationBarrier) throws -> Void
    public init(state: CalibrationState = CalibrationState(), barrier: @escaping @Sendable (CalibrationBarrier) throws -> Void = { _ in }) {
        self.state = state; self.barrier = barrier
    }
    public func selectDevice(_ device: UInt32) throws { self.device = device }
    public func currentDevice() throws -> UInt32 { device }
    public func start(failed: @escaping @Sendable () -> Void) throws { state.outputStarted(); try barrier(.outputStarted) }
    public func schedule(_ pcm: Data, completion: @escaping @Sendable () -> Void) throws { completion() }
    public func cancel() throws {}
    public func stop() throws { state.outputStopped(); try barrier(.outputStopped) }
}
