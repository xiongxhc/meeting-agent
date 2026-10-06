import XCTest
import FeishuBridgeSpike
@testable import CalibrationSupport

final class MetadataFaultClockTests: XCTestCase {
    func testMetadataFailurePreservesHostAndAdmissionSourceAndRejectsEveryLaterPair() throws {
        let base = CoherentCalibrationClock(anchorHost: 100, anchorUnixNs: 1_000, host: { 200 })
        let callbacks = CallbackCount()
        let source = MetadataFaultClock(source: base, onFault: { callbacks.increment() })
        let sampler = try CaptureClockPairSampler(source: source)
        XCTAssertEqual(try sampler.sample().localUnixNs, 1_100)
        source.connectionCreated()
        source.invalidateMetadata()
        source.invalidateMetadata()
        for _ in 0..<2 {
            XCTAssertThrowsError(try source.wallSample()) { error in
                XCTAssertEqual(error as? BridgeProcessError, .invalidInput)
                XCTAssertFalse(error is RuntimeMediaConnectionError)
            }
        }
        XCTAssertEqual(try sampler.hostNanoseconds(), 200)
        XCTAssertEqual(try base.wallSample().unixNs, 1_100)
        XCTAssertEqual(callbacks.count, 1)
        XCTAssertEqual(source.snapshot.connectionsCreated, 1)
        XCTAssertEqual(source.snapshot.metadataInvalidations, 1)
        XCTAssertEqual(source.snapshot.rejectedWallSamples, 2)
    }
    func testUnarmedClockDoesNotTurnControlOnlyRunIntoMediaFaultEvidence() throws {
        let source = MetadataFaultClock(source: CoherentCalibrationClock(anchorHost: 1, anchorUnixNs: 10, host: { 2 }),
            onFault: { XCTFail("unarmed fault") })
        XCTAssertEqual(try source.wallSample().unixNs, 11)
        XCTAssertEqual(source.snapshot.connectionsCreated, 0)
        XCTAssertEqual(source.snapshot.metadataInvalidations, 0)
        XCTAssertEqual(source.snapshot.rejectedWallSamples, 0)
    }
}
private final class CallbackCount: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.withLock { value } }
    func increment() { lock.withLock { value += 1 } }
}
