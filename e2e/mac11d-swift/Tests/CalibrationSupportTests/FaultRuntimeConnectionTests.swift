import XCTest
import Foundation
import FeishuBridgeSpike
@testable import CalibrationSupport

final class FaultRuntimeConnectionTests: XCTestCase {
    // Removing the first-connection/second-pair gate must break this test.
    func testSecondClockPairFailsBeforeForwardingForBothShippedEnvelopes() async throws {
        for version in [2, 3] {
            let base = FaultTestConnection()
            let signals = FaultTestSignals()
            let state = FaultConnectionState(connectionFactory: { _ in base })
            let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { true },
                captureProgress: { true }, onFault: {
                    XCTAssertEqual(state.snapshot.pendingHeldReads, 1)
                    XCTAssertEqual(state.snapshot.releasedHeldReads, 0)
                    signals.fault()
                })
            try await connection.open(deadline: deadline())
            let read = Task { try await connection.read(maximum: 6, deadline: nil) }
            await waitForHeldRead(state)
            let pair = try clockPair(version: version)
            try await connection.write(pair, deadline: deadline())
            do {
                try await connection.write(pair, deadline: deadline())
                XCTFail("periodic pair must fail before underlying write")
            } catch { XCTAssertEqual(error as? RuntimeMediaConnectionError, .unavailable) }
            XCTAssertEqual(base.writes, [pair])
            XCTAssertEqual(signals.faults, 1)
            XCTAssertEqual(state.snapshot.clockPairWrites, 1)
            XCTAssertEqual(state.snapshot.injectedWriteFailures, 1)
            connection.cancel()
            let closed = await connection.close()
            XCTAssertTrue(closed)
            await assertClosed(read)
            XCTAssertEqual(state.snapshot.heldReads, 1)
            XCTAssertEqual(state.snapshot.releasedHeldReads, 1)
            XCTAssertEqual(state.snapshot.pendingHeldReads, 0)
        }
    }

    // Selecting a write fault without an actually parked reader must break this test.
    func testSecondClockPairDoesNotInjectWhenCaptureProgressHasNoHeldRead() async throws {
        let base = FaultTestConnection()
        let signals = FaultTestSignals()
        let state = FaultConnectionState(connectionFactory: { _ in base })
        let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { false },
            captureProgress: { true }, onFault: { signals.fault() })
        let pair = try clockPair(version: 3)
        try await connection.write(pair, deadline: deadline())
        try await connection.write(pair, deadline: deadline())
        XCTAssertEqual(base.writes, [pair, pair])
        XCTAssertEqual(state.snapshot.clockPairWrites, 2)
        XCTAssertEqual(state.snapshot.injectedWriteFailures, 0)
        XCTAssertEqual(state.snapshot.heldReads, 0)
        XCTAssertEqual(signals.faults, 0)
    }

    // Treating a released reader as still parked must break this test.
    func testSecondClockPairDoesNotInjectAfterHeldReadExpires() async throws {
        let base = FaultTestConnection()
        let signals = FaultTestSignals()
        let state = FaultConnectionState(connectionFactory: { _ in base })
        let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { true },
            captureProgress: { true }, onFault: { signals.fault() })
        let pair = try clockPair(version: 2)
        try await connection.write(pair, deadline: deadline())
        do {
            _ = try await connection.read(maximum: 6, deadline: ProcessInfo.processInfo.systemUptime + 0.03)
            XCTFail("held read must expire before second pair")
        } catch { XCTAssertEqual(error as? RuntimeMediaConnectionError, .timedOut) }
        XCTAssertEqual(state.snapshot.pendingHeldReads, 0)
        XCTAssertEqual(state.snapshot.releasedHeldReads, 1)
        try await connection.write(pair, deadline: deadline())
        XCTAssertEqual(base.writes, [pair, pair])
        XCTAssertEqual(state.snapshot.clockPairWrites, 2)
        XCTAssertEqual(state.snapshot.injectedWriteFailures, 0)
        XCTAssertEqual(signals.faults, 0)
        let forwarded = try await connection.read(maximum: 6, deadline: deadline())
        XCTAssertEqual(forwarded, Data([12, 34]))
        XCTAssertEqual(state.snapshot.heldReads, 1)
        let closed = await connection.close()
        XCTAssertTrue(closed)
    }

    // Holding the authentication reads, or touching their bytes, must break this test.
    func testPreCaptureReadsForwardUnchangedAndOnlyOneLaterReadIsHeld() async throws {
        let base = FaultTestConnection()
        let signals = FaultTestSignals()
        let state = FaultConnectionState(connectionFactory: { _ in base })
        let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { signals.ready },
            captureProgress: { true }, onFault: {})
        for _ in 0..<3 {
            let bytes = try await connection.read(maximum: 6, deadline: deadline())
            XCTAssertEqual(bytes, Data([12, 34]))
        }
        XCTAssertEqual(state.snapshot.heldReads, 0)
        signals.setReady()
        let held = Task { try await connection.read(maximum: 6, deadline: nil) }
        await waitForHeldRead(state)
        connection.cancel()
        let closed = await connection.close()
        XCTAssertTrue(closed)
        await assertClosed(held)
        XCTAssertEqual(base.reads, 3)
    }

    // Injecting after a missed progress barrier, or on a later connection, must break this test.
    func testFaultRequiresCaptureProgressOnExactlySecondPairAndLaterConnectionsForward() async throws {
        let base = FaultTestConnection()
        let signals = FaultTestSignals()
        let state = FaultConnectionState(connectionFactory: { _ in base })
        let first = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { true },
            captureProgress: { signals.ready }, onFault: { signals.fault() })
        let held = Task { try await first.read(maximum: 6, deadline: nil) }
        await waitForHeldRead(state)
        let pair = try clockPair(version: 3)
        try await first.write(pair, deadline: deadline())
        try await first.write(pair, deadline: deadline())
        signals.setReady()
        try await first.write(pair, deadline: deadline())
        first.cancel()
        let firstClosed = await first.close()
        XCTAssertTrue(firstClosed)
        await assertClosed(held)
        let second = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { true },
            captureProgress: { true }, onFault: { signals.fault() })
        try await second.open(deadline: deadline())
        try await second.write(pair, deadline: deadline())
        try await second.write(pair, deadline: deadline())
        let bytes = try await second.read(maximum: 6, deadline: nil)
        XCTAssertEqual(bytes, Data([12, 34]))
        XCTAssertEqual(state.snapshot.connectionsCreated, 2)
        XCTAssertEqual(state.snapshot.openedConnections, 1)
        XCTAssertEqual(state.snapshot.clockPairWrites, 5)
        XCTAssertEqual(state.snapshot.heldReads, 1)
        XCTAssertEqual(signals.faults, 0)
    }

    // Counting attempted writes/opens as successful, or treating malformed headers as timed records, must break this test.
    func testCountersRecordOnlyCompletedWritesAndValidEnvelopeHeaders() async throws {
        let base = FaultTestConnection()
        let state = FaultConnectionState(connectionFactory: { _ in base })
        let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { false }, captureProgress: { false }, onFault: {})
        base.fail = true
        do { try await connection.open(deadline: deadline()); XCTFail("open must fail") } catch {}
        do { try await connection.write(try clockPair(version: 2), deadline: deadline()); XCTFail("write must fail") } catch {}
        XCTAssertEqual(state.snapshot.openedConnections, 0)
        XCTAssertEqual(state.snapshot.clockPairWrites, 0)
        base.fail = false
        var malformed = try clockPair(version: 2)
        malformed[4] = 3 // MED2 with wrong version.
        try await connection.write(malformed, deadline: deadline())
        malformed = try clockPair(version: 3)
        malformed[9] &+= 1 // Declared body length does not match.
        try await connection.write(malformed, deadline: deadline())
        try await connection.write(try capture(version: 2), deadline: deadline())
        try await connection.write(try capture(version: 3), deadline: deadline())
        try await connection.write(try clockPair(version: 2), deadline: deadline())
        XCTAssertEqual(state.snapshot.captureWrites, 2)
        XCTAssertEqual(state.snapshot.clockPairWrites, 1)
        XCTAssertEqual(state.snapshot.injectedWriteFailures, 0)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state.snapshot)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), Set(["connectionsCreated", "openedConnections", "captureWrites", "clockPairWrites", "injectedWriteFailures", "heldReads", "releasedHeldReads", "pendingHeldReads"]))
    }

    // Losing either the underlying close fact or task cancellation must break this test.
    func testCancelledHeldReadIsJoinedAndUnderlyingFailedCloseStaysUnconfirmed() async throws {
        let base = FaultTestConnection()
        base.closeConfirmed = false
        let state = FaultConnectionState(connectionFactory: { _ in base })
        let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { true }, captureProgress: { true }, onFault: {})
        let read = Task { try await connection.read(maximum: 6, deadline: nil) }
        await waitForHeldRead(state)
        read.cancel()
        let closed = await connection.close()
        XCTAssertFalse(closed)
        await assertClosed(read)
        XCTAssertEqual(state.snapshot.pendingHeldReads, 0)
        XCTAssertEqual(state.snapshot.releasedHeldReads, 1)
    }

    // An unbounded held reader, or ignoring the caller's earlier deadline, must break this test.
    func testHeldReadUsesRealBoundAndHonorsEarlierDeadline() async throws {
        for budget: TimeInterval? in [0.04, nil] {
            let base = FaultTestConnection()
            let state = FaultConnectionState(connectionFactory: { _ in base })
            let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", captureReady: { true }, captureProgress: { true }, onFault: {})
            let start = ProcessInfo.processInfo.systemUptime
            do {
                _ = try await connection.read(maximum: 6, deadline: budget.map { start + $0 })
                XCTFail("held read must have a real deadline")
            } catch { XCTAssertEqual(error as? RuntimeMediaConnectionError, .timedOut) }
            XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, budget == nil ? 2.2 : 0.3)
            let closed = await connection.close()
            XCTAssertTrue(closed)
            XCTAssertEqual(state.snapshot.pendingHeldReads, 0)
            XCTAssertEqual(state.snapshot.releasedHeldReads, 1)
        }
    }

    private func waitForHeldRead(_ state: FaultConnectionState) async {
        let limit = ProcessInfo.processInfo.systemUptime + 0.3
        while state.snapshot.pendingHeldReads == 0 && ProcessInfo.processInfo.systemUptime < limit {
            try? await Task.sleep(for: .milliseconds(1))
        }
        XCTAssertEqual(state.snapshot.pendingHeldReads, 1)
    }
    private func assertClosed(_ read: Task<Data, Error>) async {
        do { _ = try await read.value; XCTFail("held read must end as closed") }
        catch { XCTAssertEqual(error as? RuntimeMediaConnectionError, .closed) }
    }
    private func deadline() -> TimeInterval { ProcessInfo.processInfo.systemUptime + 1 }
    private func clockPair(version: Int) throws -> Data {
        let sampler = try CaptureClockPairSampler(clockDomainId: "component-clock")
        let bytes = try RuntimeMediaCodecV2.clockPair(session: 1, pair: sampler.sample())
        return version == 3 ? try RuntimeMediaCodecV3.envelope(bytes) : bytes
    }
    private func capture(version: Int) throws -> Data {
        func be<T: FixedWidthInteger>(_ value: T) -> Data {
            var number = value.bigEndian
            return withUnsafeBytes(of: &number) { Data($0) }
        }
        let timing = Data([1, 0, 2, 0]) + be(UInt64(1)) + be(UInt64(1)) + be(UInt64(0))
            + be(UInt32(1)) + be(UInt64(0)) + be(UInt64(24_000)) + be(UInt32(24_000))
            + be(UInt32(24_000)) + Data(count: 32)
        let bytes = try RuntimeMediaCodecV2.capture(session: 1, timing: timing, pcm: Data([0, 0]))
        return version == 3 ? try RuntimeMediaCodecV3.envelope(bytes) : bytes
    }
}

private final class FaultTestSignals: @unchecked Sendable {
    private let lock = NSLock()
    private var readyValue = false, faultValue = 0
    var ready: Bool { lock.withLock { readyValue } }
    var faults: Int { lock.withLock { faultValue } }
    func setReady() { lock.withLock { readyValue = true } }
    func fault() { lock.withLock { faultValue += 1 } }
}

/// Component-only transport double: no authentication acknowledgement is created.
private final class FaultTestConnection: RuntimeMediaConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var writeValues: [Data] = [], readCount = 0
    var fail = false, closeConfirmed = true
    var writes: [Data] { lock.withLock { writeValues } }
    var reads: Int { lock.withLock { readCount } }
    func open(deadline: TimeInterval) async throws { if fail { throw RuntimeMediaConnectionError.unavailable } }
    func write(_ data: Data, deadline: TimeInterval) async throws {
        if fail { throw RuntimeMediaConnectionError.unavailable }
        lock.withLock { writeValues.append(data) }
    }
    func read(maximum: Int, deadline: TimeInterval?) async throws -> Data {
        lock.withLock { readCount += 1 }
        return Data([12, 34])
    }
    func close() async -> Bool { closeConfirmed }
    func cancel() {}
}
