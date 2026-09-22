import XCTest
@testable import FeishuBridgeSpike

/// Wire authority: the accepted Runtime gateway `media_server.rs`
/// (`decode_capture_finish_body`, `encode_capture_finish_body`,
/// `write_capture_finish_ack`, `packet_target`) and `CaptureFinishBoundary::new`
/// in `crates/model-adapters/src/capture_timing.rs`. Every vector below is the
/// same `(41, 2, present, 7, 960, 3)` / `(41, 1, absent, 3)` pair the Rust unit
/// tests use, copied as data rather than re-derived from prose.
final class RuntimeMediaCodecV3Tests: XCTestCase {
    static let frameBoundaryHex = "0000000000000029000000000000000201000000000000000700000000000003c00000000000000003"
    static let zeroBoundaryHex = "0000000000000029000000000000000100000000000000000000000000000000000000000000000001"

    func testCaptureFinishAndAcknowledgementAreTheExactFiftyOneBytePackets() throws {
        let frame = try CaptureFinishBoundary(session: 41, captureEpoch: 2,
            frame: CaptureFinishBoundary.Frame(sequence: 7, outputEndSample: 960), finalClockPairSequence: 3)
        let zero = try CaptureFinishBoundary(session: 41, captureEpoch: 1, frame: nil, finalClockPairSequence: 1)
        let finish = RuntimeMediaCodecV3.captureFinish(frame)
        XCTAssertEqual(finish.count, 51)
        XCTAssertEqual(finish, fixtureHex("4d454433030a00000029" + Self.frameBoundaryHex))
        XCTAssertEqual(RuntimeMediaCodecV3.captureFinish(zero), fixtureHex("4d454433030a00000029" + Self.zeroBoundaryHex))
        // The acknowledgement echoes the identical body under kind 11.
        XCTAssertEqual(try RuntimeMediaCodecV3.decodeCaptureFinishBody(fixtureHex(Self.frameBoundaryHex)), frame)
        XCTAssertEqual(try RuntimeMediaCodecV3.decodeCaptureFinishBody(fixtureHex(Self.zeroBoundaryHex)), zero)
    }

    func testEveryNoncanonicalBoundarySpellingTheGatewayRejectsIsRefusedHere() {
        // Exactly the Rust rejection set plus the session-zero and
        // trailing-byte spellings its decoder rejects before the constructor.
        let bodies = [
            "0000000000000029000000000000000202000000000000000700000000000003c00000000000000003", // flag 2
            "0000000000000029000000000000000200000000000000000700000000000003c00000000000000003", // absent, nonzero frame
            "0000000000000029000000000000000201000000000000000000000000000003c00000000000000003", // present, zero sequence
            "0000000000000029000000000000000201000000000000000700000000000000000000000000000003", // present, zero output end
            "0000000000000029000000000000000001000000000000000700000000000003c00000000000000003", // epoch 0
            "0000000000000029000000000000000201000000000000000700000000000003c00000000000000000", // pair 0
            "0000000000000000000000000000000201000000000000000700000000000003c00000000000000003", // session 0
            "0000000000000029000000000000000201000000000000000700000000000003c000000000000000",   // 40 bytes
            "0000000000000029000000000000000201000000000000000700000000000003c0000000000000000300", // 42 bytes
        ]
        for body in bodies {
            XCTAssertThrowsError(try RuntimeMediaCodecV3.decodeCaptureFinishBody(fixtureHex(body)), body)
        }
    }

    func testInheritedRecordsKeepTheirExactV2BodyUnderTheV3Envelope() throws {
        let pair = CaptureClockPair(clockDomainId: "d", epoch: 1, sequence: 4, hostBeforeNs: 10,
            hostAfterNs: 20, localUnixNs: 99, wallResolutionNs: 1)
        for media2 in [try RuntimeMediaCodecV2.authentication(session: 41, bridge: "b", token: "t"),
                       try RuntimeMediaCodecV2.epoch(session: 41, bridge: "b", domain: "d", epoch: 2),
                       try RuntimeMediaCodecV2.clockPair(session: 41, pair: pair),
                       try RuntimeMediaCodecV2.discontinuity(session: 41, epoch: 2, reason: 3)] {
            let media3 = try RuntimeMediaCodecV3.envelope(media2)
            XCTAssertEqual(media3.prefix(5), Data([77, 69, 68, 51, 3]))
            XCTAssertEqual(media3.dropFirst(5), media2.dropFirst(5))
            XCTAssertEqual(media3.count, media2.count)
        }
        // A media-1 record and a foreign kind never acquire the v3 envelope.
        XCTAssertThrowsError(try RuntimeMediaCodecV3.envelope(RuntimeMediaCodecV2.acknowledgement(session: 41, sequence: 1, rendered: true)))
        XCTAssertThrowsError(try RuntimeMediaCodecV3.envelope(RuntimeMediaCodecV2.flushAcknowledgement(session: 41, generation: 1)))
        XCTAssertThrowsError(try RuntimeMediaCodecV3.envelope(fixtureHex("4d454432020a00000029" + Self.frameBoundaryHex)))
    }

    func testDecoderAdmitsKindElevenOnlyUnderAnExplicitVersionThreeLease() throws {
        var v3 = RuntimeMediaDecoder(version: 3)
        let accepted = try RuntimeMediaCodecV3.envelope(authAcceptedFixture())
        XCTAssertEqual(try v3.append(accepted), [.authenticated(session: 41, bridge: "bridge-independent")])
        let boundary = try CaptureFinishBoundary(session: 41, captureEpoch: 2,
            frame: CaptureFinishBoundary.Frame(sequence: 7, outputEndSample: 960), finalClockPairSequence: 3)
        XCTAssertEqual(try v3.append(fixtureHex("4d454433030b00000029" + Self.frameBoundaryHex)),
            [.captureFinishAcknowledged(boundary)])
        // Exactly one finish acknowledgement is legal per authenticated connection.
        XCTAssertThrowsError(try v3.append(fixtureHex("4d454433030b00000029" + Self.frameBoundaryHex)))
        // Mixed envelopes fail closed in both directions, and a v2 lease never
        // decodes a capture-finish acknowledgement at all.
        var mixed = RuntimeMediaDecoder(version: 3)
        XCTAssertThrowsError(try mixed.append(try authAcceptedFixture()))
        var v2 = RuntimeMediaDecoder(version: 2)
        XCTAssertThrowsError(try v2.append(fixtureHex("4d454433030b00000029" + Self.frameBoundaryHex)))
        var wrongLength = RuntimeMediaDecoder(version: 3)
        XCTAssertThrowsError(try wrongLength.append(fixtureHex("4d454433030b00000028" + Self.frameBoundaryHex.dropLast(2))))
        var wrongKind = RuntimeMediaDecoder(version: 3)
        XCTAssertThrowsError(try wrongKind.append(fixtureHex("4d454433030a00000029" + Self.frameBoundaryHex)))
    }

    func testFragmentedAcknowledgementIsHeldUntilTheWholePacketArrives() throws {
        var decoder = RuntimeMediaDecoder(version: 3)
        _ = try decoder.append(try RuntimeMediaCodecV3.envelope(authAcceptedFixture()))
        let ack = fixtureHex("4d454433030b00000029" + Self.frameBoundaryHex)
        XCTAssertEqual(try decoder.append(Data(ack.prefix(4))), [])
        XCTAssertEqual(try decoder.append(Data(ack[4..<10])), [])
        XCTAssertEqual(try decoder.append(Data(ack[10..<50])), [])
        XCTAssertTrue(decoder.hasIncompletePacket)
        XCTAssertEqual(try decoder.append(Data(ack.suffix(1))).count, 1)
        XCTAssertFalse(decoder.hasIncompletePacket)
        XCTAssertNoThrow(try decoder.finish())
    }

    func testLeaseAdmitsProtocolThreeOnlyWhenTheServerDeclaredIt() throws {
        for version in [2, 3] {
            let lease = try timedFixtureLease(mediaProtocolVersion: version)
            XCTAssertEqual(lease.mediaProtocolVersion, UInt8(version))
        }
        for rejected in [0, 1, 4, 255] {
            XCTAssertThrowsError(try timedFixtureLease(mediaProtocolVersion: rejected), "\(rejected)")
        }
    }
}
