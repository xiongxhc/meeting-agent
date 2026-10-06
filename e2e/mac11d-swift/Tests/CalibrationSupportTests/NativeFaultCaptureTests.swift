import XCTest
import Foundation
import FeishuBridgeSpike
@testable import CalibrationSupport

final class NativeFaultCaptureTests: XCTestCase {
    // Omitting the native failed callback would leave the real wrapper running.
    func testNativePrimaryFailureFollowsFiniteEmissionAndUsesActualFailurePath() async throws {
        let counts = CalibrationState(), faults = NativeFaultState(), deliveries = NativeDeliveries()
        let emitted = expectation(description: "finite native emissions")
        let injected = expectation(description: "native fault callback")
        let failed = expectation(description: "real SystemAudioCapture failure")
        let capture = SystemAudioCapture(backendFactory: {
            NativeFaultCapture(mode: .nativePrimary, state: faults, counts: counts,
                barrier: { if $0 == .captureEmissionComplete { emitted.fulfill() } },
                onFault: {
                    XCTAssertEqual(counts.snapshot.emittedBuffers, 3)
                    XCTAssertEqual(counts.snapshot.emittedSamples, 1_097)
                    injected.fulfill()
                })
        })
        let started = await capture.start(try request(), sink: {
            if case .failed(let error) = $0 {
                XCTAssertEqual(error, .nativeFailure); failed.fulfill()
            }
            return deliveries.accept($0)
        })
        XCTAssertEqual(started, .started)
        await fulfillment(of: [emitted, injected, failed], timeout: 1)
        XCTAssertEqual(capture.failure, .nativeFailure)
        let stopped = await capture.stop()
        XCTAssertEqual(stopped, .failedUnconfirmed)
        XCTAssertEqual(deliveries.frames, [480, 480, 137])
        XCTAssertEqual(faults.snapshot.nativeFailures, 1)
        XCTAssertEqual(faults.snapshot.delayedStops, 0)
        XCTAssertEqual(faults.snapshot.pendingStopCompletions, 0)
        XCTAssertEqual(counts.snapshot.captureStarts, 1)
    }

    // Removing the underlying stop fence would admit the queued second and third buffers.
    func testStopBeforeEmissionCompletionFencesNativeCallbacksAndDoesNotInjectFault() async throws {
        let counts = CalibrationState(), faults = NativeFaultState(), deliveries = NativeDeliveries()
        let stoppedNative = expectation(description: "underlying capture stopped")
        let capture = SystemAudioCapture(backendFactory: {
            NativeFaultCapture(mode: .nativePrimary, state: faults, counts: counts,
                barrier: { if $0 == .captureStopped { stoppedNative.fulfill() } },
                onFault: { XCTFail("fault must not be armed after early stop") })
        })
        let started = await capture.start(try request(), sink: deliveries.accept)
        XCTAssertEqual(started, .started)
        let stopped = await capture.stop()
        XCTAssertEqual(stopped, .stopped)
        await fulfillment(of: [stoppedNative], timeout: 1)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(counts.snapshot.emittedBuffers, 0)
        XCTAssertEqual(deliveries.frames, [])
        XCTAssertEqual(deliveries.failureCount, 0)
        XCTAssertEqual(faults.snapshot.nativeFailures, 0)
        XCTAssertEqual(counts.snapshot.captureStops, 1)
    }

    // Completing inside the received stop budget would incorrectly confirm cleanup.
    func testDelayedStopTimesOutBeforeFiniteLateCompletionWithoutNativeRestart() async throws {
        let counts = CalibrationState(), faults = NativeFaultState(), deliveries = NativeDeliveries()
        let emitted = expectation(description: "finite native emissions")
        let late = expectation(description: "actual late native stop completion")
        let capture = SystemAudioCapture(backendFactory: {
            NativeFaultCapture(mode: .delayedStop, state: faults, counts: counts,
                barrier: { if $0 == .captureEmissionComplete { emitted.fulfill() } },
                onFault: { XCTFail("delayed stop is not native primary failure") }, onLateStop: { late.fulfill() })
        })
        let started = await capture.start(try request(stopBudget: 0.1), sink: deliveries.accept)
        XCTAssertEqual(started, .started)
        await fulfillment(of: [emitted], timeout: 1)
        let begin = ProcessInfo.processInfo.systemUptime
        let stopped = await capture.stop()
        XCTAssertEqual(stopped, .failedUnconfirmed)
        XCTAssertGreaterThanOrEqual(ProcessInfo.processInfo.systemUptime - begin, 0.09)
        XCTAssertEqual(capture.state, .failedUnconfirmed)
        XCTAssertEqual(counts.snapshot.captureStops, 1)
        XCTAssertEqual(faults.snapshot.delayedStops, 1)
        XCTAssertEqual(faults.snapshot.pendingStopCompletions, 1)
        XCTAssertEqual(faults.snapshot.lateStopCompletions, 0)
        await fulfillment(of: [late], timeout: 1)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - begin, 1)
        XCTAssertEqual(faults.snapshot.pendingStopCompletions, 0)
        XCTAssertEqual(faults.snapshot.lateStopCompletions, 1)
        XCTAssertEqual(faults.snapshot.nativeFailures, 0)
        XCTAssertEqual(capture.state, .stopped)
        XCTAssertEqual(capture.failure, nil)
        XCTAssertEqual(deliveries.frames, [480, 480, 137])
        XCTAssertEqual(counts.snapshot.emittedBuffers, 3)
        XCTAssertEqual(counts.snapshot.captureStarts, 1)
        let restarted = await capture.start(try request(), sink: deliveries.accept)
        XCTAssertEqual(restarted, .rejected)
        XCTAssertEqual(counts.snapshot.captureStarts, 1)
    }

    // Letting a telemetry throw bypass failed() would leave the native owner running.
    func testFaultTelemetryFailureStillInvokesNativeFailureExactlyOnce() async throws {
        let counts = CalibrationState(), faults = NativeFaultState()
        let failed = expectation(description: "native failure despite missing telemetry")
        let native = NativeFaultCapture(mode: .nativePrimary, state: faults, counts: counts,
            onFault: { throw BridgeProcessError.invalidInput })
        let captureRequest = try request()
        let started = await withCheckedContinuation { continuation in
            native.start(request: captureRequest, sample: { _, _ in }, failed: { failed.fulfill() },
                completion: { continuation.resume(returning: $0) })
        }
        XCTAssertTrue(started)
        await fulfillment(of: [failed], timeout: 1)
        let stopped = await withCheckedContinuation { continuation in
            native.stop(completion: { continuation.resume(returning: $0) })
        }
        XCTAssertTrue(stopped)
        XCTAssertEqual(faults.snapshot.nativeFailures, 1)
        XCTAssertEqual(counts.snapshot.emittedBuffers, 3)
    }

    // Swallowing telemetry failure or abandoning completion would claim success or leak pending work.
    func testLateStopTelemetryFailureCompletesFalseAndSettlesPendingWork() async throws {
        let counts = CalibrationState(), faults = NativeFaultState()
        let native = NativeFaultCapture(mode: .delayedStop, state: faults, counts: counts,
            onLateStop: { throw BridgeProcessError.invalidInput })
        let captureRequest = try request(stopBudget: 0.1)
        let started = await withCheckedContinuation { continuation in
            native.start(request: captureRequest, sample: { _, _ in }, failed: { XCTFail("unexpected native failure") },
                completion: { continuation.resume(returning: $0) })
        }
        XCTAssertTrue(started)
        let begin = ProcessInfo.processInfo.systemUptime
        let stopped = await withCheckedContinuation { continuation in
            native.stop(completion: { continuation.resume(returning: $0) })
        }
        XCTAssertFalse(stopped)
        XCTAssertGreaterThanOrEqual(ProcessInfo.processInfo.systemUptime - begin, 0.29)
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - begin, 1)
        XCTAssertEqual(faults.snapshot.delayedStops, 1)
        XCTAssertEqual(faults.snapshot.pendingStopCompletions, 0)
        XCTAssertEqual(faults.snapshot.lateStopCompletions, 1)
        XCTAssertEqual(counts.snapshot.captureStops, 1)
    }

    private func request(stopBudget: TimeInterval = 0.2) throws -> CaptureRequest {
        try CaptureRequest(pid: 123, bundlePath: "/Applications/Synthetic.app", bundleIdentifier: "test.synthetic",
            build: "1", launchDate: Date(timeIntervalSince1970: 1), displayID: 123,
            startBudget: 0.2, stopBudget: stopBudget)
    }
}

private final class NativeDeliveries: @unchecked Sendable {
    private let lock = NSLock()
    private var packetFrames: [Int] = [], failures = 0
    var frames: [Int] { lock.withLock { packetFrames } }
    var failureCount: Int { lock.withLock { failures } }
    func accept(_ delivery: CaptureDelivery) -> AudioAdmission {
        lock.withLock {
            switch delivery {
            case .packet(let packet): packetFrames.append(packet.pcm.count / 2)
            case .failed: failures += 1
            case .discontinuity: break
            }
        }
        return .accepted
    }
}
