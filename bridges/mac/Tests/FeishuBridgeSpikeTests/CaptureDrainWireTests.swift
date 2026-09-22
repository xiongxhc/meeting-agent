import XCTest
@testable import FeishuBridgeSpike

/// D029 §1: `media_disconnected` gains an OPTIONAL `captureDrain` object,
/// present only for a media-v3 lease. These assert the exact bytes, not a
/// semantic round trip: an omitted key and an explicit null are different wire
/// shapes, and a v2 producer's stdout must stay byte-identical to the frozen
/// bridge-session/v1 bytes.
final class CaptureDrainWireTests: XCTestCase {
    private func sortedJson(_ message: BridgeEventMessage) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(message), as: UTF8.self)
    }

    private func event(_ drain: CaptureDrainReport?) -> BridgeEventMessage {
        BridgeEventMessage(sessionId: "bridge-independent", sequence: 7,
            observedAt: "2026-09-22T14:00:00.000Z",
            event: .mediaDisconnected(reason: "media_stopped", captureDrain: drain))
    }

    private static let boundary = CaptureDrainReport.Boundary(
        captureEpoch: 1, lastFrameSequence: 70, outputEndSample: 33600,
        finalClockPairSequence: 18_446_744_073_709_551_615)

    func testConfirmedDrainEncodesExactBytes() throws {
        XCTAssertEqual(try sortedJson(event(.confirmed(Self.boundary))),
            #"{"captureDrain":{"boundary":{"captureEpoch":"1","finalClockPairSequence":"18446744073709551615","lastFrameSequence":"70","outputEndSample":"33600"},"drain":"confirmed","reason":null},"observedAt":"2026-09-22T14:00:00.000Z","reason":"media_stopped","schema":"bridge-session\/v1","sequence":7,"sessionId":"bridge-independent","type":"media_disconnected"}"#)
    }

    func testUnconfirmedDrainEncodesAnExplicitNullBoundaryAndItsReason() throws {
        XCTAssertEqual(try sortedJson(event(.unconfirmed(reason: "drain_not_attempted"))),
            #"{"captureDrain":{"boundary":null,"drain":"unconfirmed","reason":"drain_not_attempted"},"observedAt":"2026-09-22T14:00:00.000Z","reason":"media_stopped","schema":"bridge-session\/v1","sequence":7,"sessionId":"bridge-independent","type":"media_disconnected"}"#)
    }

    func testAMediaV2LeaseOmitsTheKeyEntirely() throws {
        XCTAssertEqual(try sortedJson(event(nil)),
            #"{"observedAt":"2026-09-22T14:00:00.000Z","reason":"media_stopped","schema":"bridge-session\/v1","sequence":7,"sessionId":"bridge-independent","type":"media_disconnected"}"#)
    }

    func testEveryShapeRoundTripsThroughTheV1Decoder() throws {
        for drain: CaptureDrainReport? in [nil, .confirmed(Self.boundary), .unconfirmed(reason: "final_pair_undelivered")] {
            let message = event(drain)
            let bytes = try JSONEncoder().encode(message)
            XCTAssertEqual(try JSONDecoder().decode(BridgeEventMessage.self, from: bytes), message)
        }
    }

    /// The bridge-session/v2 encoder carries the same object: v2 is v1 plus the
    /// ui-derived timing members, and media_disconnected is not ui-derived.
    func testTheV2EncoderCarriesTheSameObject() throws {
        let v2 = try BridgeEventMessageV2.legacy(event(.confirmed(Self.boundary)), timing: nil)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: v2.bytes) as? [String: Any])
        XCTAssertEqual(object["schema"] as? String, bridgeSessionSchemaV2)
        let drain = try XCTUnwrap(object["captureDrain"] as? [String: Any])
        XCTAssertEqual(drain["drain"] as? String, "confirmed")
        XCTAssertTrue(drain["reason"] is NSNull)
        XCTAssertEqual((drain["boundary"] as? [String: Any])?["outputEndSample"] as? String, "33600")
        XCTAssertTrue(try BridgeEventMessageV2.legacy(event(nil), timing: nil).bytes
            .base64EncodedString().count > 0)
        XCTAssertNil(try XCTUnwrap(JSONSerialization.jsonObject(
            with: BridgeEventMessageV2.legacy(event(nil), timing: nil).bytes) as? [String: Any])["captureDrain"])
    }

    /// A confirmed drain with no final capture frame keeps the four members
    /// non-null and spells the absent frame as "0", exactly as the codec's own
    /// zero-frame body does; a real frame sequence is never 0.
    func testAConfirmedZeroFrameBoundarySpellsTheAbsentFrameAsZero() throws {
        let zero = CaptureDrainReport.Boundary(captureEpoch: 4, lastFrameSequence: 0,
            outputEndSample: 0, finalClockPairSequence: 9)
        XCTAssertEqual(try sortedJson(event(.confirmed(zero))),
            #"{"captureDrain":{"boundary":{"captureEpoch":"4","finalClockPairSequence":"9","lastFrameSequence":"0","outputEndSample":"0"},"drain":"confirmed","reason":null},"observedAt":"2026-09-22T14:00:00.000Z","reason":"media_stopped","schema":"bridge-session\/v1","sequence":7,"sessionId":"bridge-independent","type":"media_disconnected"}"#)
        let bytes = try JSONEncoder().encode(event(.confirmed(zero)))
        XCTAssertEqual(try JSONDecoder().decode(BridgeEventMessage.self, from: bytes), event(.confirmed(zero)))
    }

    // MARK: - fail-closed

    func testTheDecoderRefusesEveryMalformedDrain() throws {
        let base: [String: Any] = ["schema": bridgeSessionSchema, "sessionId": "bridge-independent",
            "sequence": 7, "observedAt": "2026-09-22T14:00:00.000Z",
            "type": "media_disconnected", "reason": "media_stopped"]
        let goodBoundary: [String: Any] = ["captureEpoch": "1", "lastFrameSequence": "70",
            "outputEndSample": "33600", "finalClockPairSequence": "2"]
        let rejected: [[String: Any]] = [
            ["drain": "confirmed", "reason": NSNull(), "boundary": NSNull()],
            ["drain": "unconfirmed", "reason": "why", "boundary": goodBoundary],
            ["drain": "unconfirmed", "reason": NSNull(), "boundary": NSNull()],
            ["drain": "confirmed", "reason": "why", "boundary": goodBoundary],
            ["drain": "maybe", "reason": NSNull(), "boundary": goodBoundary],
            ["drain": "confirmed", "boundary": goodBoundary],
            ["drain": "confirmed", "reason": NSNull(), "boundary": goodBoundary, "extra": 1],
            ["drain": "confirmed", "reason": NSNull(), "boundary": goodBoundary.merging(["captureEpoch": "0"]) { _, new in new }],
            ["drain": "confirmed", "reason": NSNull(), "boundary": goodBoundary.merging(["captureEpoch": 1]) { _, new in new }],
            ["drain": "confirmed", "reason": NSNull(), "boundary": goodBoundary.merging(["outputEndSample": "01"]) { _, new in new }],
            ["drain": "confirmed", "reason": NSNull(), "boundary": goodBoundary.merging(["extra": "1"]) { _, new in new }],
            // A half-present frame is not a spelling this contract has.
            ["drain": "confirmed", "reason": NSNull(), "boundary": goodBoundary.merging(["lastFrameSequence": "0"]) { _, new in new }],
            ["drain": "confirmed", "reason": NSNull(), "boundary": goodBoundary.merging(["outputEndSample": "0"]) { _, new in new }],
            ["drain": "confirmed", "reason": NSNull(), "boundary": goodBoundary.merging(["finalClockPairSequence": "0"]) { _, new in new }],
            ["drain": "unconfirmed", "reason": "", "boundary": NSNull()],
        ]
        for drain in rejected {
            let data = try JSONSerialization.data(withJSONObject: base.merging(["captureDrain": drain]) { _, new in new })
            XCTAssertThrowsError(try JSONDecoder().decode(BridgeEventMessage.self, from: data),
                "\(drain) must not decode")
            XCTAssertThrowsError(try BridgeEventMessageV2.decode(try JSONSerialization.data(
                withJSONObject: base.merging(["schema": bridgeSessionSchemaV2, "captureDrain": drain]) { _, new in new })))
        }
    }

    /// Only `media_disconnected` declares the member.
    func testAnotherEventTypeStillRejectsTheKey() throws {
        let data = try JSONSerialization.data(withJSONObject: ["schema": bridgeSessionSchema,
            "sessionId": "bridge-independent", "sequence": 7, "observedAt": "2026-09-22T14:00:00.000Z",
            "type": "media_connected", "endpoint": "tcp://127.0.0.1:1", "captureDrain": NSNull()])
        XCTAssertThrowsError(try JSONDecoder().decode(BridgeEventMessage.self, from: data))
    }
}

/// D029 §1 through the session that actually publishes the event: the terminal
/// `media_disconnected` carries the drain the cycle reported, and a v2 lease
/// publishes the same event without the member.
final class CaptureDrainSessionEventTests: XCTestCase, @unchecked Sendable {
    private func terminalDrain(_ events: [BridgeEvent]) -> CaptureDrainReport?? {
        for event in events.reversed() {
            if case .mediaDisconnected(let reason, let drain) = event,
               reason == "media_stopped" || reason == "media_cleanup_unconfirmed" { return .some(drain) }
        }
        return nil
    }

    func testTheTerminalEventCarriesTheConfirmedBoundaryTheProducerSent() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        capture.emit(try syntheticAudio(rate: 48_000, channels: 1, values: [Array(repeating: 0.25, count: 1926)]))
        await waitForAudio { socket.writes.contains { $0[5] == 2 } }
        let stop = Task { await session.stop() }
        await waitForAudio { socket.writes.contains { $0[5] == 10 } }
        let finish = socket.writes.last!
        var ack = finish; ack[5] = 11; socket.feed(ack)
        _ = await stop.value
        let boundary = try RuntimeMediaCodecV3.decodeCaptureFinishBody(Data(finish.dropFirst(10)))
        let events = await session.takeEvents()
        let drain = try XCTUnwrap(terminalDrain(events))
        XCTAssertEqual(drain, .confirmed(CaptureDrainReport.Boundary(captureEpoch: boundary.captureEpoch,
            lastFrameSequence: boundary.frame?.sequence ?? 0,
            outputEndSample: boundary.frame?.outputEndSample ?? 0,
            finalClockPairSequence: boundary.finalClockPairSequence)))
    }

    func testTheTerminalEventCarriesTheUnconfirmedReasonVerbatim() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        socket.cancel()
        _ = await session.stop()
        let events = await session.takeEvents()
        XCTAssertEqual(try XCTUnwrap(terminalDrain(events)), .unconfirmed(reason: "drain_not_attempted"))
    }

    func testAVersionTwoLeasePublishesTheEventWithoutTheMember() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        capture.emit(try syntheticAudio())
        await waitForAudio { socket.writes.contains { $0[5] == 2 } }
        _ = await session.stop()
        let events = await session.takeEvents()
        XCTAssertEqual(try XCTUnwrap(terminalDrain(events)), CaptureDrainReport?.none)
        for event in events {
            guard case .mediaDisconnected(_, let drain) = event else { continue }
            XCTAssertNil(drain, "a media-v2 lease makes no drain claim on any event")
        }
    }
}
