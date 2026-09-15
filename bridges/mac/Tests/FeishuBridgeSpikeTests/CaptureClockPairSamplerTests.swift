import XCTest
@testable import FeishuBridgeSpike

final class CaptureClockPairSamplerTests: XCTestCase {
    func testReadOrderRetainsRealBracketAndWallStepWithoutInventedAccuracy() throws {
        let source = SyntheticPairClock()
        let sampler = try CaptureClockPairSampler(clockDomainId: "source-process", source: source)
        let first = try sampler.sample()
        XCTAssertEqual(source.calls, ["host", "wall", "host"])
        XCTAssertEqual(first.hostBeforeNs, 900_000_000)
        XCTAssertEqual(first.hostAfterNs, 900_000_000)
        XCTAssertEqual(first.localUnixNs, 2_000_000_000)
        XCTAssertEqual(first.wallResolutionNs, 1)
        XCTAssertNil(first.externalUtcAccuracyNs)
        let metadata = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/runtime-4c97c47/timed-capture-v1/metadata.json")) as! [String: Any]
        XCTAssertEqual(try RuntimeMediaCodecV2.clockPair(session: 41, pair: first), fixtureHex(metadata["clockPairPacketHex"] as! String))
        source.host = 1_900_000_000; source.wall = 1_000_000_000
        let step = try sampler.sample()
        XCTAssertEqual(step.sequence, 2); XCTAssertEqual(step.epoch, 2)
        XCTAssertEqual(step.localUnixNs, 1_000_000_000)
        source.host = 800_000_000
        XCTAssertThrowsError(try sampler.sample())
    }
}

final class SyntheticPairClock: CapturePairClockSource, @unchecked Sendable {
    var calls: [String] = []
    var host: UInt64 = 900_000_000
    var wall: Int64 = 2_000_000_000
    func hostNanoseconds() throws -> UInt64 { calls.append("host"); return host }
    func wallSample() throws -> (unixNs: Int64, resolutionNs: UInt64) { calls.append("wall"); return (wall, 1) }
}
