import XCTest
import CoreMedia
@testable import FeishuBridgeSpike

final class SystemAudioCaptureTests: XCTestCase, @unchecked Sendable {
    func testInputDurationBoundAndUnrepresentableLossFailClosed() async throws {
        for discontinuousLoss in [false, true] {
            let backend = SyntheticCaptureBackend(), events = CapturedDeliveries()
            let queue = DispatchQueue(label: "synthetic.capture.duration")
            queue.suspend()
            let capture = SystemAudioCapture(backendFactory: { backend }, processingQueue: queue)
            _ = await capture.start(try captureRequest(), sink: events.accept)
            for offset in [0, 6000, 12000] {
                backend.emit(try syntheticAudio(rate: 48_000, values: [Array(repeating: 0.1, count: 6000)], pts: CMTime(value: Int64(offset), timescale: 48_000)))
            }
            if discontinuousLoss {
                backend.emit(try syntheticAudio(rate: 48_000, pts: CMTime(value: 99_999, timescale: 48_000)))
            }
            queue.resume(); await audioBarrier(queue)
            if discontinuousLoss {
                XCTAssertEqual(capture.failure, .boundsExceeded)
                await waitForAudio { backend.stopCount > 0 }
            } else {
                XCTAssertEqual(events.packets.reduce(0) { $0 + $1.sampleCount }, 6000)
                XCTAssertEqual(events.losses.first?.sourcePTS, CMTime(value: 12000, timescale: 48_000))
                XCTAssertEqual(events.losses.first?.sourceDuration, CMTime(value: 6000, timescale: 48_000))
            }
            _ = await capture.stop()
        }
    }
    func testHungNativeStopIsUnconfirmedAndRepeatedStopDoesNotAccumulateNativeWork() async throws {
        let backend = SyntheticCaptureBackend(); backend.delayStop = true
        let capture = SystemAudioCapture(backendFactory: { backend })
        _ = await capture.start(try captureRequest(budget: 0.01), sink: { _ in .accepted })
        for _ in 0..<3 { let result = await capture.stop(); XCTAssertEqual(result, .failedUnconfirmed) }
        XCTAssertEqual(backend.stopCount, 1)
        backend.completeStop()
        await waitForAudio { capture.state == .stopped }
        XCTAssertEqual(capture.state, .stopped)
    }
    func testSuspendClosesEpochAndRequiresBoundaryBeforeResume() async throws {
        let backend = SyntheticCaptureBackend(), events = CapturedDeliveries()
        let queue = DispatchQueue(label: "synthetic.capture.suspend")
        let capture = SystemAudioCapture(backendFactory: { backend }, processingQueue: queue)
        _ = await capture.start(try captureRequest(), sink: events.accept)
        backend.emit(try syntheticAudio()); await audioBarrier(queue)
        XCTAssertTrue(capture.suspendCapture())
        backend.emit(try syntheticAudio(pts: CMTime(value: 480, timescale: 24_000)))
        await audioBarrier(queue)
        XCTAssertTrue(capture.resumeCapture())
        backend.emit(try syntheticAudio(pts: CMTime(value: 960, timescale: 24_000)))
        await audioBarrier(queue)
        XCTAssertEqual(events.packets.map(\.epoch), [1, 2])
        XCTAssertEqual(events.losses.map(\.reason), [.suspended])
        _ = await capture.stop()
    }
    func testOutputBackpressureRetainsTenPacketsAndOneLossBeforeNewEpoch() async throws {
        let backend = SyntheticCaptureBackend(), events = CapturedDeliveries()
        let queue = DispatchQueue(label: "synthetic.capture.output")
        let capture = SystemAudioCapture(backendFactory: { backend }, clock: IdentityCaptureClock(), processingQueue: queue)
        events.setBlocked(true)
        _ = await capture.start(try captureRequest(), sink: events.accept)
        for index in 0..<11 {
            backend.emit(try syntheticAudio(pts: CMTime(value: Int64(index * 480), timescale: 24_000)))
            await audioBarrier(queue)
        }
        events.setBlocked(false); capture.resumeDelivery(); await audioBarrier(queue)
        XCTAssertEqual(events.packets.count, 10)
        XCTAssertEqual(events.losses.count, 1)
        XCTAssertEqual(events.losses.first?.reason, .outputOverflow)
        XCTAssertEqual(events.losses.first?.outputRange, 4800..<5280)
        backend.emit(try syntheticAudio(pts: CMTime(value: 5280, timescale: 24_000)))
        await audioBarrier(queue)
        XCTAssertEqual(events.packets.last?.epoch, 2)
        _ = await capture.stop()
    }
    func testCancelledDelayedStartCannotConfirmStopOrResurrectCapture() async throws {
        let backend = SyntheticCaptureBackend(); backend.delayStart = true
        let capture = SystemAudioCapture(backendFactory: { backend })
        let start = Task { await capture.start(try captureRequest(budget: 0.04), sink: { _ in .accepted }) }
        await waitForAudio { backend.startCount == 1 }
        let stop = await capture.stop()
        XCTAssertEqual(stop, .failedUnconfirmed, "native start has not resolved yet")
        let outcome = try await start.value
        XCTAssertEqual(outcome, .cancelled)
        backend.completeStart()
        await waitForAudio { backend.stopCount >= 2 }
        XCTAssertGreaterThanOrEqual(backend.stopCount, 2, "late start needs a post-start native stop")
        await waitForAudio { capture.state == .stopped }
        XCTAssertEqual(capture.state, .stopped)
    }

    func testInputQueueOverflowReservesLossAndStartsNewEpoch() async throws {
        let backend = SyntheticCaptureBackend(), events = CapturedDeliveries()
        let queue = DispatchQueue(label: "synthetic.capture.blocked")
        queue.suspend()
        let capture = SystemAudioCapture(backendFactory: { backend }, clock: IdentityCaptureClock(), processingQueue: queue)
        let start = await capture.start(try captureRequest(), sink: events.accept)
        XCTAssertEqual(start, .started)
        for index in 0..<9 { backend.emit(try syntheticAudio(pts: CMTime(value: Int64(index * 480), timescale: 24_000))) }
        queue.resume(); await audioBarrier(queue)
        XCTAssertEqual(events.packets.count, 8)
        XCTAssertEqual(events.losses.filter { $0.reason == .inputOverflow }.count, 1)
        backend.emit(try syntheticAudio(pts: CMTime(value: 4320, timescale: 24_000)))
        await audioBarrier(queue)
        XCTAssertEqual(events.packets.last?.epoch, 2)
        _ = await capture.stop()
    }
    func testLazyCaptureStartsAndStopsOnlyItsInjectedBackend() async throws {
        let backend = SyntheticCaptureBackend()
        let capture = SystemAudioCapture(backendFactory: { backend }, clock: IdentityCaptureClock())
        XCTAssertEqual(backend.startCount, 0)
        XCTAssertThrowsError(try captureRequest(pid: 0))
        let started = await capture.start(try captureRequest(), sink: { _ in .accepted })
        XCTAssertEqual(started, .started)
        XCTAssertEqual(backend.startCount, 1)
        let stopped = await capture.stop()
        XCTAssertEqual(stopped, .stopped)
        XCTAssertEqual(backend.stopCount, 1)
        XCTAssertEqual(capture.state, .stopped)
    }
}

func audioBarrier(_ queue: DispatchQueue) async { await withCheckedContinuation { reply in queue.async { reply.resume() } } }
func waitForAudio(_ condition: @escaping () -> Bool) async {
    for _ in 0..<100 { if condition() { return }; try? await Task.sleep(for: .milliseconds(1)) }
}
final class CapturedDeliveries: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [CaptureDelivery] = []
    private var blocked = false
    func setBlocked(_ value: Bool) { lock.withLock { blocked = value } }
    var packets: [CapturedPcmPacket] { lock.withLock { values.compactMap { if case .packet(let packet) = $0 { packet } else { nil } } } }
    var losses: [CaptureLoss] { lock.withLock { values.compactMap { if case .discontinuity(let loss) = $0 { loss } else { nil } } } }
    func accept(_ event: CaptureDelivery) -> AudioAdmission { lock.withLock { if blocked { return .backpressured }; values.append(event); return .accepted } }
}

func captureRequest(pid: Int32 = 123, budget: TimeInterval = 0.2) throws -> CaptureRequest {
    try CaptureRequest(pid: pid, bundlePath: "/Applications/Synthetic.app", bundleIdentifier: "test.synthetic", build: "1",
        launchDate: Date(timeIntervalSince1970: 1), displayID: 123, startBudget: budget, stopBudget: budget)
}

final class SyntheticCaptureBackend: NativeAudioCaptureBackend, @unchecked Sendable {
    private let lock = NSLock()
    var delayStart = false, delayStop = false
    private var starts = 0, stops = 0
    private var started: (@Sendable (Bool) -> Void)?
    private var stopped: (@Sendable (Bool) -> Void)?
    private var sample: (@Sendable (CMSampleBuffer, CMClock?) -> Void)?
    var startCount: Int { lock.lock(); defer { lock.unlock() }; return starts }
    var stopCount: Int { lock.lock(); defer { lock.unlock() }; return stops }
    func start(request: CaptureRequest, sample: @escaping @Sendable (CMSampleBuffer, CMClock?) -> Void,
               failed: @escaping @Sendable () -> Void, completion: @escaping @Sendable (Bool) -> Void) {
        lock.lock(); starts += 1; self.sample = sample; started = completion; let delayed = delayStart; lock.unlock()
        if !delayed { completion(true) }
    }
    func stop(completion: @escaping @Sendable (Bool) -> Void) {
        lock.lock(); stops += 1; stopped = completion; let delayed = delayStop; lock.unlock()
        if !delayed { completion(true) }
    }
    func completeStart(_ success: Bool = true) { lock.lock(); let callback = started; lock.unlock(); callback?(success) }
    func completeStop(_ success: Bool = true) { lock.lock(); let callback = stopped; lock.unlock(); callback?(success) }
    func emit(_ buffer: CMSampleBuffer) { lock.lock(); let callback = sample; lock.unlock(); callback?(buffer, CMClockGetHostTimeClock()) }
}
