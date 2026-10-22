import Foundation
import XCTest
@testable import FeishuBridgeSpike

/// The bridge resolves the Feishu/Lark client itself at launch, so the static
/// config needs no PID that goes stale on every client restart.
final class ClientProcessResolutionTests: XCTestCase {
    private let id = "test.synthetic", path = "/Applications/Synthetic.app"
    private let launched = Date(timeIntervalSince1970: 1_790_000_000)
    private func process(_ pid: Int32, id: String? = "test.synthetic", path: String? = "/Applications/Synthetic.app",
                         launchDate: Date? = Date(timeIntervalSince1970: 1_790_000_000), terminated: Bool = false) -> RunningClientProcess {
        RunningClientProcess(pid: pid, bundleIdentifier: id, bundlePath: path, launchDate: launchDate, isTerminated: terminated)
    }
    private func resolve(_ pid: Int32?, _ running: [RunningClientProcess]) -> Result<ResolvedClient, ClientResolutionFailure> {
        ClientProcessResolver.resolve(bundleIdentifier: id, bundlePath: path, explicitPid: pid, running: running)
    }

    func testTheOneRunningClientWithTheConfiguredBundleIdentifierAndPathIsResolved() {
        let others = [process(10, id: "other.app"), process(11, path: "/Applications/Copy/Synthetic.app"),
                      process(12, terminated: true), process(13, launchDate: nil), process(14, id: nil), process(15, path: nil)]
        XCTAssertEqual(resolve(nil, others + [process(42)]), .success(ResolvedClient(pid: 42, launchDate: launched)))
    }

    func testNoMatchingRunningClientIsClientNotRunning() {
        XCTAssertEqual(resolve(nil, []), .failure(.notRunning))
        XCTAssertEqual(resolve(nil, [process(10, id: "other.app"), process(12, terminated: true), process(11, path: "/Applications/Copy/Synthetic.app")]),
                       .failure(.notRunning), "another app, a terminated client or a copy at another path is not the configured client")
        XCTAssertEqual(resolve(42, []), .failure(.notRunning), "an explicit PID with no client running at all is still not running")
    }

    func testTwoRunningClientsAreNeverGuessedBetween() {
        XCTAssertEqual(resolve(nil, [process(42), process(43)]), .failure(.notUnique))
        XCTAssertEqual(resolve(43, [process(42), process(43)]), .success(ResolvedClient(pid: 43, launchDate: launched)),
                       "an explicit PID selects one of them")
    }

    func testAnExplicitPidMustBeTheRunningClient() {
        XCTAssertEqual(resolve(42, [process(42)]), .success(ResolvedClient(pid: 42, launchDate: launched)))
        XCTAssertEqual(resolve(41, [process(42)]), .failure(.pidMismatch), "a stale PID after a client restart is refused")
        XCTAssertEqual(resolve(10, [process(10, id: "other.app"), process(42)]), .failure(.pidMismatch), "a PID of another app is refused")
        XCTAssertEqual(resolve(11, [process(11, path: "/Applications/Copy/Synthetic.app"), process(42)]), .failure(.pidMismatch))
    }

    func testEachFailureHasItsOwnCodeAndIsANoJoinOutcome() throws {
        XCTAssertEqual(ClientResolutionFailure.allCases.map(\.rawValue), ["client_not_running", "client_pid_mismatch", "client_not_unique"])
        let config = try BridgeProcessConfiguration.decode(meetingFixture("spikes/feishu/fixtures/process/config-v2.json"), inspection: false)
        let binding = try XCTUnwrap(config.custody)
        for failure in ClientResolutionFailure.allCases {
            let outcome = try BridgeProcessOutcome(binding: binding, status: .clientUnavailable(failure), observedAt: "2026-10-22T10:00:00.000Z")
            XCTAssertEqual([outcome.outcome, outcome.reason], ["no_join_action", failure.rawValue])
            XCTAssertEqual(try BridgeProcessOutcome.decode(outcome.line().dropLast()), outcome, "the private outcome round-trips")
        }
        for (outcome, reason) in [("no_join_action", "client_crashed"), ("departure_unconfirmed", "client_not_running"), ("departure_confirmed", "client_not_running")] {
            XCTAssertThrowsError(try BridgeProcessOutcome(binding: binding, status: BridgeCleanupStatus(outcome: outcome, reason: reason), observedAt: "2026-10-22T10:00:00.000Z"))
        }
    }

    func testTheSystemListOnlyReportsProcessesWithTheRequestedBundleIdentifier() {
        let listed = ClientProcessResolver.systemProcesses(bundleIdentifier: "test.synthetic.never-installed-\(UUID().uuidString)")
        XCTAssertEqual(listed, [])
    }
}
