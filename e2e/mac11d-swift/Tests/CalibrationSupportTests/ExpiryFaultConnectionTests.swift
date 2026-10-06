import XCTest
import Foundation
import FeishuBridgeSpike
@testable import CalibrationSupport

final class ExpiryFaultConnectionTests: XCTestCase {
    // Removing the real expiry or completed post-expiry capture gate breaks this test.
    func testFaultFollowsRealExpiryAndCompletedCaptureForBothEnvelopes() async throws {
        for version in [2, 3] {
            let base = ExpiryTestConnection(), signals = ExpiryTestSignals()
            let state = ExpiryFaultConnectionState(connectionFactory: { _ in base })
            let expiry = ProcessInfo.processInfo.systemUptime + 0.08
            let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", expiryDeadline: expiry,
                progress: { true }, onFault: {
                    XCTAssertGreaterThanOrEqual(ProcessInfo.processInfo.systemUptime, expiry)
                    XCTAssertEqual(state.snapshot.expiredCaptureWrites, 1)
                    XCTAssertEqual(base.cancellations, 0)
                    signals.fault()
                })
            try await connection.open(deadline: deadline())
            let pair = try clockPair(version: version), capture = try capture(version: version)
            try await connection.write(pair, deadline: deadline())
            try await connection.write(capture, deadline: deadline())
            try await connection.write(pair, deadline: deadline())
            XCTAssertEqual(signals.faults, 0)
            try await Task.sleep(for: .seconds(max(0, expiry - ProcessInfo.processInfo.systemUptime) + 0.01))
            try await connection.write(pair, deadline: deadline())
            XCTAssertEqual(state.snapshot.expiredCaptureWrites, 0)
            try await connection.write(capture, deadline: deadline())
            do { try await connection.write(pair, deadline: deadline()); XCTFail("expired periodic pair must fail") }
            catch { XCTAssertEqual(error as? RuntimeMediaConnectionError, .unavailable) }
            XCTAssertEqual(base.writes, [pair, capture, pair, pair, capture])
            XCTAssertEqual(state.snapshot.connectionsCreated, 1)
            XCTAssertEqual(state.snapshot.openedConnections, 1)
            XCTAssertEqual(state.snapshot.captureWrites, 2)
            XCTAssertEqual(state.snapshot.clockPairWrites, 3)
            XCTAssertEqual(state.snapshot.injectedWriteFailures, 1)
            XCTAssertEqual(signals.faults, 1)
            try await connection.write(pair, deadline: deadline())
            XCTAssertEqual(signals.faults, 1)
            connection.cancel()
            let closed = await connection.close()
            XCTAssertTrue(closed)
        }
    }

    // An external progress signal alone must not select the initial clock packet.
    func testInitialPairCannotFaultEvenWhenProgressIsTrueAfterExpiry() async throws {
        let base = ExpiryTestConnection(), signals = ExpiryTestSignals()
        let state = ExpiryFaultConnectionState(connectionFactory: { _ in base })
        let expiry = ProcessInfo.processInfo.systemUptime + 0.03
        let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", expiryDeadline: expiry,
            progress: { true }, onFault: { signals.fault() })
        try await Task.sleep(for: .milliseconds(40))
        let pair = try clockPair(version: 3)
        try await connection.write(pair, deadline: deadline())
        try await connection.write(pair, deadline: deadline())
        XCTAssertEqual(state.snapshot.injectedWriteFailures, 0)
        XCTAssertEqual(signals.faults, 0)
    }

    // Omitting the caller's actual captured-progress barrier must break this test.
    func testExpiredTrafficStillWaitsForProgressAndLaterAdmissionAttemptsRemainVisible() async throws {
        let base = ExpiryTestConnection(), signals = ExpiryTestSignals()
        let state = ExpiryFaultConnectionState(connectionFactory: { _ in base })
        let expiry = ProcessInfo.processInfo.systemUptime + 0.03
        let first = try state.create(endpoint: "tcp://127.0.0.1:1234", expiryDeadline: expiry,
            progress: { signals.ready }, onFault: { signals.fault() })
        let pair = try clockPair(version: 3), capture = try capture(version: 3)
        try await first.write(pair, deadline: deadline())
        try await Task.sleep(for: .milliseconds(40))
        try await first.write(capture, deadline: deadline())
        try await first.write(pair, deadline: deadline())
        XCTAssertEqual(signals.faults, 0)
        signals.setReady()
        do { try await first.write(pair, deadline: deadline()); XCTFail("ready expired write must fail") }
        catch { XCTAssertEqual(error as? RuntimeMediaConnectionError, .unavailable) }
        let second = try state.create(endpoint: "tcp://127.0.0.1:1234", expiryDeadline: expiry,
            progress: { true }, onFault: { signals.fault() })
        try await second.open(deadline: deadline())
        try await second.write(pair, deadline: deadline())
        try await second.write(capture, deadline: deadline())
        try await second.write(pair, deadline: deadline())
        XCTAssertEqual(state.snapshot.connectionsCreated, 2)
        XCTAssertEqual(state.snapshot.openedConnections, 1)
        XCTAssertEqual(state.snapshot.expiredCaptureWrites, 2)
        XCTAssertEqual(state.snapshot.injectedWriteFailures, 1)
        XCTAssertEqual(signals.faults, 1)
    }

    // Counting failed writes, or interpreting malformed envelope headers, must break this test.
    func testCountsOnlyCompletedWritesAndValidHeaders() async throws {
        let base = ExpiryTestConnection()
        let state = ExpiryFaultConnectionState(connectionFactory: { _ in base })
        let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", expiryDeadline: deadline(),
            progress: { false }, onFault: {})
        base.fail = true
        do { try await connection.open(deadline: deadline()); XCTFail("open must fail") } catch {}
        do { try await connection.write(try capture(version: 3), deadline: deadline()); XCTFail("write must fail") } catch {}
        XCTAssertEqual(state.snapshot.openedConnections, 0)
        XCTAssertEqual(state.snapshot.captureWrites, 0)
        base.fail = false
        var wrongTag = try clockPair(version: 2); wrongTag[4] = 3
        var wrongLength = try capture(version: 3); wrongLength[9] &+= 1
        try await connection.write(wrongTag, deadline: deadline())
        try await connection.write(wrongLength, deadline: deadline())
        try await connection.write(Data([77, 69]), deadline: deadline())
        XCTAssertEqual(state.snapshot.clockPairWrites, 0)
        XCTAssertEqual(state.snapshot.captureWrites, 0)
        try await connection.write(try capture(version: 2), deadline: deadline())
        try await connection.write(try clockPair(version: 3), deadline: deadline())
        XCTAssertEqual(state.snapshot.captureWrites, 1)
        XCTAssertEqual(state.snapshot.clockPairWrites, 1)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state.snapshot)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), Set(["connectionsCreated", "openedConnections", "captureWrites", "clockPairWrites", "injectedWriteFailures", "expiredCaptureWrites"]))
    }

    // Forwarding invalid initial deadlines to a socket would mask a bad fixture.
    func testInvalidOrAlreadyExpiredInitialDeadlineIsRejectedBeforeFactory() throws {
        for expiry in [-1, 0, .nan, .infinity, -.infinity, ProcessInfo.processInfo.systemUptime - 1] {
            let base = ExpiryTestConnection()
            let state = ExpiryFaultConnectionState(connectionFactory: { _ in XCTFail("invalid deadline reached factory"); return base })
            XCTAssertThrowsError(try state.create(endpoint: "tcp://127.0.0.1:1234", expiryDeadline: expiry,
                progress: { true }, onFault: {}))
            XCTAssertEqual(state.snapshot.connectionsCreated, 0)
        }
    }

    // Disguising a failed factory as no owner admission attempt must break this test.
    func testConnectionCreationAttemptRemainsCountedWhenFactoryThrows() throws {
        let state = ExpiryFaultConnectionState(connectionFactory: { _ in throw RuntimeMediaConnectionError.invalidEndpoint })
        XCTAssertThrowsError(try state.create(endpoint: "invalid", expiryDeadline: deadline(), progress: { true }, onFault: {}))
        XCTAssertEqual(state.snapshot.connectionsCreated, 1)
        XCTAssertEqual(state.snapshot.openedConnections, 0)
    }

    // Changing read/auth bytes, or confirming an underlying failed close, must break this test.
    func testOpaqueTrafficAndCleanupAreForwardedWithoutAuthenticationSubstitution() async throws {
        let base = ExpiryTestConnection(); base.closeConfirmed = false
        let state = ExpiryFaultConnectionState(connectionFactory: { _ in base })
        let connection = try state.create(endpoint: "tcp://127.0.0.1:1234", expiryDeadline: deadline(), progress: { true }, onFault: {})
        let opaque = Data([31, 41, 59])
        try await connection.write(opaque, deadline: deadline())
        let bytes = try await connection.read(maximum: 6, deadline: nil)
        XCTAssertEqual(bytes, Data([12, 34]))
        XCTAssertEqual(base.writes, [opaque])
        XCTAssertEqual(state.snapshot.captureWrites, 0)
        XCTAssertEqual(state.snapshot.clockPairWrites, 0)
        connection.cancel()
        do { try await connection.write(opaque, deadline: deadline()); XCTFail("cancelled write must fail") }
        catch { XCTAssertEqual(error as? RuntimeMediaConnectionError, .closed) }
        let closed = await connection.close()
        XCTAssertFalse(closed)
        XCTAssertEqual(base.cancellations, 1)
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

private final class ExpiryTestSignals: @unchecked Sendable {
    private let lock = NSLock()
    private var readyValue = false, faultValue = 0
    var ready: Bool { lock.withLock { readyValue } }
    var faults: Int { lock.withLock { faultValue } }
    func setReady() { lock.withLock { readyValue = true } }
    func fault() { lock.withLock { faultValue += 1 } }
}

/// Component-only transport double; it never generates an accepted auth ACK.
private final class ExpiryTestConnection: RuntimeMediaConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var writeValues: [Data] = [], cancellationCount = 0
    var fail = false, closeConfirmed = true
    var writes: [Data] { lock.withLock { writeValues } }
    var cancellations: Int { lock.withLock { cancellationCount } }
    func open(deadline: TimeInterval) async throws { if fail { throw RuntimeMediaConnectionError.unavailable } }
    func write(_ data: Data, deadline: TimeInterval) async throws {
        if fail { throw RuntimeMediaConnectionError.unavailable }
        lock.withLock { writeValues.append(data) }
    }
    func read(maximum: Int, deadline: TimeInterval?) async throws -> Data { Data([12, 34]) }
    func close() async -> Bool { closeConfirmed }
    func cancel() { lock.withLock { cancellationCount += 1 } }
}
