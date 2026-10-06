import XCTest
import CoreMedia
import FeishuBridgeSpike
@testable import CalibrationSupport

final class SyntheticSampleTests: XCTestCase {
    func testPartialTailSurvivesShippedCopyWithHostSpanAndConstantAmplitude() throws {
        let pts = CMTime(value: 12_000_000_000, timescale: 1_000_000_000)
        let sample = try syntheticSample(frames: 137, pts: pts)
        let copied = try CapturedNativeAudio.copy(sample, sourceClock: CMClockGetHostTimeClock(), clock: IdentityClock())
        XCTAssertEqual(copied.samples, Array(repeating: Float(0.25), count: 137))
        XCTAssertEqual(copied.format.sampleRate, 24_000)
        XCTAssertEqual(copied.hostSpan?.startNs, 12_000_000_000)
        // CMTimeAdd rounds this mixed-timescale sum before directed conversion.
        XCTAssertEqual(copied.hostSpan?.endNs, 12_005_708_333)
        XCTAssertEqual(CMTimeCompare(copied.sourceDuration, CMTime(value: 137, timescale: 24_000)), 0)
    }
    func testInvalidSampleBoundsAreRejectedBeforeAllocation() {
        for frames in [0, -1, 481] { XCTAssertThrowsError(try syntheticSample(frames: frames, pts: .zero)) }
        XCTAssertThrowsError(try syntheticSample(frames: 480, pts: .invalid))
    }
}

private struct IdentityClock: CaptureClockMapping {
    func hostTime(_ sourceTime: CMTime, from sourceClock: CMClock) -> CMTime { sourceTime }
}
