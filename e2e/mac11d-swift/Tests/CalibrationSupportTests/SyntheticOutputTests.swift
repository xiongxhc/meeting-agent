import XCTest
import FeishuBridgeSpike
@testable import CalibrationSupport

final class SyntheticOutputTests: XCTestCase {
    func testShippedRendererStartsAndConfirmsNativeCleanupWithSyntheticDevice() async throws {
        let renderer = AudioOutputRenderer(backendFactory: {
            SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { SyntheticOutput() })
        })
        let start = await renderer.start(try PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.2))
        XCTAssertEqual(start, .started)
        let stop = await renderer.stop()
        XCTAssertEqual(stop, .stopped)
    }
}
