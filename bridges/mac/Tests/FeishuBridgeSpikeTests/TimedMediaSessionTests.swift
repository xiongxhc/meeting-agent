import XCTest
import CoreMedia
import Darwin
@testable import FeishuBridgeSpike

final class TimedMediaSessionTests: XCTestCase, @unchecked Sendable {
    func testHealthyAuthenticatedTrafficSurvivesCredentialExpiryAndForwardWallStep() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let wall = TimedMutableWall(1_059_800)
        let session = try makeTimedSession(socket, capture, engine, clock, nowUnixMs: { wall.value })
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        wall.value = 9_000_000
        try await Task.sleep(for: .milliseconds(1100))
        socket.feed(playbackBytes(network: 1, generation: 1))
        await waitForAudio { engine.scheduledCount == 1 }
        engine.completeFirst()
        await waitForAudio { socket.writes.contains { $0[5] == 3 && $0[22] == 2 } }
        XCTAssertFalse(socket.closed)
        XCTAssertTrue(socket.writes.contains { $0[5] == 3 && $0[22] == 2 })
        let stopped = await session.stop(); XCTAssertTrue(stopped)
        XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
    }
    func testWallRollbackCannotExtendOriginalReconnectAdmissionCutoff() async throws {
        let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
        sockets.values = [first, second]
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock(), wall = TimedMutableWall(1_059_800)
        let monotonic = TimedAdmissionClock()
        let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() }, nowUnixMs: { wall.value }, nowMonotonic: { monotonic.now })
        first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        wall.value = 1
        monotonic.advance(0.3)
        first.cancel()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(sockets.count, 1, "fresh authentication cannot outlive the initial monotonic cutoff")
        XCTAssertEqual(capture.startCount, 1)
        _ = await session.stop()
    }
    func testLateInitialACKAfterFrozenCutoffCannotStartNativeDespiteWallRollback() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock(), wall = TimedMutableWall(1_059_800)
        let monotonic = TimedAdmissionClock()
        let session = try makeTimedSession(socket, capture, engine, clock, nowUnixMs: { wall.value }, nowMonotonic: { monotonic.now })
        let start = Task { await session.start(try timedFixtureLease()) }
        await waitForAudio { socket.writes.count == 1 }
        wall.value = 1
        monotonic.advance(0.3)
        socket.feed(try authAcceptedFixture())
        let started = try await start.value; XCTAssertFalse(started)
        XCTAssertEqual(capture.startCount, 0); XCTAssertEqual(engine.startCount, 0)
        _ = await session.stop()
    }
    func testWallSamplingTimeConsumesAdmissionBeforeAnyNetworkStep() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let monotonic = TimedAdmissionClock()
        let session = try makeTimedSession(socket, capture, engine, clock,
            nowUnixMs: { monotonic.advance(0.3); return 1_059_800 }, nowMonotonic: { monotonic.now })
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertFalse(started)
        XCTAssertTrue(socket.writes.isEmpty); XCTAssertEqual(engine.startCount, 0); XCTAssertEqual(capture.startCount, 0)
        _ = await session.stop()
    }
    func testNativeCaptureFaultAndConsequentReadCloseNeverReconnect() async throws {
        let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
        sockets.values = [first, second]
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() })
        first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        capture.failNative()
        await waitForAudio { first.closed }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(first.closed); XCTAssertEqual(sockets.count, 1)
        let events = await session.takeEvents(); XCTAssertFalse(events.contains { $0.typeName == "reconnecting" })
        let stopped = await session.stop(); XCTAssertFalse(stopped)
        // The primitive may own its fault-triggered stop before the cycle asks
        // for cleanup; both remain bounded and neither confirms the faulted source.
        XCTAssertTrue((1...2).contains(capture.stopCount)); XCTAssertEqual(engine.stopCount, 1)
    }
    func testInvalidClockOrProtocolDoesNotReconnectAfterConfirmedCleanup() async throws {
        for invalidClock in [true, false] {
            let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
            sockets.values = [first, second]
            let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
            let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() })
            first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture())
            let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
            if invalidClock { clock.invalidate() } else { first.feed(try authAcceptedFixture()) }
            let deadline = ProcessInfo.processInfo.systemUptime + 1.5
            while !first.closed && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(for: .milliseconds(5)) }
            try await Task.sleep(for: .milliseconds(150))
            XCTAssertTrue(first.closed); XCTAssertEqual(sockets.count, 1)
            let stopped = await session.stop(); XCTAssertTrue(stopped)
            XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
        }
    }
    func testTransportWriteFailureCannotReconnectAfterUnconfirmedNativeStop() async throws {
        let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
        sockets.values = [first, second]; first.holdReaderUntilClose = true
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() })
        first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        first.feed(playbackBytes(network: 1, generation: 1))
        await waitForAudio { first.writes.contains { $0[5] == 3 && $0[22] == 1 } }
        capture.delayStop = true; first.failNextWrite(); engine.completeFirst()
        await waitForAudio { first.closed }
        try await Task.sleep(for: .milliseconds(150))
        let stopped = await session.stop(); XCTAssertFalse(stopped)
        XCTAssertEqual(sockets.count, 1)
        capture.completeStop() // Late positive callback cannot resurrect this cycle.
        XCTAssertFalse(first.writes.contains { $0[5] == 3 && $0[22] == 2 })
    }
    func testOneSidedPeriodicPairWriteFailureReconnectsAfterConfirmedCleanup() async throws {
        try await assertOneSidedWriteFailureRecovers(rendered: false)
    }
    func testOneSidedRenderedACKWriteFailureReconnectsAfterConfirmedCleanup() async throws {
        try await assertOneSidedWriteFailureRecovers(rendered: true)
    }
    private func assertOneSidedWriteFailureRecovers(rendered: Bool) async throws {
        let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
        sockets.values = [first, second]; first.holdReaderUntilClose = true
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() })
        first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        if rendered {
            first.feed(playbackBytes(network: 1, generation: 1))
            await waitForAudio { first.writes.contains { $0[5] == 3 && $0[22] == 1 } }
            first.failNextWrite(); engine.completeFirst()
        } else { first.failNextWrite() }
        let deadline = ProcessInfo.processInfo.systemUptime + 1.7
        while capture.startCount < 2 && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(capture.startCount, 2)
        XCTAssertEqual(sockets.count, 2)
        XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
        XCTAssertTrue(first.closed)
        if rendered { XCTAssertFalse(first.writes.contains { $0[5] == 3 && $0[22] == 2 }) }
        let events = await session.takeEvents(); XCTAssertTrue(events.contains(.reconnected(attempt: 1)))
        _ = await session.stop()
    }
    func testWholeMaximumPlaybackIsAcceptedAfterLastAdmissionAndRenderedAfterAll69Callbacks() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        socket.feed(playbackBytes(network: 81, generation: 1, count: 65_536))
        for played in 0..<69 {
            await waitForAudio { engine.scheduledCount > 0 }
            XCTAssertLessThanOrEqual(engine.scheduledCount, 2)
            if played < 50 { XCTAssertFalse(socket.writes.contains { $0[5] == 3 }) }
            XCTAssertFalse(socket.writes.contains { $0[5] == 3 && $0[22] == 2 })
            engine.completeFirst()
            try await Task.sleep(for: .milliseconds(2))
        }
        await waitForAudio { socket.writes.filter { $0[5] == 3 }.count == 2 }
        XCTAssertEqual(socket.writes.filter { $0[5] == 3 }.map { $0[22] }, [1, 2])
        XCTAssertEqual(engine.scheduledCount, 0)
        _ = await session.stop()
    }
    func testFailedNativeFlushHasNoSuccessAcknowledgementAndQuarantinesCleanup() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        engine.failCancel = true
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        socket.feed(playbackBytes(network: 1, generation: 1))
        await waitForAudio { engine.scheduledCount == 1 }
        socket.feed(Data([77,69,68,49,1,4]) + RuntimeMediaCodecV2.be(UInt64(41)) + RuntimeMediaCodecV2.be(UInt64(1)))
        await waitForAudio { socket.closed }
        let stopped = await session.stop(); XCTAssertFalse(stopped)
        XCTAssertFalse(socket.writes.contains { $0[5] == 5 || ($0[5] == 3 && $0[22] == 2) })
        XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
    }
    func testUndeliveredFinalPairIsExplicitWithoutVetoingConfirmedNativeCleanup() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        socket.cancel()
        let stopped = await session.stop(); XCTAssertTrue(stopped)
        let diagnostics = await session.diagnostics
        XCTAssertTrue(diagnostics.contains("capture_delivery_interrupted"))
        XCTAssertTrue(diagnostics.contains("final_clock_pair_undelivered"))
        let events = await session.takeEvents()
        XCTAssertTrue(events.contains(.mediaDisconnected(reason: "final_clock_pair_undelivered")))
        XCTAssertTrue(events.contains(.mediaDisconnected(reason: "capture_delivery_interrupted")))
        XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
    }
    func testRealSocketConfirmationGatesNativeAndReceivesConvertedTailBeforeFinalPair() async throws {
        let peer = try TimedSessionSocketPeer(ack: authAcceptedFixture())
        defer { XCTAssertTrue(peer.finish()) }
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(ScriptedTimedConnection(), capture, engine, clock,
            connections: { try RuntimeMediaEndpointClient(endpoint: $0) })
        let start = Task { await session.start(try timedFixtureLease(endpoint: peer.endpoint)) }
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        while !peer.authenticated && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(peer.authenticated)
        XCTAssertEqual(capture.startCount, 0); XCTAssertEqual(engine.startCount, 0); XCTAssertEqual(clock.calls, 0)
        peer.confirm()
        let started = try await start.value; XCTAssertTrue(started)
        capture.emit(try syntheticAudio(rate: 48_000, values: [Array(repeating: 0.25, count: 1926)]))
        await waitForAudio { peer.records.contains { $0[5] == 2 } }
        let stopped = await session.stop(); XCTAssertTrue(stopped)
        let reaped = peer.wait(); XCTAssertTrue(reaped)
        XCTAssertEqual(peer.records.filter { $0[5] == 2 }.map { RuntimeMediaCodecV2.uint($0, 53, UInt32.self) }, [480, 480, 3])
        XCTAssertEqual(peer.records.first?[5], 6); XCTAssertEqual(peer.records.last?[5], 7)
        XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
    }
    func testLaterHealthyCycleGetsNewOutageWindowButFailedStartupDoesNotRefreshOne() async throws {
        for recover in [true, false] {
            let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), third = ScriptedTimedConnection(), sockets = TimedSocketSequence()
            sockets.values = [first, second, third]
            if !recover { second.openFailureDelay = 0.12 }
            let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
            let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() })
            first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture()); third.feed(try authAcceptedFixture())
            let started = await session.start(try timedFixtureLease(reconnectMs: 250)); XCTAssertTrue(started)
            first.cancel()
            if recover {
                let deadline = ProcessInfo.processInfo.systemUptime + 0.3
                while capture.startCount != 2 && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(for: .milliseconds(5)) }
                XCTAssertEqual(capture.startCount, 2)
                try await Task.sleep(for: .milliseconds(300))
                second.cancel()
                let next = ProcessInfo.processInfo.systemUptime + 0.3
                while capture.startCount != 3 && ProcessInfo.processInfo.systemUptime < next { try await Task.sleep(for: .milliseconds(5)) }
                XCTAssertEqual(capture.startCount, 3)
            } else {
                try await Task.sleep(for: .milliseconds(450))
                XCTAssertEqual(sockets.count, 2, "cleanup and failed startup consume original outage deadline")
                XCTAssertEqual(capture.startCount, 1)
            }
            _ = await session.stop()
        }
    }
    func testReconnectReauthenticatesAfterConfirmedCleanupAndAdvancesCaptureEpoch() async throws {
        let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
        sockets.values = [first, second]
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try TimedMediaSession(clock: CaptureClockPairSampler(clockDomainId: "source-process", source: clock),
            playbackRequest: PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.2),
            captureRequest: { try captureRequest() }, connectionFactory: { _ in try sockets.next() },
            captureFactory: { SystemAudioCapture(backendFactory: { capture }, clock: IdentityCaptureClock()) },
            rendererFactory: { played in AudioOutputRenderer(backendFactory: { SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine }) }, onPlayed: played) },
            nowUnixMs: { 1_000_000 })
        first.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        let initialEvents = await session.takeEvents()
        XCTAssertEqual(initialEvents, [.mediaConnected(endpoint: "tcp://127.0.0.1:9001")])
        first.cancel()
        let deadline = ProcessInfo.processInfo.systemUptime + 0.5
        while second.writes.isEmpty && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(second.writes.count, 1)
        XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
        XCTAssertEqual(capture.startCount, 1); XCTAssertEqual(engine.startCount, 1)
        second.feed(try authAcceptedFixture())
        await waitForAudio { capture.startCount == 2 }
        XCTAssertEqual(capture.startCount, 2)
        let epochs = second.writes.filter { $0[5] == 6 }
        XCTAssertEqual(epochs.count, 1)
        if let epoch = epochs.first { XCTAssertEqual(RuntimeMediaCodecV2.uint(epoch, epoch.count - 9, UInt64.self), 2) }
        XCTAssertTrue(second.writes.contains { $0[5] == 8 && $0.last == 3 })
        let events = await session.takeEvents()
        XCTAssertEqual(events.map(\.typeName), ["media_disconnected", "media_disconnected", "media_disconnected", "reconnecting", "media_connected", "reconnected"])
        XCTAssertTrue(events.contains(.mediaDisconnected(reason: "final_clock_pair_undelivered")))
        let stopped = await session.stop(); XCTAssertTrue(stopped)
        XCTAssertEqual(capture.stopCount, 2); XCTAssertEqual(engine.stopCount, 2); XCTAssertTrue(second.closed)
    }
    func testCallerCancellationDuringAuthenticationCannotStartALateNativeCycle() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        let start = Task { await session.start(try timedFixtureLease()) }
        await waitForAudio { socket.writes.count == 1 }
        start.cancel()
        await waitForAudio { socket.closed }
        XCTAssertTrue(socket.closed)
        socket.feed(try authAcceptedFixture())
        let result = try await start.value; XCTAssertFalse(result)
        XCTAssertEqual(capture.startCount, 0); XCTAssertEqual(engine.startCount, 0); XCTAssertEqual(clock.calls, 0)
        _ = await session.stop()
    }
    func testEOFAfterHeadOfLinePlaybackHeaderCannotStrandPartialAdmission() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        socket.feed(playbackBytes(network: 1, generation: 1, count: 65_536))
        await waitForAudio { engine.scheduledCount == 2 }
        socket.feed(Data(playbackBytes(network: 2, generation: 1).prefix(6)))
        socket.feed(Data()) // Read EOF is behind the paused next-playback header.
        let deadline = ProcessInfo.processInfo.systemUptime + 3.5
        while !socket.closed && ProcessInfo.processInfo.systemUptime < deadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(socket.closed)
        XCTAssertFalse(socket.writes.contains { $0[5] == 3 || $0[5] == 5 })
        _ = await session.stop()
        XCTAssertEqual(engine.stopCount, 1); XCTAssertEqual(capture.stopCount, 1)
    }
    func testOwnerRejectsPhaseBudgetThatCannotFitItsTotalCloseBudgetBeforeNativeStart() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock, nativeBudget: 6)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertFalse(started)
        XCTAssertEqual(engine.startCount, 0); XCTAssertEqual(capture.startCount, 0); XCTAssertEqual(clock.calls, 0)
        _ = await session.stop()
    }
    func testPeriodicClockPairAndNativeFailureCloseOwnedReadLoop() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        let cadenceDeadline = ProcessInfo.processInfo.systemUptime + 1.5
        while socket.writes.filter({ $0[5] == 7 }).count < 2 && ProcessInfo.processInfo.systemUptime < cadenceDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(socket.writes.filter { $0[5] == 7 }.count, 2)
        engine.loseDevice()
        let faultDeadline = ProcessInfo.processInfo.systemUptime + 1.5
        while !socket.closed && ProcessInfo.processInfo.systemUptime < faultDeadline { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(socket.closed)
        let stopped = await session.stop(); XCTAssertFalse(stopped)
        let finalCount = socket.writes.count
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(socket.writes.count, finalCount)
    }
    func testPauseBoundaryAndNewEpochBeforeResumedCapture() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        capture.emit(try syntheticAudio())
        await waitForAudio { socket.writes.contains { $0[5] == 2 } }
        let paused = await session.suspendCapture(); XCTAssertTrue(paused)
        await waitForAudio { socket.writes.contains { $0[5] == 8 } }
        let resumed = await session.resumeCapture(); XCTAssertTrue(resumed)
        capture.emit(try syntheticAudio(pts: CMTime(value: 480, timescale: 24_000)))
        await waitForAudio { socket.writes.filter { $0[5] == 2 }.count == 2 }
        XCTAssertEqual(socket.writes.filter { $0[5] == 8 }.map { $0.last! }, [4])
        XCTAssertEqual(socket.writes.filter { [2,6,8].contains($0[5]) }.map { $0[5] }, [6,2,8,6,2])
        let stopped = await session.stop(); XCTAssertTrue(stopped)
    }
    func testLargePlaybackSplitsWithBoundedNativeAdmissionAndFlushDoesNotWaitForPlayed() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        socket.feed(playbackBytes(network: 1, generation: 1, count: 65_536))
        await waitForAudio { engine.scheduledCount == 2 }
        XCTAssertEqual(engine.scheduledCount, 2)
        XCTAssertFalse(socket.writes.contains { $0[5] == 3 }, "whole network frame is not yet admitted")
        socket.feed(Data([77,69,68,49,1,4]) + RuntimeMediaCodecV2.be(UInt64(41)) + RuntimeMediaCodecV2.be(UInt64(1)))
        await waitForAudio { socket.writes.contains { $0[5] == 5 } }
        XCTAssertEqual(engine.cancelCount, 1)
        XCTAssertTrue(socket.writes.contains { $0[5] == 5 })
        XCTAssertFalse(socket.writes.contains { $0[5] == 3 }, "discarded partial playback never claims Accepted or Rendered")
        let stopped = await session.stop(); XCTAssertTrue(stopped)
    }
    func testPlaybackAckWaitsBehindOwnedCaptureWriteWithoutConcurrentSocketWrites() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        socket.holdNextWrite()
        capture.emit(try syntheticAudio())
        await waitForAudio { socket.hasHeldWrite }
        socket.feed(playbackBytes(network: 1, generation: 1))
        await waitForAudio { engine.scheduledCount == 1 }
        XCTAssertFalse(socket.writes.contains { $0[5] == 3 })
        XCTAssertFalse(socket.concurrentWrite)
        socket.releaseWrite()
        await waitForAudio { socket.writes.contains { $0[5] == 3 } }
        XCTAssertTrue(socket.writes.contains { $0[5] == 3 })
        XCTAssertFalse(socket.concurrentWrite)
        _ = await session.stop()
    }
    func testPlaybackAdmissionThenActualPlayedAndFlushFencesLateCallbacks() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        socket.feed(playbackBytes(network: 17, generation: 9))
        await waitForAudio { socket.writes.contains { $0.count == 23 && $0[5] == 3 } }
        XCTAssertEqual(engine.scheduledCount, 1)
        XCTAssertEqual(socket.writes.filter { $0.count == 23 && $0[5] == 3 }.map { $0[22] }, [1])
        engine.completeFirst()
        await waitForAudio { socket.writes.filter { $0.count == 23 && $0[5] == 3 }.count == 2 }
        XCTAssertEqual(socket.writes.filter { $0.count == 23 && $0[5] == 3 }.map { $0[22] }, [1, 2])
        socket.feed(playbackBytes(network: 18, generation: 9))
        await waitForAudio { engine.scheduledCount == 1 }
        socket.feed(Data([77,69,68,49,1,4]) + RuntimeMediaCodecV2.be(UInt64(41)) + RuntimeMediaCodecV2.be(UInt64(9)))
        await waitForAudio { socket.writes.contains { $0[5] == 5 } }
        XCTAssertEqual(engine.cancelCount, 1)
        XCTAssertTrue(socket.writes.contains { $0 == RuntimeMediaCodecV2.flushAcknowledgement(session: 41, generation: 9) })
        engine.completeOld()
        socket.feed(playbackBytes(network: 19, generation: 10))
        await waitForAudio { engine.scheduledCount == 1 }
        XCTAssertFalse(socket.writes.contains { $0 == RuntimeMediaCodecV2.acknowledgement(session: 41, sequence: 18, rendered: true) })
        XCTAssertFalse(socket.writes.contains { $0 == RuntimeMediaCodecV2.acknowledgement(session: 41, sequence: 19, rendered: true) })
        _ = await session.stop()
    }
    func testActualConvertedCaptureAndShortTailPrecedeFinalPair() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        socket.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        capture.emit(try syntheticAudio(rate: 48_000, channels: 1, values: [Array(repeating: 0.25, count: 1926)]))
        await waitForAudio { socket.writes.contains { $0[5] == 2 } }
        let stopped = await session.stop(); XCTAssertTrue(stopped)
        let frames = socket.writes.filter { $0[5] == 2 }
        XCTAssertEqual(frames.map { RuntimeMediaCodecV2.uint($0, 53, UInt32.self) }, [480, 480, 3])
        XCTAssertEqual(socket.writes.last?[5], 7)
        XCTAssertTrue(socket.closed)
    }
    func testExactRemoteConfirmationPrecedesEveryNativeAndClockStart() async throws {
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(socket, capture, engine, clock)
        let start = Task { await session.start(try timedFixtureLease()) }
        await waitForAudio { socket.writes.count == 1 }
        XCTAssertEqual(capture.startCount, 0); XCTAssertEqual(engine.startCount, 0); XCTAssertEqual(clock.calls, 0)
        try socket.feed(authAcceptedFixture())
        let started = try await start.value; XCTAssertTrue(started)
        XCTAssertEqual(capture.startCount, 1); XCTAssertEqual(engine.startCount, 1)
        XCTAssertEqual(socket.writes.prefix(3).map { $0[5] }, [1, 6, 7])
        let stopped = await session.stop(); XCTAssertTrue(stopped)
        XCTAssertEqual(capture.stopCount, 1); XCTAssertEqual(engine.stopCount, 1)
        XCTAssertTrue(socket.closed)
        XCTAssertEqual(socket.writes.last?[5], 7, "final clock pair follows drained capture")
    }
    func testWrongConfirmationAndCloseDuringHandshakeNeverStartResources() async throws {
        for wrong in [true, false] {
            let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
            let session = try makeTimedSession(socket, capture, engine, clock)
            let start = Task { await session.start(try timedFixtureLease()) }
            await waitForAudio { socket.writes.count == 1 }
            if wrong {
                var bytes = try authAcceptedFixture(); bytes[17] = 42; socket.feed(bytes)
            } else { _ = await session.stop() }
            let result = try await start.value; XCTAssertFalse(result)
            XCTAssertEqual(capture.startCount, 0); XCTAssertEqual(engine.startCount, 0); XCTAssertEqual(clock.calls, 0)
            XCTAssertTrue(socket.closed)
            _ = await session.stop()
        }
    }
}

final class TimedSocketSequence: @unchecked Sendable {
    private let lock = NSLock()
    var values: [ScriptedTimedConnection] = []
    private var index = 0
    var count: Int { lock.withLock { index } }
    func next() throws -> any RuntimeMediaConnection {
        try lock.withLock {
            guard index < values.count else { throw RuntimeMediaConnectionError.unavailable }
            defer { index += 1 }; return values[index]
        }
    }
}

func playbackBytes(network: UInt64, generation: UInt64, count: Int = 960) -> Data {
    var bytes = Data([77,69,68,49,1,2,2])
    for value: UInt64 in [41, network, 1, generation, 1, network] { bytes += RuntimeMediaCodecV2.be(value) }
    return bytes + Data([1]) + RuntimeMediaCodecV2.be(UInt32(24_000)) + RuntimeMediaCodecV2.be(UInt16(1)) + RuntimeMediaCodecV2.be(UInt32(count)) + Data(count: count)
}

func timedFixtureLease(reconnectMs: UInt64? = nil, endpoint: String? = nil) throws -> TimedMediaLease {
    let object = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/contracts/bridge-session-v2.json")) as! [String: Any]
    let media = (object["commands"] as! [[String: Any]])[1]
    var lease = media["mediaLease"] as! [String: Any]
    if let reconnectMs { lease["reconnectWindowMs"] = String(reconnectMs) }
    if let endpoint { lease["connectEndpoint"] = endpoint }
    return try TimedMediaLease(lease, bridgeSessionId: "bridge-independent")
}

/// Bounded actual TCP peer: complete auth before fragmented confirmation, then
/// retain at most16 bounded MED2 records until EOF. No native/public endpoint.
final class TimedSessionSocketPeer: @unchecked Sendable {
    let endpoint: String
    private let listener: Int32
    private let lock = NSLock(), ready = DispatchSemaphore(value: 0), done = DispatchGroup()
    private var client: Int32 = -1, accepted = false, packets: [Data] = []
    var authenticated: Bool { lock.withLock { accepted } }
    var records: [Data] { lock.withLock { packets } }
    init(ack: Data) throws {
        listener = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard listener >= 0 else { throw TestFailure.failed }
        let listening = listener
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listening, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0, Darwin.listen(listener, 1) == 0 else { Darwin.close(listener); throw TestFailure.failed }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listening, $0, &length) } }
        endpoint = "tcp://127.0.0.1:\(UInt16(bigEndian: address.sin_port))"
        done.enter()
        Thread.detachNewThread { [self] in
            defer { done.leave() }
            let deadline = ProcessInfo.processInfo.systemUptime + 5
            guard pollReady(listener, deadline: deadline) else { return }
            let fd = accept(listener, nil, nil)
            guard fd >= 0 else { return }
            var one: Int32 = 1
            _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            lock.withLock { client = fd }
            defer { lock.withLock { client = -1; Darwin.close(fd) } }
            // Independently hand-written source41 / fixture-token / bridge-independent.
            let expected = fixtureHex("4d45443202010000002900000000000000290d666978747572652d746f6b656e126272696467652d696e646570656e64656e74")
            guard readPacket(fd, deadline: deadline) == expected else { return }
            lock.withLock { accepted = true }
            guard ready.wait(timeout: .now() + 1) == .success else { return }
            for part in [Data(ack.prefix(11)), Data(ack.dropFirst(11))] {
                guard part.withUnsafeBytes({ Darwin.write(fd, $0.baseAddress, $0.count) }) == part.count else { return }
            }
            while let packet = readPacket(fd, deadline: deadline) {
                let stored = lock.withLock { () -> Bool in
                    guard packets.count < 16 else { return false }; packets.append(packet); return true
                }
                if !stored { return }
            }
        }
    }
    func confirm() { ready.signal() }
    func wait() -> Bool { done.wait(timeout: .now() + 2) == .success }
    func finish() -> Bool {
        ready.signal()
        lock.withLock { if client >= 0 { _ = Darwin.shutdown(client, SHUT_RDWR) } }
        _ = Darwin.shutdown(listener, SHUT_RDWR)
        let result = wait(); Darwin.close(listener); return result
    }
    private func pollReady(_ fd: Int32, deadline: TimeInterval) -> Bool {
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { return false }
        var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        return poll(&ready, 1, Int32(min(5000, remaining * 1000))) > 0
    }
    private func readExact(_ fd: Int32, count: Int, deadline: TimeInterval) -> Data? {
        var result = Data()
        while result.count < count {
            guard pollReady(fd, deadline: deadline) else { return nil }
            var chunk = [UInt8](repeating: 0, count: min(4096, count - result.count))
            let read = Darwin.read(fd, &chunk, chunk.count)
            guard read > 0 else { return nil }; result.append(contentsOf: chunk.prefix(read))
        }
        return result
    }
    private func readPacket(_ fd: Int32, deadline: TimeInterval) -> Data? {
        guard let header = readExact(fd, count: 10, deadline: deadline), header.prefix(5) == Data([77,69,68,50,2]) else { return nil }
        let length = Int(RuntimeMediaCodecV2.uint(header, 6, UInt32.self))
        guard (1...65_643).contains(length), let body = readExact(fd, count: length, deadline: deadline) else { return nil }
        return header + body
    }
}
func authAcceptedFixture() throws -> Data {
    let object = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/runtime-4c97c47/timed-capture-v1/metadata.json")) as! [String: Any]
    return fixtureHex(object["authenticationAcceptedHex"] as! String)
}
func makeTimedSession(_ socket: ScriptedTimedConnection, _ capture: SyntheticCaptureBackend, _ engine: SyntheticOutputEngine, _ clock: TimedFixtureClock, nativeBudget: TimeInterval = 0.2,
                      connections: (@Sendable (String) throws -> any RuntimeMediaConnection)? = nil,
                      nowUnixMs: @escaping @Sendable () -> UInt64 = { 1_000_000 },
                      nowMonotonic: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) throws -> TimedMediaSession {
    try TimedMediaSession(clock: CaptureClockPairSampler(clockDomainId: "source-process", source: clock),
        playbackRequest: PlaybackRequest(outputDeviceUID: "synthetic-output", operationBudget: 0.2),
        captureRequest: { try captureRequest(budget: nativeBudget) }, connectionFactory: connections ?? { _ in socket },
        captureFactory: { SystemAudioCapture(backendFactory: { capture }, clock: IdentityCaptureClock()) },
        rendererFactory: { played in AudioOutputRenderer(backendFactory: { SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: { engine }) }, onPlayed: played) },
        nowUnixMs: nowUnixMs, nowMonotonic: nowMonotonic)
}
final class TimedMutableWall: @unchecked Sendable {
    private let lock = NSLock()
    private var current: UInt64
    init(_ value: UInt64) { current = value }
    var value: UInt64 { get { lock.withLock { current } } set { lock.withLock { current = newValue } } }
}
final class TimedAdmissionClock: @unchecked Sendable {
    private let lock = NSLock()
    private var offset: TimeInterval = 0
    var now: TimeInterval { lock.withLock { ProcessInfo.processInfo.systemUptime + offset } }
    func advance(_ seconds: TimeInterval) { lock.withLock { offset += seconds } }
}
final class TimedFixtureClock: CapturePairClockSource, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var invalid = false
    func invalidate() { lock.withLock { invalid = true } }
    var calls: Int { lock.withLock { count } }
    func hostNanoseconds() throws -> UInt64 { lock.withLock { count += 1; return UInt64(count) * 1_000_000_000 } }
    func wallSample() throws -> (unixNs: Int64, resolutionNs: UInt64) {
        try lock.withLock {
            guard !invalid else { throw BridgeProcessError.invalidInput }
            return (Int64(count) * 1_000_000_000 + 1_000_000_000_000, 1)
        }
    }
}
final class ScriptedTimedConnection: RuntimeMediaConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var outbound: [Data] = [], inbound: [Data] = []
    private var reader: CheckedContinuation<Data, Error>?
    private var readMaximum = 4096
    private var terminal = false
    var openFailureDelay: TimeInterval?
    var holdReaderUntilClose = false
    private var failWrite = false
    func failNextWrite() { lock.withLock { failWrite = true } }
    private var holdWrite = false, writeOverlap = false
    private var heldWrite: CheckedContinuation<Void, Error>?
    var hasHeldWrite: Bool { lock.withLock { heldWrite != nil } }
    var concurrentWrite: Bool { lock.withLock { writeOverlap } }
    func holdNextWrite() { lock.withLock { holdWrite = true } }
    func releaseWrite() { let reply = lock.withLock { let value = heldWrite; heldWrite = nil; return value }; reply?.resume() }
    var writes: [Data] { lock.withLock { outbound } }
    var closed: Bool { lock.withLock { terminal } }
    func open(deadline: TimeInterval) async throws {
        if let openFailureDelay { try await Task.sleep(for: .seconds(openFailureDelay)); throw RuntimeMediaConnectionError.unavailable }
    }
    func write(_ data: Data, deadline: TimeInterval) async throws {
        try await withCheckedThrowingContinuation { (reply: CheckedContinuation<Void, Error>) in
            lock.lock()
            guard !terminal else { lock.unlock(); reply.resume(throwing: RuntimeMediaConnectionError.closed); return }
            if failWrite { failWrite = false; lock.unlock(); reply.resume(throwing: RuntimeMediaConnectionError.unavailable); return }
            if heldWrite != nil { writeOverlap = true; lock.unlock(); reply.resume(throwing: RuntimeMediaConnectionError.busy); return }
            outbound.append(data)
            if holdWrite { holdWrite = false; heldWrite = reply; lock.unlock() }
            else { lock.unlock(); reply.resume() }
        }
    }
    func read(maximum: Int, deadline: TimeInterval?) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if terminal { lock.unlock(); continuation.resume(throwing: RuntimeMediaConnectionError.closed); return }
            if !inbound.isEmpty {
                let next = inbound.removeFirst(); let part = Data(next.prefix(maximum))
                if next.count > maximum { inbound.insert(Data(next.dropFirst(maximum)), at: 0) }
                lock.unlock(); continuation.resume(returning: part); return
            }
            reader = continuation; readMaximum = maximum; lock.unlock()
        }
    }
    func feed(_ bytes: Data) {
        lock.lock()
        guard !terminal else { lock.unlock(); return }
        if let callback = reader {
            reader = nil; let part = Data(bytes.prefix(readMaximum))
            if bytes.count > readMaximum { inbound.append(Data(bytes.dropFirst(readMaximum))) }
            lock.unlock(); callback.resume(returning: part)
        } else { inbound.append(bytes); lock.unlock() }
    }
    func close() async -> Bool { lock.withLock { holdReaderUntilClose = false }; cancel(); return true }
    func cancel() {
        lock.lock(); terminal = true; let callback = holdReaderUntilClose ? nil : reader, write = heldWrite
        if !holdReaderUntilClose { reader = nil }
        heldWrite = nil; inbound.removeAll(); lock.unlock()
        callback?.resume(throwing: RuntimeMediaConnectionError.closed)
        write?.resume(throwing: RuntimeMediaConnectionError.closed)
    }
}
