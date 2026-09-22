import XCTest
import CoreMedia
@testable import FeishuBridgeSpike

/// Media v3 is an explicit opt-in on a `mediaProtocolVersion: 3` lease. Every
/// test here drives the real `TimedMediaSession` cleanup path with the scripted
/// loopback connection and asserts the producer contract: one reader, the exact
/// retained boundary, and no local completion without the byte-matching kind 11.
final class TimedMediaSessionV3Tests: XCTestCase, @unchecked Sendable {
    func testDrainConfirmsOnlyAfterNativeDrainFinalPairFinishAndTheExactAcknowledgement() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        capture.emit(try syntheticAudio(rate: 48_000, channels: 1, values: [Array(repeating: 0.25, count: 1926)]))
        await waitForAudio { socket.writes.contains { $0[5] == 2 } }
        let stop = Task { await session.stop() }
        await waitForAudio { socket.writes.contains { $0[5] == 10 } }
        // The renderer and the sole reader are still alive while the finish is
        // outstanding; the native capture tail and final pair already went out.
        XCTAssertEqual(capture.stopCount, 1)
        XCTAssertEqual(engine.stopCount, 0)
        XCTAssertFalse(socket.closed)
        XCTAssertFalse(socket.concurrentRead)
        let kinds = socket.writes.map { $0[5] }
        XCTAssertEqual(Array(kinds.suffix(2)), [7, 10], "final clock pair precedes the finish record")
        XCTAssertEqual(kinds.filter { $0 == 10 }.count, 1)
        XCTAssertLessThan(kinds.lastIndex(of: 2)!, kinds.lastIndex(of: 7)!, "last PCM precedes the final pair")
        let finish = socket.writes.last!
        XCTAssertTrue(socket.writes.allSatisfy { $0.prefix(5) == Data([77, 69, 68, 51, 3]) })
        XCTAssertEqual(finish, expectedFinish(socket.writes), "the boundary is the exact delivered watermark")
        socket.feed(acknowledgement(for: finish))
        let clean = await stop.value; XCTAssertTrue(clean)
        XCTAssertEqual(engine.stopCount, 1); XCTAssertTrue(socket.closed)
        let boundary = try RuntimeMediaCodecV3.decodeCaptureFinishBody(Data(finish.dropFirst(10)))
        let result = await session.stopResult()
        XCTAssertEqual(result?.drain, .confirmed(boundary))
        XCTAssertNotNil(boundary.frame)
        let diagnostics = await session.diagnostics
        XCTAssertTrue(diagnostics.contains("capture_drain_confirmed"))
        XCTAssertFalse(diagnostics.contains("capture_drain_unconfirmed"))
    }

    func testZeroFrameCaptureStillDeclaresEpochAndFinalPairAndIsConfirmable() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        let stop = Task { await session.stop() }
        await waitForAudio { socket.writes.contains { $0[5] == 10 } }
        let finish = socket.writes.last!
        let boundary = try RuntimeMediaCodecV3.decodeCaptureFinishBody(Data(finish.dropFirst(10)))
        XCTAssertNil(boundary.frame)
        XCTAssertEqual(boundary.captureEpoch, 1)
        XCTAssertGreaterThan(boundary.finalClockPairSequence, 0)
        XCTAssertEqual(finish, expectedFinish(socket.writes))
        socket.feed(acknowledgement(for: finish))
        let clean = await stop.value; XCTAssertTrue(clean)
        let result = await session.stopResult()
        XCTAssertEqual(result?.drain, .confirmed(boundary))
    }

    func testAbsentAcknowledgementExpiresOnTheSharedCloseDeadlineWithoutLocalCompletion() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        let begin = ProcessInfo.processInfo.systemUptime
        _ = await session.stop(deadline: begin + 0.8)
        let elapsed = ProcessInfo.processInfo.systemUptime - begin
        XCTAssertLessThan(elapsed, 5, "the ACK wait shares the existing close deadline; it adds none")
        XCTAssertTrue(socket.writes.contains { $0[5] == 10 })
        let result = await session.stopResult()
        XCTAssertEqual(result?.drain, .unconfirmed(reason: "drain_deadline"))
        XCTAssertEqual(result?.cleanupConfirmed, false)
        let diagnostics = await session.diagnostics
        XCTAssertTrue(diagnostics.contains("capture_drain_unconfirmed"))
    }

    func testWrongBoundaryAndMalformedAcknowledgementsBothRefuseToConfirm() async throws {
        for spelling in ["mismatch", "malformed"] {
            let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
            let session = try makeTimedSession(socket, capture, engine, clock)
            socket.feed(try authAcceptedFixtureV3())
            let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
            let stop = Task { await session.stop(deadline: ProcessInfo.processInfo.systemUptime + 4) }
            await waitForAudio { socket.writes.contains { $0[5] == 10 } }
            var ack = acknowledgement(for: socket.writes.last!)
            // One byte of the echoed final pair sequence, then the frame-present
            // flag the gateway can never emit.
            if spelling == "mismatch" { ack[48] ^= 1 } else { ack[26] = 2 }
            socket.feed(ack)
            // The unconfirmed drain is its own fact; it does not veto the
            // separate native-cleanup result.
            let clean = await stop.value; XCTAssertTrue(clean, spelling)
            let result = await session.stopResult()
            XCTAssertEqual(result?.drain,
                .unconfirmed(reason: spelling == "mismatch" ? "drain_ack_mismatch" : "drain_read_failed"), spelling)
        }
    }

    func testEndOfFileAndPeerCancellationBeforeTheAcknowledgementAreUnconfirmed() async throws {
        for eof in [true, false] {
            let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
            let session = try makeTimedSession(socket, capture, engine, clock)
            socket.feed(try authAcceptedFixtureV3())
            let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
            let stop = Task { await session.stop(deadline: ProcessInfo.processInfo.systemUptime + 4) }
            await waitForAudio { socket.writes.contains { $0[5] == 10 } }
            if eof { socket.feed(Data()) } else { socket.cancel() }
            let clean = await stop.value; XCTAssertTrue(clean, "eof \(eof)")
            let result = await session.stopResult()
            XCTAssertEqual(result?.drain, .unconfirmed(reason: "drain_ack_absent"), "eof \(eof)")
        }
    }

    func testNaturalTerminalAndADuplicateAcknowledgementCannotDisturbTheSettledDrain() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        let stop = Task { await session.stop() }
        await waitForAudio { socket.writes.contains { $0[5] == 10 } }
        let finish = socket.writes.last!
        // The producer returns from its sole read loop on the first exact match,
        // so the duplicate and the following terminal are never consumed.
        socket.feed(acknowledgement(for: finish) + acknowledgement(for: finish))
        let clean = await stop.value; XCTAssertTrue(clean)
        XCTAssertFalse(socket.concurrentRead)
        let boundary = try RuntimeMediaCodecV3.decodeCaptureFinishBody(Data(finish.dropFirst(10)))
        let result = await session.stopResult()
        XCTAssertEqual(result?.drain, .confirmed(boundary))
        XCTAssertEqual(socket.unreadBytesAtClose, 51, "the duplicate is left unread: the loop stops at the first match")
    }

    func testPlaybackDecodedAfterTheTransitionIsDiscardedWithoutAnyReceipt() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        let stop = Task { await session.stop() }
        await waitForAudio { socket.writes.contains { $0[5] == 10 } }
        let beforePlayback = socket.writes.count
        socket.feed(playbackBytes(network: 1, generation: 1))
        socket.feed(Data([77, 69, 68, 49, 1, 4]) + RuntimeMediaCodecV2.be(UInt64(41)) + RuntimeMediaCodecV2.be(UInt64(1)))
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(engine.scheduledCount, 0, "no new response audio is admitted while finishing")
        XCTAssertEqual(socket.writes.count, beforePlayback, "no Accepted, Rendered or flush receipt is manufactured")
        socket.feed(acknowledgement(for: socket.writes.last!))
        let clean = await stop.value; XCTAssertTrue(clean)
        XCTAssertFalse(socket.writes.contains { $0[5] == 3 || $0[5] == 5 })
    }

    func testConcurrentStopCallersShareOneCleanupOneFinishAndOneReader() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        let first = Task { await session.stop() }, second = Task { await session.stop() }
        await waitForAudio { socket.writes.contains { $0[5] == 10 } }
        socket.feed(acknowledgement(for: socket.writes.last!))
        let results = [await first.value, await second.value]
        XCTAssertEqual(results, [true, true])
        XCTAssertEqual(socket.writes.filter { $0[5] == 10 }.count, 1)
        XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
        XCTAssertFalse(socket.concurrentRead)
    }

    func testVersionTwoLeaseKeepsTodaysCloseSequenceAndClaimsNoDrain() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        capture.emit(try syntheticAudio())
        await waitForAudio { socket.writes.contains { $0[5] == 2 } }
        let stopped = await session.stop(); XCTAssertTrue(stopped)
        XCTAssertTrue(socket.writes.allSatisfy { $0.prefix(5) == Data([77, 69, 68, 50, 2]) })
        XCTAssertFalse(socket.writes.contains { $0[5] == 10 })
        XCTAssertEqual(socket.writes.last?[5], 7, "the final clock pair stays the last v2 record")
        let result = await session.stopResult()
        XCTAssertEqual(result?.drain, .notApplicable)
        let diagnostics = await session.diagnostics
        XCTAssertFalse(diagnostics.contains { $0.hasPrefix("capture_drain") })
    }

    func testUndeliverableFinalPairNeverSendsAFinishAndNeverClaimsADrain() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixtureV3())
        let started = await session.start(try timedFixtureLease(mediaProtocolVersion: 3)); XCTAssertTrue(started)
        socket.cancel()
        let stopped = await session.stop(); XCTAssertTrue(stopped)
        XCTAssertFalse(socket.writes.contains { $0[5] == 10 })
        let result = await session.stopResult()
        XCTAssertEqual(result?.drain, .unconfirmed(reason: "drain_not_attempted"))
        let diagnostics = await session.diagnostics
        XCTAssertTrue(diagnostics.contains("final_clock_pair_undelivered"))
        XCTAssertTrue(diagnostics.contains("capture_drain_unconfirmed"))
    }

    /// Rebuilds the finish record the producer must have sent from the records
    /// it actually put on the wire, so the assertion checks truthfulness rather
    /// than echoing the producer's own bookkeeping.
    private func expectedFinish(_ writes: [Data]) -> Data {
        let pair = writes.last { $0[5] == 7 }!
        let pairSequence = RuntimeMediaCodecV2.uint(pair, 27 + Int(pair[18]), UInt64.self)
        let epochRecord = writes.last { $0[5] == 6 }!
        var epoch = RuntimeMediaCodecV2.uint(epochRecord, epochRecord.count - 9, UInt64.self)
        var frame: CaptureFinishBoundary.Frame?
        if let last = writes.last(where: { $0[5] == 2 }) {
            epoch = RuntimeMediaCodecV2.uint(last, 29, UInt64.self)
            frame = CaptureFinishBoundary.Frame(sequence: RuntimeMediaCodecV2.uint(last, 37, UInt64.self),
                outputEndSample: RuntimeMediaCodecV2.uint(last, 45, UInt64.self)
                    + UInt64(RuntimeMediaCodecV2.uint(last, 53, UInt32.self)))
        }
        return RuntimeMediaCodecV3.captureFinish(try! CaptureFinishBoundary(session: 41, captureEpoch: epoch,
            frame: frame, finalClockPairSequence: pairSequence))
    }

    private func acknowledgement(for finish: Data) -> Data {
        var ack = finish; ack[5] = 11; return ack
    }
}

func authAcceptedFixtureV3() throws -> Data {
    try RuntimeMediaCodecV3.envelope(authAcceptedFixture())
}
