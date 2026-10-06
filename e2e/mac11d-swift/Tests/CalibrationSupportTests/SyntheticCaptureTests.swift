import XCTest
import Foundation
import FeishuBridgeSpike
@testable import CalibrationSupport

final class SyntheticCaptureTests: XCTestCase {
    func testExplicitLongFiniteCaptureUsesEveryDeclaredFullBufferBeforePartialTail() async throws {
        let deliveries = Deliveries()
        let complete = expectation(description: "alternate finite capture completed")
        let capture = SystemAudioCapture(backendFactory: {
            SyntheticCapture(fullBufferCount: 3, barrier: { if $0 == .captureEmissionComplete { complete.fulfill() } })
        })
        let request = try CaptureRequest(pid: 123, bundlePath: "/Applications/Synthetic.app", bundleIdentifier: "test.synthetic",
            build: "1", launchDate: Date(timeIntervalSince1970: 1), displayID: 123, startBudget: 0.2, stopBudget: 0.2)
        let started = await capture.start(request, sink: deliveries.accept); XCTAssertEqual(started, .started)
        await fulfillment(of: [complete], timeout: 1)
        let stopped = await capture.stop(); XCTAssertEqual(stopped, .stopped)
        XCTAssertEqual(deliveries.packets.map { $0.sampleCount }, [480, 480, 480, 137])
        XCTAssertEqual(deliveries.packets.map { $0.outputRange.lowerBound }, [0, 480, 960, 1440])
    }
    func testFiniteNativeCallbacksConvertToTwoFullPacketsAndUnpaddedTailOnStop() async throws {
        let deliveries = Deliveries()
        let complete = expectation(description: "finite sample callbacks complete")
        let capture = SystemAudioCapture(backendFactory: {
            SyntheticCapture(barrier: { if $0 == .captureEmissionComplete { complete.fulfill() } })
        })
        let request = try CaptureRequest(pid: 123, bundlePath: "/Applications/Synthetic.app",
            bundleIdentifier: "test.synthetic", build: "1", launchDate: Date(timeIntervalSince1970: 1),
            displayID: 123, startBudget: 0.2, stopBudget: 0.2)
        let started = await capture.start(request, sink: deliveries.accept)
        XCTAssertEqual(started, .started)
        await fulfillment(of: [complete], timeout: 1)
        let stopped = await capture.stop()
        XCTAssertEqual(stopped, .stopped)
        XCTAssertEqual(deliveries.packets.map { $0.pcm.count / 2 }, [480, 480, 137])
        XCTAssertEqual(deliveries.packets.map { $0.outputRange.lowerBound }, [0, 480, 960])
        // Converter support may legitimately be unavailable at initial priming.
        // The copied source timeline must still survive in the actual packets.
        XCTAssertEqual(deliveries.packets.map { $0.sourceSpans.count }, [1, 1, 1])
        XCTAssertTrue(deliveries.packets.flatMap { $0.sourceSpans }.allSatisfy { $0.convertedBufferHostSpan != nil })
    }
}

private final class Deliveries: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [CapturedPcmPacket] = []
    var packets: [CapturedPcmPacket] { lock.withLock { values } }
    func accept(_ delivery: CaptureDelivery) -> AudioAdmission {
        lock.withLock { if case .packet(let packet) = delivery { values.append(packet) } }
        return .accepted
    }
}
