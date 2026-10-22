import Foundation
import AppKit

/// One running application as the bridge sees it at launch.
public struct RunningClientProcess: Equatable, Sendable {
    public let pid: Int32
    public let bundleIdentifier: String?, bundlePath: String?
    public let launchDate: Date?
    public let isTerminated: Bool
    public init(pid: Int32, bundleIdentifier: String?, bundlePath: String?, launchDate: Date?, isTerminated: Bool) {
        self.pid = pid; self.bundleIdentifier = bundleIdentifier; self.bundlePath = bundlePath
        self.launchDate = launchDate; self.isTerminated = isTerminated
    }
}

/// The Feishu/Lark client this bridge generation drives, resolved once at launch.
public struct ResolvedClient: Equatable, Sendable {
    public let pid: Int32
    public let launchDate: Date
}

/// Why no client could be bound. Each is reported before any UI action, as a
/// no-join private outcome and as the bridge's exit diagnostic.
public enum ClientResolutionFailure: String, Error, CaseIterable, Sendable {
    /// No running process has the configured bundle identifier and path.
    case notRunning = "client_not_running"
    /// The configured PID is not that running client (for example, stale after a restart).
    case pidMismatch = "client_pid_mismatch"
    /// More than one such client runs and no PID selects one.
    case notUnique = "client_not_unique"
}

public enum ClientProcessResolver {
    /// Exact bundle identifier and bundle path, a live process and a known
    /// launch time: the same identity the AX and capture owners re-check.
    public static func resolve(bundleIdentifier: String, bundlePath: String, explicitPid: Int32?,
                               running: [RunningClientProcess]) -> Result<ResolvedClient, ClientResolutionFailure> {
        let candidates = running.compactMap { process -> ResolvedClient? in
            guard !process.isTerminated, process.bundleIdentifier == bundleIdentifier, process.bundlePath == bundlePath,
                  let launchDate = process.launchDate else { return nil }
            return ResolvedClient(pid: process.pid, launchDate: launchDate)
        }
        if let explicitPid {
            if let match = candidates.first(where: { $0.pid == explicitPid }) { return .success(match) }
            return .failure(candidates.isEmpty ? .notRunning : .pidMismatch)
        }
        guard let only = candidates.first else { return .failure(.notRunning) }
        return candidates.count == 1 ? .success(only) : .failure(.notUnique)
    }

    /// The running applications with this bundle identifier, as AppKit reports them now.
    public static func systemProcesses(bundleIdentifier: String) -> [RunningClientProcess] {
        NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).map {
            RunningClientProcess(pid: $0.processIdentifier, bundleIdentifier: $0.bundleIdentifier, bundlePath: $0.bundleURL?.path,
                                 launchDate: $0.launchDate, isTerminated: $0.isTerminated)
        }
    }
}
