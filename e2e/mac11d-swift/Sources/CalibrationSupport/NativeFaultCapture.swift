import Foundation
import CoreMedia
import FeishuBridgeSpike

public enum NativeFaultMode: Sendable { case nativePrimary, delayedStop }
public struct NativeFaultSnapshot: Encodable, Sendable {
    public var nativeFailures = 0, delayedStops = 0, lateStopCompletions = 0, pendingStopCompletions = 0
}
public final class NativeFaultState: @unchecked Sendable {
    private let lock = NSLock()
    private var counts = NativeFaultSnapshot()
    public init() {}
    public var snapshot: NativeFaultSnapshot { lock.withLock { counts } }
    fileprivate func nativeFailed() -> Bool {
        lock.withLock {
            guard counts.nativeFailures == 0 else { return false }
            counts.nativeFailures += 1; return true
        }
    }
    fileprivate func delayStop() -> Bool {
        lock.withLock {
            guard counts.delayedStops == 0 else { return false }
            counts.delayedStops += 1; counts.pendingStopCompletions += 1; return true
        }
    }
    fileprivate func completeLateStop() {
        lock.withLock { counts.pendingStopCompletions -= 1; counts.lateStopCompletions += 1 }
    }
}

/// Test-only finite native callbacks; never constructs a device backend.
public final class NativeFaultCapture: NativeAudioCaptureBackend, @unchecked Sendable {
    private let queue = DispatchQueue(label: "mac11d.native.fault")
    private let mode: NativeFaultMode
    private let state: NativeFaultState
    private let counts: CalibrationState
    private let barrier: @Sendable (CalibrationBarrier) throws -> Void
    private let onFault: @Sendable () throws -> Void
    private let onLateStop: @Sendable () throws -> Void
    private var capture: SyntheticCapture?
    private var stopRequested = false
    private var stopBudget: TimeInterval = 0
    public init(mode: NativeFaultMode, state: NativeFaultState = NativeFaultState(),
                counts: CalibrationState = CalibrationState(),
                barrier: @escaping @Sendable (CalibrationBarrier) throws -> Void = { _ in },
                onFault: @escaping @Sendable () throws -> Void = {},
                onLateStop: @escaping @Sendable () throws -> Void = {}) {
        self.mode = mode; self.state = state; self.counts = counts; self.barrier = barrier
        self.onFault = onFault; self.onLateStop = onLateStop
    }
    public func start(request: CaptureRequest, sample: @escaping @Sendable (CMSampleBuffer, CMClock?) -> Void,
                      failed: @escaping @Sendable () -> Void, completion: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            guard capture == nil, !stopRequested else { completion(false); return }
            stopBudget = request.stopBudget
            let mode = mode, state = state, barrier = barrier, onFault = onFault
            let native = SyntheticCapture(state: counts, barrier: { event in
                try barrier(event)
                if event == .captureEmissionComplete, mode == .nativePrimary, state.nativeFailed() {
                    // A missing telemetry barrier must still terminate native capture.
                    do { try onFault() } catch { /* no fault evidence may be accepted */ }
                    failed()
                }
            })
            capture = native
            native.start(request: request, sample: sample, failed: failed, completion: completion)
        }
    }
    public func stop(completion: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            stopRequested = true
            guard let capture else { completion(true); return }
            let delay = mode == .delayedStop && state.delayStop()
            let deadline = DispatchTime.now() + stopBudget + 0.2
            capture.stop { [self] success in
                guard delay else { completion(success); return }
                // Fence emissions now; defer only the actual native completion.
                queue.asyncAfter(deadline: deadline) { [self] in
                    state.completeLateStop()
                    do { try onLateStop(); completion(success) }
                    catch { completion(false) }
                }
            }
        }
    }
}
