import XCTest
import FeishuBridgeSpike
@testable import CalibrationSupport

final class RollbackAdmissionClockTests: XCTestCase {
    func testRollbackOnlyAfterFixedExpiryCannotMoveFrozenDeadlineOrPairClock() throws {
        let source = CoherentCalibrationClock(anchorHost: 1, anchorUnixNs: 100_000_000_000, host: { 1 })
        let clock = try RollbackAdmissionClock(source: source, expiresAtMs: 100_002)
        let deadline = clock.expiryDeadline
        XCTAssertThrowsError(try clock.rollbackAfterExpiry())
        Thread.sleep(forTimeInterval: 0.01)
        try clock.rollbackAfterExpiry()
        XCTAssertTrue(clock.rollbackApplied)
        XCTAssertEqual(try clock.nowUnixMs(), 40_000)
        XCTAssertEqual(clock.expiryDeadline, deadline)
        XCTAssertEqual(try source.wallSample().unixNs, 100_000_000_000)
    }
    func testExpiredOrUnderflowingAdmissionInputCannotSelectRollbackProof() throws {
        let source = CoherentCalibrationClock(anchorHost: 1, anchorUnixNs: 100_000_000_000, host: { 1 })
        XCTAssertThrowsError(try RollbackAdmissionClock(source: source, expiresAtMs: 100_000))
        let low = CoherentCalibrationClock(anchorHost: 1, anchorUnixNs: 10_000_000_000, host: { 1 })
        XCTAssertThrowsError(try RollbackAdmissionClock(source: low, expiresAtMs: 10_010))
    }
}
