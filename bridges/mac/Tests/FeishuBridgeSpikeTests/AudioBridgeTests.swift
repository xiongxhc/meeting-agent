import Foundation
import XCTest

@testable import FeishuBridgeSpike

/// The media half of the bridge: format negotiation, monotonic frame stamps, a
/// bounded jitter buffer, capture and playback gap reporting, mute, and
/// barge-in cancellation.
///
/// Nothing here is audio. Frame payloads are three marker bytes so a test can
/// tell one frame from another; no sample, no recording, and no device
/// identifier appears in this package.
///
/// That Node.js is not on the frame path is asserted structurally, and the
/// weight sits on the first two of these:
///
/// 1. **A frame is not expressible on the control plane.** `BridgeControlPlane`
///    is the single door to the TypeScript coordinator, and it accepts a
///    `BridgeEvent` — an enum none of whose twelve cases can carry audio bytes.
///    There is no way to write the code that would hand a frame to Node.
/// 2. **The tripwire.** `TripwireControlPlane` records every call it receives,
///    and a 960-frame duplex exchange records none.
/// 3. **The endpoint got exactly what was captured.** `endpoint.received` is
///    compared whole-value and in order against the frames the bridge produced,
///    so nothing relayed, re-encoded, batched or reordered the stream.
/// 4. **The frame path runs in-process** — it spawns nothing. That is the whole
///    of what the process check establishes, and it is the weakest of the four:
///    a real Node relay would be a sibling service, not a child process.
final class AudioBridgeTests: XCTestCase {

    // MARK: - fixtures

    private static let format = AudioFormat(
        encoding: "pcm_s16le", sampleRate: 48000, channels: 1, frameMilliseconds: 20)

    /// Marker bytes, not audio.
    private func payload(_ marker: UInt8) -> [UInt8] { [0xAA, marker, 0x55] }

    private struct Harness {
        let clock: ManualMediaClock
        let device: FakeAudioDevice
        let endpoint: LoopbackMediaClient
        let controlPlane: TripwireControlPlane
        let bridge: AudioBridge
    }

    private func makeHarness(
        supporting formats: [AudioFormat] = [AudioBridgeTests.format],
        echo: Bool = false,
        jitterBufferMilliseconds: Int = 200,
        captureGapToleranceMilliseconds: Int? = nil
    ) -> Harness {
        let clock = ManualMediaClock(start: "2026-09-02T14:00:00.000Z")
        let device = FakeAudioDevice(supportedFormats: formats)
        let endpoint = LoopbackMediaClient(echoCapturedFrames: echo)
        let controlPlane = TripwireControlPlane()
        let bridge = AudioBridge(
            clock: clock,
            device: device,
            mediaClient: endpoint,
            controlPlane: controlPlane,
            jitterBufferMilliseconds: jitterBufferMilliseconds,
            captureGapToleranceMilliseconds: captureGapToleranceMilliseconds)
        return Harness(
            clock: clock, device: device, endpoint: endpoint, controlPlane: controlPlane,
            bridge: bridge)
    }

    @discardableResult
    private func connect(
        _ harness: Harness,
        format: String = "pcm_s16le/48000/1/20ms",
        expiresAt: String = "2026-09-02T15:00:00.000Z"
    ) -> MediaConnectOutcome {
        harness.bridge.connect(
            endpoint: "rtp://127.0.0.1:44100/session",
            sessionToken: "tok_fake_0000000000000001",
            format: format,
            expiresAt: expiresAt)
    }

    // MARK: - format negotiation

    func testNegotiatesTheOfferedFormatAndOpensTheEndpointItself() {
        let harness = makeHarness()

        let outcome = connect(harness)

        XCTAssertEqual(outcome, .connected(AudioBridgeTests.format))
        XCTAssertEqual(harness.bridge.negotiatedFormat, AudioBridgeTests.format)
        XCTAssertEqual(harness.endpoint.openedEndpoint, "rtp://127.0.0.1:44100/session")
        XCTAssertEqual(harness.endpoint.openedSessionToken, "tok_fake_0000000000000001")
        XCTAssertEqual(harness.endpoint.openedFormat, AudioBridgeTests.format)
        XCTAssertEqual(
            harness.controlPlane.events,
            [.mediaConnected(endpoint: "rtp://127.0.0.1:44100/session")])
    }

    func testAFormatStringItCannotParseIsARejectionNotADefault() {
        let harness = makeHarness()

        let outcome = connect(harness, format: "pcm_s16le/48000/1")

        XCTAssertEqual(outcome, .rejected(reason: "media_format_unparseable"))
        XCTAssertNil(harness.bridge.negotiatedFormat)
        XCTAssertNil(harness.endpoint.openedFormat, "an unnegotiated format never opens a session")
        XCTAssertTrue(harness.controlPlane.events.isEmpty)
    }

    func testAFormatTheDeviceCannotCarryIsARejectionNotASubstitution() {
        let harness = makeHarness(
            supporting: [
                AudioFormat(
                    encoding: "pcm_s16le", sampleRate: 16000, channels: 1, frameMilliseconds: 20)
            ])

        let outcome = connect(harness)

        XCTAssertEqual(outcome, .rejected(reason: "media_format_unsupported"))
        XCTAssertNil(harness.bridge.negotiatedFormat)
        XCTAssertNil(
            harness.endpoint.openedFormat,
            "the nearest supported format is never substituted behind the coordinator's back")
        XCTAssertTrue(harness.controlPlane.events.isEmpty)
    }

    func testAnExpiredSessionTokenIsRejectedBeforeTheEndpointIsOpened() {
        let harness = makeHarness()

        let outcome = connect(harness, expiresAt: "2026-09-02T13:59:59.000Z")

        XCTAssertEqual(outcome, .rejected(reason: "media_session_token_expired"))
        XCTAssertNil(harness.endpoint.openedEndpoint)
        XCTAssertTrue(harness.controlPlane.events.isEmpty)
    }

    func testAnEndpointThatRefusesToOpenIsAFailureAndEmitsNoConnectedEvent() {
        let harness = makeHarness()
        harness.endpoint.openFailureReason = "endpoint_unreachable"

        let outcome = connect(harness)

        XCTAssertEqual(outcome, .failed(reason: "endpoint_unreachable"))
        XCTAssertNil(harness.bridge.negotiatedFormat)
        XCTAssertTrue(
            harness.controlPlane.events.isEmpty,
            "media_connected is claimed only once the endpoint accepted the session")
    }

    func testASecondConnectIsRefusedWhileTheFirstIsStillOpen() {
        let harness = makeHarness()
        connect(harness)

        let outcome = connect(harness)

        XCTAssertEqual(outcome, .rejected(reason: "media_already_connected"))
        XCTAssertEqual(harness.endpoint.openCount, 1)
    }

    func testCaptureIsRefusedBeforeAFormatHasBeenNegotiated() {
        let harness = makeHarness()

        XCTAssertNil(harness.bridge.captureFrame(payload: payload(1)))
        XCTAssertTrue(harness.endpoint.received.isEmpty)
    }

    // MARK: - monotonic frame timestamps

    func testFrameTimestampsFollowTheMonotonicClockWhenTheWallClockJumpsBackwards() {
        let harness = makeHarness()
        connect(harness)

        let first = harness.bridge.captureFrame(payload: payload(1))
        harness.clock.advance(20)
        // An NTP correction moves the wall clock back a whole second. Frame
        // timing must not follow it.
        harness.clock.rewindWall(1000)
        let second = harness.bridge.captureFrame(payload: payload(2))
        harness.clock.advance(20)
        let third = harness.bridge.captureFrame(payload: payload(3))

        let stamps = [first, second, third].map { $0?.timestampMilliseconds }
        XCTAssertEqual(stamps, [1_000_000, 1_000_020, 1_000_040])
        XCTAssertEqual([first, second, third].map { $0?.sequence }, [1, 2, 3])
        XCTAssertEqual(harness.endpoint.received.map(\.timestampMilliseconds), [
            1_000_000, 1_000_020, 1_000_040,
        ])
    }

    func testAMonotonicClockThatRegressesDisconnectsRatherThanStampingBackwards() {
        let harness = makeHarness()
        connect(harness)
        harness.bridge.captureFrame(payload: payload(1))
        harness.controlPlane.reset()

        harness.clock.rewindMonotonic(5)
        let frame = harness.bridge.captureFrame(payload: payload(2))

        XCTAssertNil(frame, "a backwards stamp is never emitted")
        XCTAssertEqual(harness.endpoint.received.count, 1)
        XCTAssertEqual(
            harness.controlPlane.events, [.mediaDisconnected(reason: "media_clock_regressed")])
        XCTAssertEqual(harness.endpoint.closeReasons, ["media_clock_regressed"])
    }

    // MARK: - bounded jitter buffer

    func testTheJitterBufferIsBoundedAndOverflowDropsTheOldestFrameObservably() {
        let harness = makeHarness()
        connect(harness)
        harness.controlPlane.reset()

        // 200 ms of 20 ms frames is a bound of ten.
        for marker in 1...13 {
            harness.endpoint.deliverPlayback(
                payload: payload(UInt8(marker)), timestampMilliseconds: 2_000_000 + marker * 20)
        }

        XCTAssertEqual(harness.bridge.jitterBufferCapacityFrames, 10)
        XCTAssertEqual(harness.bridge.bufferedPlaybackFrames, 10)
        XCTAssertEqual(harness.bridge.playbackFramesDroppedByOverflow, 3)

        // The three oldest went, the newest stayed: stale audio is worthless in
        // a live conversation and holding it only adds latency.
        var played: [[UInt8]] = []
        while harness.bridge.renderTick() { played.append(harness.device.played.last?.payload ?? []) }
        XCTAssertEqual(played, (4...13).map { payload(UInt8($0)) })

        XCTAssertEqual(
            harness.controlPlane.events,
            [
                .audioGap(
                    direction: .playback, startedAt: "2026-09-02T14:00:00.000Z", endedAt: nil)
            ],
            "one gap opened at the first drop, still open because nothing has ended it")
    }

    func testThePlaybackGapClosesOnlyWhenTheBufferAcceptsAFrameAgain() {
        let harness = makeHarness()
        connect(harness)
        harness.controlPlane.reset()

        for marker in 1...11 {
            harness.endpoint.deliverPlayback(
                payload: payload(UInt8(marker)), timestampMilliseconds: 2_000_000 + marker * 20)
        }
        XCTAssertEqual(harness.bridge.playbackFramesDroppedByOverflow, 1)

        harness.bridge.renderTick()
        harness.clock.advance(60)
        harness.endpoint.deliverPlayback(payload: payload(12), timestampMilliseconds: 2_000_240)

        XCTAssertEqual(
            harness.controlPlane.events,
            [
                .audioGap(
                    direction: .playback, startedAt: "2026-09-02T14:00:00.000Z", endedAt: nil),
                .audioGap(
                    direction: .playback, startedAt: "2026-09-02T14:00:00.000Z",
                    endedAt: "2026-09-02T14:00:00.060Z"),
            ])
        XCTAssertEqual(harness.bridge.playbackFramesDroppedByOverflow, 1)
    }

    func testAnOpenPlaybackGapStaysOpenWhenTheMediaSessionDisconnects() {
        let harness = makeHarness()
        connect(harness)
        harness.controlPlane.reset()

        for marker in 1...11 {
            harness.endpoint.deliverPlayback(
                payload: payload(UInt8(marker)), timestampMilliseconds: 2_000_000 + marker * 20)
        }
        harness.clock.advance(40)
        harness.bridge.disconnect(reason: "endpoint_closed")

        XCTAssertEqual(
            harness.controlPlane.events,
            [
                .audioGap(
                    direction: .playback, startedAt: "2026-09-02T14:00:00.000Z", endedAt: nil),
                .mediaDisconnected(reason: "endpoint_closed"),
            ],
            "the gap's end was never observed, so no end is invented for it")
        XCTAssertEqual(harness.bridge.bufferedPlaybackFrames, 0)
    }

    func testAFrameStillInFlightWhenTheSessionClosedIsRefusedByTheBridgeItself() {
        let harness = makeHarness()
        connect(harness)
        harness.bridge.disconnect(reason: "endpoint_closed")
        harness.controlPlane.reset()

        // The endpoint cannot unsend what it already put on the wire.
        harness.endpoint.deliverPlayback(payload: payload(1), timestampMilliseconds: 2_000_000)

        XCTAssertEqual(harness.bridge.bufferedPlaybackFrames, 0)
        XCTAssertFalse(harness.bridge.renderTick())
        XCTAssertTrue(harness.device.played.isEmpty)
        XCTAssertTrue(harness.controlPlane.events.isEmpty)
    }

    func testAReconnectNeverClosesAGapTheClosedSessionOpened() {
        let harness = makeHarness()
        connect(harness)
        for marker in 1...11 {
            harness.endpoint.deliverPlayback(
                payload: payload(UInt8(marker)), timestampMilliseconds: 2_000_000 + marker * 20)
        }
        XCTAssertEqual(harness.bridge.playbackFramesDroppedByOverflow, 1)
        harness.bridge.disconnect(reason: "endpoint_closed")

        harness.clock.advance(5000)
        connect(harness)
        harness.controlPlane.reset()
        harness.endpoint.deliverPlayback(payload: payload(20), timestampMilliseconds: 3_000_000)

        XCTAssertTrue(
            harness.controlPlane.events.isEmpty,
            "the new session neither closed the old session's gap nor opened one of its own")
        XCTAssertEqual(harness.bridge.playbackFramesDroppedByOverflow, 0, "counters are per session")
        XCTAssertEqual(harness.bridge.captureFrame(payload: payload(1))?.sequence, 1)
    }

    func testACancellationDoesNotSurviveIntoTheNextMediaSession() {
        let harness = makeHarness()
        connect(harness)
        harness.bridge.cancelPlayback()
        harness.bridge.disconnect(reason: "endpoint_closed")

        connect(harness)
        harness.endpoint.deliverPlayback(payload: payload(1), timestampMilliseconds: 3_000_000)

        XCTAssertTrue(
            harness.bridge.renderTick(),
            "a new session starts open; the old session's barge-in does not mute it")
        XCTAssertEqual(harness.bridge.playbackFramesDroppedByCancellation, 0)
    }

    // MARK: - capture gaps

    func testACaptureGapSpansTheLastObservedCaptureAndTheNextOne() {
        let harness = makeHarness()
        connect(harness)
        harness.controlPlane.reset()

        harness.bridge.captureFrame(payload: payload(1))
        harness.clock.advance(20)
        harness.bridge.captureFrame(payload: payload(2))  // on cadence, no gap
        harness.clock.advance(500)  // the OS took the input device
        harness.bridge.captureFrame(payload: payload(3))

        XCTAssertEqual(
            harness.controlPlane.events,
            [
                .audioGap(
                    direction: .capture,
                    startedAt: "2026-09-02T14:00:00.020Z",
                    endedAt: "2026-09-02T14:00:00.520Z")
            ],
            "both ends of this gap were observed: it is reported closed")
        XCTAssertEqual(harness.endpoint.received.count, 3, "the frames either side still went")
    }

    func testCaptureOnCadenceReportsNoGap() {
        let harness = makeHarness()
        connect(harness)
        harness.controlPlane.reset()

        for marker in 1...50 {
            harness.bridge.captureFrame(payload: payload(UInt8(marker)))
            harness.clock.advance(20)
        }

        XCTAssertTrue(harness.controlPlane.events.isEmpty)
        XCTAssertEqual(harness.bridge.capturedFramesSent, 50)
    }

    func testTheCaptureGapToleranceIsAParameterNotAConstant() {
        let harness = makeHarness(captureGapToleranceMilliseconds: 500)
        connect(harness)
        harness.controlPlane.reset()

        harness.bridge.captureFrame(payload: payload(1))
        harness.clock.advance(400)
        harness.bridge.captureFrame(payload: payload(2))

        XCTAssertEqual(
            harness.bridge.captureGapToleranceMilliseconds, 500,
            "the value in force is readable, because a gap count means nothing without it")
        XCTAssertTrue(
            harness.controlPlane.events.isEmpty,
            "a 400 ms stall is inside a 500 ms tolerance; the default 40 ms would have fired")

        harness.clock.advance(600)
        harness.bridge.captureFrame(payload: payload(3))
        XCTAssertEqual(harness.controlPlane.events.count, 1)
    }

    func testTheCaptureGapToleranceDefaultsToTwoFrames() {
        let harness = makeHarness()
        connect(harness)

        XCTAssertEqual(harness.bridge.captureGapToleranceMilliseconds, 40)

        harness.bridge.disconnect(reason: "endpoint_closed")
        XCTAssertEqual(
            harness.bridge.captureGapToleranceMilliseconds, 0,
            "with no negotiated format there is no tolerance in force to report")
    }

    // MARK: - mute

    func testMuteStopsFramesReachingTheEndpointAndIsNotReportedAsAGap() {
        let harness = makeHarness()
        connect(harness)
        harness.controlPlane.reset()

        harness.bridge.captureFrame(payload: payload(1))
        harness.clock.advance(20)

        harness.bridge.setMuted(true)
        XCTAssertTrue(harness.bridge.isMuted)
        for marker in 2...12 {
            XCTAssertNil(
                harness.bridge.captureFrame(payload: payload(UInt8(marker))),
                "a muted bridge forwards nothing")
            harness.clock.advance(20)
        }
        harness.bridge.setMuted(false)

        let afterUnmute = harness.bridge.captureFrame(payload: payload(13))

        XCTAssertEqual(harness.endpoint.received.map(\.payload), [payload(1), payload(13)])
        XCTAssertEqual(
            harness.controlPlane.events, [],
            "a mute is an explained silence, so it is not an audio_gap")
        XCTAssertEqual(afterUnmute?.sequence, 2)
        XCTAssertGreaterThan(
            afterUnmute?.timestampMilliseconds ?? 0, 1_000_000,
            "stamps stay on the monotonic timeline across the mute")
    }

    func testMutingTwiceIsNotASecondStateChange() {
        let harness = makeHarness()
        connect(harness)
        harness.bridge.setMuted(true)
        harness.bridge.setMuted(true)
        harness.bridge.setMuted(false)

        XCTAssertFalse(harness.bridge.isMuted)
        XCTAssertNotNil(harness.bridge.captureFrame(payload: payload(1)))
    }

    func testMuteIsDeliberateStateAndSurvivesAMediaReconnect() {
        let harness = makeHarness()
        connect(harness)
        harness.bridge.setMuted(true)
        harness.bridge.disconnect(reason: "endpoint_closed")

        connect(harness)

        XCTAssertTrue(
            harness.bridge.isMuted,
            "a transport reconnect does not undo a mute the coordinator asked for")
        XCTAssertNil(harness.bridge.captureFrame(payload: payload(1)))
        XCTAssertTrue(harness.endpoint.received.isEmpty)

        harness.bridge.setMuted(false)
        XCTAssertNotNil(harness.bridge.captureFrame(payload: payload(1)))
    }

    // MARK: - barge-in

    func testCancellationDropsTheBufferedFramesWithoutWaitingForThemToDrain() {
        let harness = makeHarness()
        connect(harness)
        for marker in 1...10 {
            harness.endpoint.deliverPlayback(
                payload: payload(UInt8(marker)), timestampMilliseconds: 2_000_000 + marker * 20)
        }
        XCTAssertTrue(harness.bridge.renderTick())
        XCTAssertEqual(harness.bridge.bufferedPlaybackFrames, 9)
        harness.controlPlane.reset()

        harness.bridge.cancelPlayback()

        XCTAssertEqual(harness.bridge.bufferedPlaybackFrames, 0, "the buffer went at once")
        XCTAssertFalse(harness.bridge.renderTick())
        XCTAssertEqual(
            harness.device.played.map(\.payload), [payload(1)],
            "nothing queued behind the cancellation was played")
        XCTAssertTrue(
            harness.controlPlane.events.isEmpty,
            "a cancelled utterance is an explained stop, not an audio_gap")
    }

    func testABargeInNeverClosesAnOpenGapWithAnEndItDidNotObserve() {
        let harness = makeHarness()
        connect(harness)
        harness.controlPlane.reset()

        for marker in 1...11 {
            harness.endpoint.deliverPlayback(
                payload: payload(UInt8(marker)), timestampMilliseconds: 2_000_000 + marker * 20)
        }
        XCTAssertEqual(harness.bridge.playbackFramesDroppedByOverflow, 1)

        harness.clock.advance(40)
        harness.bridge.cancelPlayback()
        harness.clock.advance(40)
        harness.bridge.resumePlayback()
        harness.endpoint.deliverPlayback(payload: payload(20), timestampMilliseconds: 2_000_300)

        XCTAssertEqual(
            harness.controlPlane.events,
            [
                .audioGap(
                    direction: .playback, startedAt: "2026-09-02T14:00:00.000Z", endedAt: nil)
            ],
            "the barge-in ended the tracking, not the outage: no close is emitted, and the "
                + "reported gap never spans the silence the bridge asked for")
    }

    func testCancellationKeepsDiscardingUntilPlaybackIsResumed() {
        let harness = makeHarness()
        connect(harness)
        harness.bridge.cancelPlayback()

        // The endpoint keeps sending the cancelled utterance for as long as the
        // cancellation takes to reach it.
        for marker in 1...5 {
            harness.endpoint.deliverPlayback(
                payload: payload(UInt8(marker)), timestampMilliseconds: 2_000_000 + marker * 20)
        }
        XCTAssertEqual(harness.bridge.bufferedPlaybackFrames, 0)
        XCTAssertFalse(harness.bridge.renderTick())
        XCTAssertEqual(harness.bridge.playbackFramesDroppedByCancellation, 5)

        harness.bridge.resumePlayback()
        harness.endpoint.deliverPlayback(payload: payload(9), timestampMilliseconds: 2_000_200)

        XCTAssertTrue(harness.bridge.renderTick())
        XCTAssertEqual(harness.device.played.map(\.payload), [payload(9)])
    }

    // MARK: - direct duplex, with no control plane and no process in between

    func testDuplexFramesTravelStraightBetweenTheBridgeAndTheEndpoint() {
        let harness = makeHarness(echo: true)
        connect(harness)
        let afterConnect = harness.controlPlane.events
        harness.controlPlane.reset()

        var captured: [AudioFrame] = []
        for index in 0..<480 {
            if let frame = harness.bridge.captureFrame(payload: payload(UInt8(index % 251))) {
                captured.append(frame)
            }
            harness.bridge.renderTick()
            harness.clock.advance(20)
        }

        XCTAssertEqual(captured.count, 480)
        XCTAssertEqual(
            harness.endpoint.received, captured,
            "every captured frame reached the endpoint, in order and unaltered")
        XCTAssertEqual(
            harness.device.played.map(\.payload), captured.map(\.payload),
            "and every playback frame came back from the endpoint, in order and unaltered")

        XCTAssertEqual(
            afterConnect, [.mediaConnected(endpoint: "rtp://127.0.0.1:44100/session")],
            "the control plane is told the session opened, and nothing else")
        XCTAssertEqual(
            harness.controlPlane.calls, 0,
            "960 frames moved and the control plane — the only door to the Node.js "
                + "coordinator — was not touched once")
    }

    /// The narrow property this can actually establish: the frame path runs
    /// entirely in-process. It is deliberately not called a no-Node assertion —
    /// a Node relay would be a sibling service or a daemon, not a child of a
    /// Swift test process, so this could not detect one even in principle. The
    /// claim that Node is not on the frame path rests on the type-level
    /// argument (`BridgeControlPlane` carries a `BridgeEvent`, which cannot hold
    /// audio bytes) and on the tripwire in the test above.
    func testTheFramePathSpawnsNoSubprocess() throws {
        let harness = makeHarness(echo: true)
        connect(harness)

        for index in 0..<480 {
            harness.bridge.captureFrame(payload: payload(UInt8(index % 251)))
            harness.bridge.renderTick()
            harness.clock.advance(20)
        }
        let descendants = try Self.descendantProcesses()

        XCTAssertEqual(harness.device.played.count, 480, "the duplex exchange really happened")
        XCTAssertTrue(
            descendants.isEmpty,
            "moving 960 frames spawned a process: \(descendants)")
    }

    /// Every process descended from this test process, as `pid: command`.
    /// `ps` lists itself, so its own pid is taken back out again; what is left
    /// is anything the code under test started.
    private static func descendantProcesses() throws -> [Int32: String] {
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-Ao", "pid=,ppid=,comm="]
        let pipe = Pipe()
        ps.standardOutput = pipe
        try ps.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        ps.waitUntilExit()
        let snapshotPid = ps.processIdentifier

        var command: [Int32: String] = [:]
        var children: [Int32: [Int32]] = [:]
        for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
            let fields = line.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
            guard fields.count == 3, let pid = Int32(fields[0]), let ppid = Int32(fields[1])
            else { continue }
            command[pid] = String(fields[2])
            children[ppid, default: []].append(pid)
        }

        var descendants: [Int32: String] = [:]
        var frontier = [ProcessInfo.processInfo.processIdentifier]
        while let pid = frontier.popLast() {
            for child in children[pid] ?? []
            where descendants[child] == nil && child != snapshotPid {
                descendants[child] = command[child] ?? ""
                frontier.append(child)
            }
        }
        return descendants
    }
}

// MARK: - test doubles

/// A clock whose wall and monotonic readings move only when a test moves them,
/// and which can move them apart — the point of taking frame timing from the
/// monotonic reading is that a wall-clock correction must not disturb it.
private final class ManualMediaClock: MediaClock {
    private var wallMilliseconds: Int
    private var monotonic: Int

    init(start: String, monotonicStart: Int = 1_000_000) {
        wallMilliseconds = ManualMediaClock.parse(start)
        monotonic = monotonicStart
    }

    func now() -> String { ManualMediaClock.format(wallMilliseconds) }
    func monotonicMilliseconds() -> Int { monotonic }

    func advance(_ milliseconds: Int) {
        wallMilliseconds += milliseconds
        monotonic += milliseconds
    }

    func rewindWall(_ milliseconds: Int) { wallMilliseconds -= milliseconds }
    func rewindMonotonic(_ milliseconds: Int) { monotonic -= milliseconds }

    private static func parse(_ iso: String) -> Int {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: iso) else {
            preconditionFailure("not a UTC timestamp: \(iso)")
        }
        return Int((date.timeIntervalSince1970 * 1000).rounded())
    }

    private static func format(_ milliseconds: Int) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1000))
    }
}

/// Stands in for the machine's audio hardware: what it can carry, and what was
/// actually played out of it. Real device I/O lives behind this protocol for the
/// same reason `AccessibilityDriver` exists — so the tests need no hardware and
/// no microphone permission.
private final class FakeAudioDevice: AudioDevicePort {
    let supportedFormats: [AudioFormat]
    private(set) var played: [AudioFrame] = []

    init(supportedFormats: [AudioFormat]) { self.supportedFormats = supportedFormats }

    func play(_ frame: AudioFrame) { played.append(frame) }
}

/// The door to the TypeScript coordinator, wired to a tripwire: it counts every
/// call, so a test can assert the frame path never opened it.
private final class TripwireControlPlane: BridgeControlPlane {
    private(set) var events: [BridgeEvent] = []
    private(set) var calls = 0

    func emit(_ event: BridgeEvent, observedAt: String) {
        calls += 1
        events.append(event)
        XCTAssertFalse(observedAt.isEmpty, "every event carries the instant it was observed")
    }

    func reset() {
        events.removeAll()
        calls = 0
    }
}
