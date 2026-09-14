import XCTest
import Darwin
@testable import FeishuBridgeSpike

final class BridgeIOTests: XCTestCase {
    func testReapTimeoutClosesEvidenceReportsUnconfirmedAndNeverOverlapsUI() throws {
        for malformedInput in [false, true] {
            let cancellation = BridgeCancellation()
            let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting()])
            let sink = MemoryEvidenceSink()
            let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink, output: { _ in })
            let join = BridgeCommandMessage(sessionId: "s", commandId: "join", command: .join(meetingOccurrenceId: "900000001@2026-09-02T14:00:00Z", meetingNo: "900000001", leaseId: "l"))
            try process.accept(join)
            let input = UnreapedInput(cancellation: cancellation, malformedInput: malformedInput)
            var cleanupReports = 0
            XCTAssertThrowsError(try runBridgeControl(process: process, input: input, cancellation: cancellation,
                clock: SystemBridgeClock(), observationInterval: 10, cleanupFailed: { cleanupReports += 1 })) {
                XCTAssertEqual($0 as? BridgeProcessError, malformedInput ? .invalidInput : .closed)
            }
            XCTAssertTrue(sink.closed)
            XCTAssertEqual(cleanupReports, 1)
            XCTAssertTrue(cancellation.isCancelled)
            XCTAssertEqual(driver.pressed.count, 1, "unreaped worker must not overlap a leave action")
            XCTAssertThrowsError(try process.accept(join), "failed reaping must permanently close the owner")
        }
    }

    func testEOFStillCancelsWhenBoundedInputQueueIsFull() throws {
        var fds: [Int32] = [0, 0]; XCTAssertEqual(pipe(&fds), 0)
        defer { Darwin.close(fds[0]) }
        let cancellation = BridgeCancellation()
        let input = BridgeInputPump(fd: fds[0], cancellation: cancellation)
        input.start()
        let bytes = [UInt8](repeating: 65, count: 65_536)
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fds[1], buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw TestFailure.failed }; offset += count
            }
        }
        Darwin.close(fds[1])
        let end = ProcessInfo.processInfo.systemUptime + 0.5
        while !cancellation.isCancelled && ProcessInfo.processInfo.systemUptime < end { Thread.sleep(forTimeInterval: 0.01) }
        XCTAssertTrue(cancellation.isCancelled)
        XCTAssertTrue(input.reachedEOF)
        XCTAssertTrue(input.finish(timeout: 1))
    }

    func testSerializedProductionLoopReapsInputAndCleansUpOnEOFAndTermination() throws {
        for eof in [true, false] {
            var fds: [Int32] = [0, 0]; XCTAssertEqual(pipe(&fds), 0)
            defer { Darwin.close(fds[0]); Darwin.close(fds[1]) }
            let cancellation = BridgeCancellation()
            let sink = MemoryEvidenceSink()
            let driver = FakeAccessibilityDriver(snapshots: [FakeTree.idleWithJoinSurface(), FakeTree.inMeeting(), FakeTree.inMeeting(), FakeTree.idleWithJoinSurface()])
            let didJoin = DispatchSemaphore(value: 0)
            let finished = DispatchSemaphore(value: 0)
            let writeFd = fds[1]
            var events: [BridgeEventMessage] = []
            let process = BridgeProcess(driver: driver, labels: .bundled, clock: SystemBridgeClock(), sink: sink, output: {
                let event = try JSONDecoder().decode(BridgeEventMessage.self, from: $0)
                events.append(event)
                if case .commandResult(commandId: "join", outcome: .ok, detail: _) = event.event { didJoin.signal() }
            })
            let command = BridgeCommandMessage(sessionId: "session", commandId: "join", command: .join(meetingOccurrenceId: "900000001@2026-09-02T14:00:00Z", meetingNo: "900000001", leaseId: "lease"))
            let bytes = try JSONEncoder().encode(command) + Data([10])
            DispatchQueue.global().async {
                _ = bytes.withUnsafeBytes { Darwin.write(writeFd, $0.baseAddress, $0.count) }
                _ = didJoin.wait(timeout: .now() + 1)
                if eof { Darwin.close(writeFd) } else { cancellation.cancel() }
                finished.signal()
            }
            let input = BridgeInputPump(fd: fds[0], cancellation: cancellation)
            try runBridgeControl(process: process, input: input, cancellation: cancellation, clock: SystemBridgeClock(), observationInterval: 10)
            XCTAssertEqual(finished.wait(timeout: .now() + 1), .success)
            XCTAssertTrue(sink.closed)
            XCTAssertTrue(events.contains { if case .left(reason: .removed) = $0.event { true } else { false } })
            XCTAssertTrue(input.finish(timeout: 0.1))
            XCTAssertEqual(events.map(\.sequence), Array(1...events.count))
            if eof { fds[1] = -1 }
        }
    }

    func testInputFragmentsEOFAndCancellationAreBounded() throws {
        var fds: [Int32] = [0, 0]; XCTAssertEqual(pipe(&fds), 0)
        defer { Darwin.close(fds[0]) }
        let cancellation = BridgeCancellation()
        let input = BridgeInputPump(fd: fds[0], cancellation: cancellation)
        input.start()
        let bytes = Array("fragment".utf8)
        XCTAssertEqual(bytes.withUnsafeBytes { Darwin.write(fds[1], $0.baseAddress, $0.count) }, bytes.count)
        XCTAssertEqual(input.next(wait: 1), Data(bytes))
        Darwin.close(fds[1])
        XCTAssertNil(input.next(wait: 1))
        XCTAssertTrue(cancellation.isCancelled)
        XCTAssertTrue(input.finish(timeout: 1))
        XCTAssertTrue(input.reachedEOF)
    }

    func testStdoutBackpressureAndCancellationFailInsteadOfBlockingForever() throws {
        var fds: [Int32] = [0, 0]; XCTAssertEqual(pipe(&fds), 0)
        defer { Darwin.close(fds[0]); Darwin.close(fds[1]) }
        let cancellation = BridgeCancellation()
        let writer = try BridgeOutputWriter(fd: fds[1], cancellation: cancellation, deadline: 0.05)
        let start = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try writer.write(Data(repeating: 65, count: 131_072)))
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 1)
        cancellation.cancel()
        XCTAssertThrowsError(try writer.write(Data([10])))
    }
}

private final class UnreapedInput: BridgeInputSource {
    let cancellation: BridgeCancellation
    let malformedInput: Bool
    init(cancellation: BridgeCancellation, malformedInput: Bool) { self.cancellation = cancellation; self.malformedInput = malformedInput }
    var reachedEOF: Bool { false }
    var failed: Bool { false }
    func start() { if !malformedInput { cancellation.cancel() } }
    func next(wait: TimeInterval) -> Data? { Data("{\n".utf8) }
    func finish(timeout: TimeInterval) -> Bool { cancellation.cancel(); return false }
}
