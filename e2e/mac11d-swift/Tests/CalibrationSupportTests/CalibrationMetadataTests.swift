import XCTest
import FeishuBridgeSpike
@testable import CalibrationSupport

final class CalibrationMetadataTests: XCTestCase {
    func testMetadataResultHasItsOwnCountersAndCannotAdmitTransportFaultEvidence() throws {
        let source = MetadataFaultClock(source: CoherentCalibrationClock(anchorHost: 1, anchorUnixNs: 10, host: { 2 }), onFault: {})
        let bytes = try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil,
            scenario: .metadataPrimary, metadataFault: source.snapshot)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(object["schema"] as? String, "mac11d-metadata/v1")
        XCTAssertEqual(object["rejectedWallSamples"] as? Int, 0)
        XCTAssertNil(object["heldReads"])
        XCTAssertThrowsError(try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil, scenario: .metadataPrimary))
        XCTAssertThrowsError(try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil, metadataFault: source.snapshot))
    }
    func testRemainingModesRequireOnlyTheirOwnFaultCounters() throws {
        let native = NativeFaultState().snapshot
        let transport = FaultConnectionState().snapshot
        let expiry = ExpiryFaultConnectionState().snapshot
        let nativeBytes = try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil,
            scenario: .nativePrimary, nativeFault: native, nativeConnections: 0)
        let nativeObject = try XCTUnwrap(JSONSerialization.jsonObject(with: nativeBytes) as? [String: Any])
        XCTAssertEqual(nativeObject["schema"] as? String, "mac11d-native/v1")
        XCTAssertNil(nativeObject["clockPairWrites"])
        XCTAssertThrowsError(try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil,
            scenario: .nativePrimary, faults: transport, nativeFault: native, nativeConnections: 0))
        let delayedBytes = try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil,
            scenario: .unconfirmedCleanupWrite, faults: transport, nativeFault: native)
        let delayedObject = try XCTUnwrap(JSONSerialization.jsonObject(with: delayedBytes) as? [String: Any])
        XCTAssertEqual(delayedObject["schema"] as? String, "mac11d-unconfirmed/v1")
        XCTAssertNil(delayedObject["rollbackApplied"])
        XCTAssertThrowsError(try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil,
            scenario: .unconfirmedCleanupWrite, faults: transport))
        let expiryBytes = try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil,
            scenario: .expiryRollback, expiryFault: expiry, rollbackApplied: false)
        let expiryObject = try XCTUnwrap(JSONSerialization.jsonObject(with: expiryBytes) as? [String: Any])
        XCTAssertEqual(expiryObject["schema"] as? String, "mac11d-expiry/v1")
        XCTAssertNil(expiryObject["nativeFailures"])
        XCTAssertThrowsError(try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil,
            scenario: .expiryRollback, expiryFault: expiry))
    }
    func testAbsentTypedStopCannotBePromotedToConfirmedDrain() throws {
        let bytes = try CalibrationMetadata.result(counts: CalibrationCounts(), stop: nil, departure: nil)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(object["schema"] as? String, "mac11d-calibration/v1")
        XCTAssertEqual(object["cleanupConfirmed"] as? Bool, false)
        XCTAssertTrue(object["captureDrain"] is NSNull)
        XCTAssertTrue(object["departureOutcome"] is NSNull)
        XCTAssertEqual(Set(object.keys), ["schema", "type", "captureStarts", "captureStops", "outputStarts", "outputStops", "emittedBuffers", "emittedSamples", "cleanupConfirmed", "captureDrain", "departureOutcome", "departureReason"])
    }
}
