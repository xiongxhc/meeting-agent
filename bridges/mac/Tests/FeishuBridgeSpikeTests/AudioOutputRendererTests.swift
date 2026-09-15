import XCTest
@testable import FeishuBridgeSpike

final class AudioOutputRendererTests: XCTestCase, @unchecked Sendable {
    func testExpectedGenerationCancelCannotUnscheduleNewAudioAndPlayedIsCallbackOnly() async throws {
        let engine = SyntheticOutputEngine(), delivered = PlayedCallbacks()
        let renderer = AudioOutputRenderer(backendFactory: {
            SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine })
        }, onPlayed: { generation, sequence in delivered.append(generation, sequence) })
        _ = await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.2))
        _ = renderer.enqueue(try playbackPacket(sequence: 1))
        await waitForAudio { engine.scheduledCount == 1 }
        XCTAssertEqual(delivered.count, 0)
        let stale = await renderer.cancel(expectedGeneration: 99)
        XCTAssertEqual(stale, .failedUnconfirmed)
        XCTAssertEqual(engine.cancelCount, 0)
        XCTAssertEqual(renderer.generation, 1)
        engine.completeFirstTwice()
        await waitForAudio { renderer.lastPlayedSequence == 1 && delivered.count == 1 }
        XCTAssertEqual(delivered.values, [[1, 1]])
        let flushed = await renderer.cancel(expectedGeneration: 1)
        XCTAssertEqual(flushed, .stopped)
        XCTAssertEqual(engine.cancelCount, 1)
        XCTAssertTrue(renderer.resume(generation: 2))
        _ = renderer.enqueue(try playbackPacket(generation: 2, sequence: 1))
        engine.completeOld()
        XCTAssertEqual(delivered.values, [[1, 1]])
        _ = await renderer.stop()
    }
    func testDuplicateCompletionReturnsCreditOnlyOnceAndScheduleFailureStops() async throws {
        let engine = SyntheticOutputEngine()
        let renderer = AudioOutputRenderer(backendFactory: {
            SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine })
        })
        _ = await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.1))
        for sequence in 1...4 { _ = renderer.enqueue(try playbackPacket(sequence: UInt64(sequence))) }
        await waitForAudio { engine.scheduledCount == 2 }
        engine.completeFirstTwice()
        await waitForAudio { renderer.lastPlayedSequence == 1 && engine.scheduledCount == 2 }
        XCTAssertEqual(renderer.lastPlayedSequence, 1)
        XCTAssertEqual(engine.scheduledCount, 2)
        engine.setScheduleFailure()
        engine.completeFirst()
        await waitForAudio { engine.stopCount == 1 }
        XCTAssertEqual(renderer.failure, .nativeFailure)
        XCTAssertEqual(engine.scheduledCount, 0)
    }
    func testFailedFlushStillAttemptsEngineStopAndNeverResumes() async throws {
        let engine = SyntheticOutputEngine(); engine.failCancel = true
        let renderer = AudioOutputRenderer(backendFactory: {
            SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine })
        })
        _ = await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.1))
        _ = renderer.enqueue(try playbackPacket(sequence: 1))
        await waitForAudio { engine.scheduledCount == 1 }
        let result = await renderer.cancel()
        XCTAssertEqual(result, .failedUnconfirmed)
        await waitForAudio { engine.stopCount == 1 }
        XCTAssertEqual(engine.stopCount, 1)
        XCTAssertEqual(engine.scheduledCount, 0)
        XCTAssertFalse(renderer.resume(generation: renderer.generation))
    }
    func testUnknownUIDAndReadbackMismatchNeverStartOrFallBack() async throws {
        for unknown in [true, false] {
            let lookup = SyntheticOutputLookup(), engine = SyntheticOutputEngine()
            if unknown { lookup.identifier = 0 } else { engine.wrongReadback = true }
            let renderer = AudioOutputRenderer(backendFactory: {
                SelectedAudioOutputBackend(devices: lookup, engineFactory: { engine })
            })
            let result = await renderer.start(try PlaybackRequest(outputDeviceUID: "only-this-uid", operationBudget: 0.1))
            XCTAssertEqual(result, .failedUnconfirmed)
            XCTAssertEqual(lookup.lookups, ["only-this-uid"])
            XCTAssertEqual(engine.startCount, 0)
            await waitForAudio { unknown || engine.stopCount == 1 }
        }
        XCTAssertThrowsError(try PlaybackRequest(outputDeviceUID: ""))
        XCTAssertThrowsError(try PlaybackRequest(outputDeviceUID: "test", operationBudget: .infinity))
        XCTAssertThrowsError(try PlaybackPcmPacket(generation: 1, sequence: 1, pcm: Data(count: 961)))
    }
    func testOutOfOrderCompletionAndDeviceLossStopWithoutRefilling() async throws {
        for deviceLoss in [false, true] {
            let engine = SyntheticOutputEngine()
            let renderer = AudioOutputRenderer(backendFactory: {
                SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine })
            })
            _ = await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.1))
            for sequence in 1...4 { _ = renderer.enqueue(try playbackPacket(sequence: UInt64(sequence))) }
            await waitForAudio { engine.scheduledCount == 2 }
            if deviceLoss { engine.loseDevice() } else { engine.completeLast() }
            await waitForAudio { engine.stopCount == 1 }
            XCTAssertEqual(renderer.failure, .nativeFailure)
            XCTAssertEqual(renderer.lastPlayedSequence, 0)
            XCTAssertEqual(engine.scheduledCount, 0)
            XCTAssertEqual(renderer.enqueue(try playbackPacket(sequence: 5)), .closed)
        }
    }
    func testHungStopReturnsUnconfirmedAndLateCleanupCannotResume() async throws {
        let engine = SyntheticOutputEngine(), gate = DispatchSemaphore(value: 0)
        engine.stopGate = gate
        let renderer = AudioOutputRenderer(backendFactory: {
            SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine })
        })
        _ = await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.02))
        _ = renderer.enqueue(try playbackPacket(sequence: 1))
        let result = await renderer.stop()
        XCTAssertEqual(result, .failedUnconfirmed)
        XCTAssertEqual(renderer.failure, .ownershipUnconfirmed)
        XCTAssertFalse(renderer.resume(generation: renderer.generation))
        gate.signal()
        await waitForAudio { engine.stopCount == 1 }
        XCTAssertEqual(engine.scheduledCount, 0)
        XCTAssertEqual(renderer.enqueue(try playbackPacket(generation: renderer.generation, sequence: 1)), .closed)
    }
    func testCancelledStartCleansTheLateEngineWithoutResurrection() async throws {
        let engine = SyntheticOutputEngine(), gate = DispatchSemaphore(value: 0)
        engine.startGate = gate
        let renderer = AudioOutputRenderer(backendFactory: {
            SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine })
        })
        let start = Task { await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.1)) }
        await waitForAudio { engine.startCount == 1 }
        start.cancel()
        let result = try await start.value
        XCTAssertEqual(result, .cancelled)
        gate.signal()
        await waitForAudio { engine.stopCount == 1 }
        XCTAssertEqual(engine.stopCount, 1)
        XCTAssertEqual(renderer.enqueue(try playbackPacket(sequence: 1)), .closed)
    }
    func testCancelUnschedulesAndFencesLateCallbacksUntilExplicitResume() async throws {
        let engine = SyntheticOutputEngine()
        let queue = DispatchQueue(label: "synthetic.playback.callbacks")
        let renderer = AudioOutputRenderer(backendFactory: {
            SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine })
        }, ownerQueue: queue)
        _ = await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.2))
        for sequence in 1...4 { _ = renderer.enqueue(try playbackPacket(sequence: UInt64(sequence))) }
        await waitForAudio { engine.scheduledCount == 2 }
        let result = await renderer.cancel()
        XCTAssertEqual(result, .stopped)
        XCTAssertEqual(engine.scheduledCount, 0)
        XCTAssertEqual(engine.cancelCount, 1)
        XCTAssertEqual(renderer.generation, 2)
        engine.completeOld()
        XCTAssertEqual(renderer.enqueue(try playbackPacket(generation: 2, sequence: 1)), .closed)
        XCTAssertFalse(renderer.resume(generation: 1))
        XCTAssertTrue(renderer.resume(generation: 2))
        XCTAssertEqual(renderer.enqueue(try playbackPacket(generation: 1, sequence: 5)), .closed)
        XCTAssertEqual(renderer.enqueue(try playbackPacket(generation: 2, sequence: 1)), .accepted)
        await waitForAudio { engine.scheduledCount > 0 }
        engine.completeOld()
        await audioBarrier(queue)
        XCTAssertEqual(renderer.lastPlayedSequence, 0)
        engine.completeFirst()
        await waitForAudio { renderer.lastPlayedSequence == 1 }
        XCTAssertEqual(renderer.lastPlayedSequence, 1)
        _ = await renderer.stop()
    }
    func testExplicitUIDAndTwoNativeBuffersBoundTheRealPlaybackOwner() async throws {
        let device = SyntheticOutputLookup(), engine = SyntheticOutputEngine()
        let native = SelectedAudioOutputBackend(devices: device, engineFactory: { engine })
        let renderer = AudioOutputRenderer(backendFactory: { native })
        XCTAssertEqual(device.lookups, [])
        let started = await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.1))
        XCTAssertEqual(started, .started)
        XCTAssertEqual(device.lookups, ["synthetic-output"])
        XCTAssertEqual(engine.selectedDevice, 42)
        for sequence in 1...12 { XCTAssertEqual(renderer.enqueue(try playbackPacket(sequence: UInt64(sequence))), .accepted) }
        await waitForAudio { engine.scheduledCount == 2 }
        XCTAssertEqual(engine.scheduledCount, 2)
        XCTAssertEqual(renderer.enqueue(try playbackPacket(sequence: 13)), .backpressured)
        engine.completeFirst()
        await waitForAudio { engine.scheduledCount == 2 && renderer.lastPlayedSequence == 1 }
        XCTAssertEqual(renderer.lastPlayedSequence, 1)
        let stopped = await renderer.stop()
        XCTAssertEqual(stopped, .stopped)
        XCTAssertEqual(engine.scheduledCount, 0)
        XCTAssertEqual(engine.stopCount, 1)
    }
}

private final class PlayedCallbacks: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [[UInt64]] = []
    var count: Int { lock.withLock { stored.count } }
    var values: [[UInt64]] { lock.withLock { stored } }
    func append(_ generation: UInt64, _ sequence: UInt64) { lock.withLock { stored.append([generation, sequence]) } }
}

func playbackPacket(generation: UInt64 = 1, sequence: UInt64) throws -> PlaybackPcmPacket {
    try PlaybackPcmPacket(generation: generation, sequence: sequence, pcm: Data(repeating: 0, count: 960))
}

final class SyntheticOutputLookup: OutputDeviceLookup, @unchecked Sendable {
    private let lock = NSLock()
    var identifier: UInt32 = 42
    private var requests: [String] = []
    var lookups: [String] { lock.withLock { requests } }
    func resolve(uid: String) throws -> UInt32 { lock.withLock { requests.append(uid); return identifier } }
    func usable(_ device: UInt32) -> Bool { device == 42 }
}
final class SyntheticOutputEngine: OutputEngineBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var callbacks: [@Sendable () -> Void] = []
    private var oldCallbacks: [@Sendable () -> Void] = []
    var selectedDevice: UInt32 = 0
    var wrongReadback = false
    var failCancel = false
    private var stops = 0, cancels = 0
    private var starts = 0
    private var scheduleFails = false
    private var failed: (@Sendable () -> Void)?
    var stopGate: DispatchSemaphore?, startGate: DispatchSemaphore?
    var startCount: Int { lock.withLock { starts } }
    var scheduledCount: Int { lock.withLock { callbacks.count } }
    var stopCount: Int { lock.withLock { stops } }
    var cancelCount: Int { lock.withLock { cancels } }
    func selectDevice(_ device: UInt32) throws { selectedDevice = device }
    func currentDevice() throws -> UInt32 { wrongReadback ? 7 : selectedDevice }
    func start(failed: @escaping @Sendable () -> Void) throws {
        lock.withLock { starts += 1; self.failed = failed }; startGate?.wait()
    }
    func schedule(_ pcm: Data, completion: @escaping @Sendable () -> Void) throws {
        try lock.withLock { if scheduleFails { throw AudioPrimitiveError.nativeFailure }; callbacks.append(completion) }
    }
    func setScheduleFailure() { lock.withLock { scheduleFails = true } }
    func cancel() throws {
        if failCancel { throw AudioPrimitiveError.nativeFailure }
        lock.withLock { cancels += 1; oldCallbacks += callbacks; callbacks.removeAll() }
    }
    func stop() throws { stopGate?.wait(); lock.withLock { stops += 1; oldCallbacks += callbacks; callbacks.removeAll() } }
    func completeFirst() { let callback = lock.withLock { callbacks.isEmpty ? nil : callbacks.removeFirst() }; callback?() }
    func completeFirstTwice() { let callback = lock.withLock { callbacks.isEmpty ? nil : callbacks.removeFirst() }; callback?(); callback?() }
    func completeOld() { let callbacks = lock.withLock { oldCallbacks }; callbacks.forEach { $0() } }
    func completeLast() { let callback = lock.withLock { callbacks.popLast() }; callback?() }
    func loseDevice() { lock.withLock { failed }?() }
}
