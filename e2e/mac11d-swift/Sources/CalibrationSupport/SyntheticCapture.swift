import Foundation
import CoreMedia
import FeishuBridgeSpike

public final class SyntheticCapture: NativeAudioCaptureBackend, @unchecked Sendable {
    private let queue = DispatchQueue(label: "mac11d.synthetic.capture")
    private let state: CalibrationState
    private let fullBufferCount: Int
    private let barrier: @Sendable (CalibrationBarrier) throws -> Void
    private var active = false
    public init(state: CalibrationState = CalibrationState(), fullBufferCount: Int = 2,
                barrier: @escaping @Sendable (CalibrationBarrier) throws -> Void = { _ in }) {
        self.state = state; self.fullBufferCount = fullBufferCount; self.barrier = barrier
    }
    public func start(request: CaptureRequest, sample: @escaping @Sendable (CMSampleBuffer, CMClock?) -> Void,
                      failed: @escaping @Sendable () -> Void, completion: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            guard !active, (1...180).contains(fullBufferCount) else { completion(false); return }
            active = true
            state.captureStarted()
            do { try barrier(.captureStarted) } catch { active = false; completion(false); return }
            let anchor = CMClockGetTime(CMClockGetHostTimeClock())
            completion(true)
            emit(index: 0, anchor: anchor, sample: sample, failed: failed)
        }
    }
    private func emit(index: Int, anchor: CMTime, sample: @escaping @Sendable (CMSampleBuffer, CMClock?) -> Void,
                      failed: @escaping @Sendable () -> Void) {
        queue.asyncAfter(deadline: .now() + .milliseconds(20)) { [self] in
            guard active else { return }
            let frames = index == fullBufferCount ? 137 : 480
            do {
                let pts = CMTimeAdd(anchor, CMTime(value: Int64(index * 480), timescale: 24_000))
                let buffer = try syntheticSample(frames: frames, pts: pts)
                sample(buffer, CMClockGetHostTimeClock())
                state.emitted(frames: frames)
                if index == fullBufferCount { try barrier(.captureEmissionComplete) }
                else { emit(index: index + 1, anchor: anchor, sample: sample, failed: failed) }
            } catch { failed() }
        }
    }
    public func stop(completion: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            active = false; state.captureStopped()
            do { try barrier(.captureStopped); completion(true) }
            catch { completion(false) }
        }
    }
}
