import XCTest
@testable import FeishuBridgeSpike

/// `renew_media_lease`: the Runtime extended the same credential, so the bridge
/// moves its own reconnect-admission cutoff forward. Capture is never touched.
final class MediaLeaseRenewalTests: XCTestCase, @unchecked Sendable {
    private func renewal(_ commandId: String, session: String = "41", expiresAtMs: String, bridge: String = "bridge-independent") -> [String: Any] {
        ["schema": "bridge-session/v2", "sessionId": bridge, "commandId": commandId, "type": "renew_media_lease",
         "leaseRenewal": ["sessionId": session, "expiresAtMs": expiresAtMs]]
    }
    private func decode(_ object: [String: Any]) throws -> BridgeCommandMessageV2 {
        try BridgeCommandMessageV2.decode(JSONSerialization.data(withJSONObject: object))
    }

    // MARK: wire

    func testSharedFixtureRenewalDecodesAndMalformedRenewalsAreRefused() throws {
        let fixture = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/contracts/bridge-session-v2.json")) as! [String: Any]
        let shared = try XCTUnwrap((fixture["commands"] as! [[String: Any]]).first { $0["type"] as? String == "renew_media_lease" })
        let decoded = try decode(shared)
        XCTAssertEqual(decoded.leaseRenewal, MediaLeaseRenewal(sessionId: 41, expiresAtMs: 1_120_000))
        XCTAssertNil(decoded.legacy); XCTAssertNil(decoded.mediaLease)
        XCTAssertThrowsError(try JSONDecoder().decode(BridgeCommandMessage.self, from: JSONSerialization.data(withJSONObject: shared)))
        let good = renewal("r", expiresAtMs: "1120000")
        XCTAssertNoThrow(try decode(good))
        for patch: [String: Any] in [["sessionId": 41], ["sessionId": "041"], ["sessionId": "0"], ["expiresAtMs": "0"],
                                     ["expiresAtMs": "18446744073709551616"], ["expiresAtMs": 1_120_000], ["credential": "x"]] {
            var changed = good
            changed["leaseRenewal"] = (good["leaseRenewal"] as! [String: Any]).merging(patch) { _, new in new }
            XCTAssertThrowsError(try decode(changed), "\(patch)")
        }
        var missing = good; missing["leaseRenewal"] = ["sessionId": "41"]
        XCTAssertThrowsError(try decode(missing))
        var extra = good; extra["mediaLease"] = [:]
        XCTAssertThrowsError(try decode(extra))
        var absent = good; absent.removeValue(forKey: "leaseRenewal")
        XCTAssertThrowsError(try decode(absent))
    }

    // MARK: session

    func testRenewedExpiryAdmitsAReconnectTheOriginalCutoffWouldRefuseWithoutTouchingCapture() async throws {
        let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
        sockets.values = [first, second]
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let wall = TimedMutableWall(1_059_800), monotonic = TimedAdmissionClock()
        let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() },
                                           nowUnixMs: { wall.value }, nowMonotonic: { monotonic.now })
        first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        _ = await session.takeEvents()
        let renewed = await session.renew(sessionId: 41, expiresAtMs: 1_100_000)
        XCTAssertEqual(renewed, .renewed)
        XCTAssertEqual(capture.startCount, 1); XCTAssertEqual(capture.stopCount, 0)
        XCTAssertEqual(engine.stopCount, 0); XCTAssertFalse(first.closed)
        let quiet = await session.takeEvents(); XCTAssertEqual(quiet, [])
        monotonic.advance(0.3)
        first.cancel()
        await waitForAudio { capture.startCount == 2 }
        XCTAssertEqual(sockets.count, 2, "the renewed cutoff admits the reconnect")
        XCTAssertEqual(capture.startCount, 2)
        _ = await session.stop()
    }

    func testRefusedRenewalsLeaveTheOriginalCutoffInForce() async throws {
        let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
        sockets.values = [first, second]
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let wall = TimedMutableWall(1_059_800), monotonic = TimedAdmissionClock()
        let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() },
                                           nowUnixMs: { wall.value }, nowMonotonic: { monotonic.now })
        let before = await session.renew(sessionId: 41, expiresAtMs: 1_100_000)
        XCTAssertEqual(before, .notActive, "no lease before start")
        first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        let earlier = await session.renew(sessionId: 41, expiresAtMs: 1_059_999)
        XCTAssertEqual(earlier, .regressed)
        let other = await session.renew(sessionId: 42, expiresAtMs: 1_100_000)
        XCTAssertEqual(other, .sessionMismatch)
        let same = await session.renew(sessionId: 41, expiresAtMs: 1_060_000)
        XCTAssertEqual(same, .unchanged)
        wall.value = 1_060_000
        let samePast = await session.renew(sessionId: 41, expiresAtMs: 1_060_000)
        XCTAssertEqual(samePast, .expired, "an unchanged expiry that has passed is expired, not ok")
        wall.value = 1_200_000
        let lapsed = await session.renew(sessionId: 41, expiresAtMs: 1_100_000)
        XCTAssertEqual(lapsed, .expired, "a renewal that is already past cannot revive admission")
        XCTAssertEqual(capture.startCount, 1); XCTAssertEqual(capture.stopCount, 0)
        monotonic.advance(0.3)
        first.cancel()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(sockets.count, 1, "refused renewals cannot extend the original cutoff")
        _ = await session.stop()
        let after = await session.renew(sessionId: 41, expiresAtMs: 1_300_000)
        XCTAssertEqual(after, .notActive)
    }

    func testAttemptCounterResetsAfterEachSuccessfulReconnect() async throws {
        let connections = (0..<5).map { _ in ScriptedTimedConnection() }, sockets = TimedSocketSequence()
        sockets.values = connections
        for connection in connections { connection.feed(try authAcceptedFixture()) }
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(connections[0], capture, engine, clock, connections: { _ in try sockets.next() })
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        _ = await session.takeEvents()
        for outage in 1...4 {
            connections[outage - 1].cancel()
            let events = await collect(session) { $0.contains(.reconnected(attempt: 1)) || $0.contains(.mediaDisconnected(reason: "reconnect_exhausted")) }
            XCTAssertTrue(events.contains(.reconnecting(attempt: 1)), "outage \(outage) starts a fresh attempt count")
            XCTAssertTrue(events.contains(.reconnected(attempt: 1)), "outage \(outage) recovers")
            XCTAssertFalse(events.contains(.mediaDisconnected(reason: "reconnect_exhausted")))
        }
        XCTAssertEqual(capture.startCount, 5)
        _ = await session.stop()
    }

    func testAFlappingLinkIsBoundedByTheRollingReconnectBudget() async throws {
        let limit = TimedMediaSession.reconnectRateLimit
        let connections = (0...(limit + 1)).map { _ in ScriptedTimedConnection() }, sockets = TimedSocketSequence()
        sockets.values = connections
        for connection in connections { connection.feed(try authAcceptedFixture()) }
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let session = try makeTimedSession(connections[0], capture, engine, clock, connections: { _ in try sockets.next() })
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        _ = await session.takeEvents()
        for outage in 1...limit {
            connections[outage - 1].cancel()
            let events = await collect(session) { $0.contains(.reconnected(attempt: 1)) }
            XCTAssertTrue(events.contains(.reconnected(attempt: 1)), "flap \(outage) is within budget")
        }
        connections[limit].cancel()
        let events = await collect(session) { $0.contains(.mediaDisconnected(reason: "reconnect_exhausted")) }
        XCTAssertTrue(events.contains(.mediaDisconnected(reason: "reconnect_exhausted")))
        XCTAssertFalse(events.contains { $0.typeName == "reconnecting" })
        XCTAssertEqual(sockets.count, limit + 1)
        let lapsed = await session.renew(sessionId: 41, expiresAtMs: 1_100_000)
        XCTAssertEqual(lapsed, .notActive, "media that has given up reports itself as not active")
        _ = await session.stop()
    }

    func testAnAdmissionDeadlinePassingDuringTheBackoffIsReportedAsAGiveUp() async throws {
        let first = ScriptedTimedConnection(), second = ScriptedTimedConnection(), sockets = TimedSocketSequence()
        sockets.values = [first, second]
        let capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        let wall = TimedMutableWall(1_059_700), monotonic = TimedAdmissionClock()
        let session = try makeTimedSession(first, capture, engine, clock, connections: { _ in try sockets.next() },
                                           nowUnixMs: { wall.value }, nowMonotonic: { monotonic.now })
        first.feed(try authAcceptedFixture()); second.feed(try authAcceptedFixture())
        let started = await session.start(try timedFixtureLease()); XCTAssertTrue(started)
        _ = await session.takeEvents()
        first.cancel()
        var events = await collect(session) { $0.contains(.reconnecting(attempt: 1)) }
        XCTAssertTrue(events.contains(.reconnecting(attempt: 1)))
        // The credential cutoff passes while the bridge waits to retry.
        monotonic.advance(0.5)
        events += await collect(session) { $0.contains(.mediaDisconnected(reason: "reconnect_exhausted")) }
        XCTAssertTrue(events.contains(.mediaDisconnected(reason: "reconnect_exhausted")),
                      "media that ends at the backoff reports a give-up the coordinator relaunches on: \(events)")
        XCTAssertEqual(sockets.count, 1, "no attempt past the cutoff")
        let lapsed = await session.renew(sessionId: 41, expiresAtMs: 1_100_000)
        XCTAssertEqual(lapsed, .notActive)
        _ = await session.stop()
    }

    // MARK: process

    func testProcessAnswersRenewalsAndNeverRestartsCapture() throws {
        let cancellation = BridgeCancellation(), sink = MemoryEvidenceSink()
        let socket = ScriptedTimedConnection(), capture = SyntheticCaptureBackend(), engine = SyntheticOutputEngine(), clock = TimedFixtureClock()
        socket.feed(try authAcceptedFixture())
        let session = try makeTimedSession(socket, capture, engine, clock)
        let media = TimedMediaControlOwner(session: session, cancellation: cancellation)
        let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(meetingNo: "123456789"), FakeTree.inMeeting(meetingNo: "123456789"), FakeTree.idleWithJoinSurface()])
        var results: [String: (String, String?)] = [:]
        let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink,
            v2Clock: try CaptureClockPairSampler(clockDomainId: "source-process", source: clock), timedMedia: media,
            output: { bytes in
                let event = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
                _ = try BridgeEventMessageV2.decode(bytes.dropLast())
                if event["type"] as? String == "command_result" {
                    results[event["commandId"] as! String] = (event["outcome"] as! String, event["detail"] as? String)
                }
            })
        XCTAssertThrowsError(try process.accept(decode(renewal("too-early", expiresAtMs: "1120000"))), "no owner yet")
        let fixture = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/contracts/bridge-session-v2.json")) as! [String: Any]
        let commands = fixture["commands"] as! [[String: Any]]
        try process.accept(decode(commands[0]))
        try process.accept(decode(renewal("before-media", expiresAtMs: "1120000")))
        XCTAssertEqual(results["before-media"]?.0, "rejected"); XCTAssertEqual(results["before-media"]?.1, "media_not_connected")
        try process.accept(decode(commands[1]))
        XCTAssertEqual(results["media-1"]?.0, "ok")
        XCTAssertEqual(results["media-1"]?.1, "media_lease_renewal", "a connected answer advertises that renewals are understood")
        try process.accept(decode(renewal("renew-a", expiresAtMs: "1120000")))
        XCTAssertEqual(results["renew-a"]?.0, "ok")
        results["renew-a"] = nil
        try process.accept(decode(renewal("renew-a", expiresAtMs: "1120000")))
        XCTAssertEqual(results["renew-a"]?.0, "ok", "an exact replay repeats its answer")
        XCTAssertThrowsError(try process.accept(decode(renewal("renew-a", expiresAtMs: "1130000"))), "a reused command id with new bytes conflicts")
        try process.accept(decode(renewal("renew-back", expiresAtMs: "1090000")))
        XCTAssertEqual(results["renew-back"]?.0, "rejected"); XCTAssertEqual(results["renew-back"]?.1, "lease_expiry_regressed")
        try process.accept(decode(renewal("renew-other", session: "42", expiresAtMs: "1130000")))
        XCTAssertEqual(results["renew-other"]?.0, "rejected"); XCTAssertEqual(results["renew-other"]?.1, "media_session_mismatch")
        XCTAssertThrowsError(try process.accept(decode(renewal("renew-bridge", expiresAtMs: "1130000", bridge: "other-bridge"))), "unknown bridge session")
        XCTAssertEqual(capture.startCount, 1); XCTAssertEqual(capture.stopCount, 0); XCTAssertFalse(socket.closed)
        try process.shutdown()
        XCTAssertEqual(process.shutdownResult, .confirmed)
        XCTAssertTrue(String(decoding: sink.data, as: UTF8.self).contains("renew_media_lease"))
    }

    private func collect(_ session: TimedMediaSession, seconds: TimeInterval = 2, until done: ([BridgeEvent]) -> Bool) async -> [BridgeEvent] {
        var events: [BridgeEvent] = []
        let deadline = ProcessInfo.processInfo.systemUptime + seconds
        while ProcessInfo.processInfo.systemUptime < deadline {
            events += await session.takeEvents()
            if done(events) { break }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return events
    }
}
