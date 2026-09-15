import XCTest
import Darwin
@testable import FeishuBridgeSpike

final class RuntimeMediaEndpointClientTests: XCTestCase, @unchecked Sendable {
    func testHeldReadTimeoutAndCancellationCloseAndReapTheSameSocket() async throws {
        for cancelled in [false, true] {
            let peer = try TimedLoopbackPeer(reply: nil)
            defer { XCTAssertTrue(peer.finish()) }
            let connection = try RuntimeMediaEndpointClient(endpoint: peer.endpoint)
            try await connection.open(deadline: ProcessInfo.processInfo.systemUptime + 1)
            try await connection.write(Data([1, 2, 3]), deadline: ProcessInfo.processInfo.systemUptime + 1)
            let read = Task { try await connection.read(maximum: 4096, deadline: cancelled ? nil : ProcessInfo.processInfo.systemUptime + 0.05) }
            if cancelled {
                let end = ProcessInfo.processInfo.systemUptime + 1
                while !(await connection.hasPendingRead()), ProcessInfo.processInfo.systemUptime < end { await Task.yield() }
                let pending = await connection.hasPendingRead(); XCTAssertTrue(pending)
                read.cancel()
            }
            do { _ = try await read.value; XCTFail("held read must not succeed") } catch {}
            let closed = await connection.close(); XCTAssertTrue(closed)
        }
    }
    func testEndpointAdmissionIsExplicitAndNeverFallsBackToPlaintextRemote() throws {
        for endpoint in ["tcp://127.0.0.1:9001", "tcp://[::1]:9001", "tls://runtime.example.test:443"] {
            XCTAssertNoThrow(try RuntimeMediaEndpointClient(endpoint: endpoint))
        }
        for endpoint in ["tcp://192.0.2.1:9001", "tcp://localhost:9001", "tcp://127.0.0.1:0", "https://runtime.example.test:443", "tls://user:secret@runtime.example.test:443", "tcp://127.0.0.1:9001/extra", "tcp://127.0.0.1:9001?token=x"] {
            XCTAssertThrowsError(try RuntimeMediaEndpointClient(endpoint: endpoint))
        }
    }
    func testActualLoopbackReadWriteAndCloseAreOwnedWithoutNativeResources() async throws {
        let peer = try TimedLoopbackPeer(reply: Data([7, 8, 9]))
        defer { XCTAssertTrue(peer.finish()) }
        let connection = try RuntimeMediaEndpointClient(endpoint: peer.endpoint)
        let deadline = ProcessInfo.processInfo.systemUptime + 1
        try await connection.open(deadline: deadline)
        try await connection.write(Data([1, 2, 3]), deadline: deadline)
        let received = try await connection.read(maximum: 4096, deadline: deadline)
        XCTAssertEqual(received, Data([7, 8, 9]))
        let firstClose = await connection.close(), secondClose = await connection.close()
        XCTAssertTrue(firstClose); XCTAssertTrue(secondClose)
    }
}

/// Exact owned loopback peer; no listener beyond this test, no inherited fd,
/// no device/provider/network outside 127.0.0.1. All syscalls have bounded polls.
final class TimedLoopbackPeer: @unchecked Sendable {
    let endpoint: String
    private let listener: Int32
    private let done = DispatchSemaphore(value: 0)
    init(reply: Data?) throws {
        let listening = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        listener = listening
        guard listening >= 0 else { throw TestFailure.failed }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listening, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0, Darwin.listen(listening, 1) == 0 else { Darwin.close(listening); throw TestFailure.failed }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listening, $0, &length) } }
        endpoint = "tcp://127.0.0.1:\(UInt16(bigEndian: address.sin_port))"
        let fd = listener, done = done
        Thread.detachNewThread {
            defer { done.signal() }
            var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            guard poll(&ready, 1, 1500) > 0 else { return }
            let client = accept(fd, nil, nil)
            guard client >= 0 else { return }
            defer { Darwin.close(client) }
            ready = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
            guard poll(&ready, 1, 1500) > 0 else { return }
            var input = [UInt8](repeating: 0, count: 3)
            guard Darwin.read(client, &input, input.count) > 0 else { return }
            if let reply { _ = reply.withUnsafeBytes { Darwin.write(client, $0.baseAddress, $0.count) } }
            else {
                ready = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
                if poll(&ready, 1, 1500) > 0 { _ = Darwin.read(client, &input, input.count) }
            }
        }
    }
    func finish() -> Bool { let reaped = done.wait(timeout: .now() + 2) == .success; Darwin.close(listener); return reaped }
}
