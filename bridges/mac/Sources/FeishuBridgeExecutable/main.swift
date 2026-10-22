import Foundation
import Darwin
import AppKit
import FeishuBridgeSpike

func diagnostic(_ code: String) {
    let flags = fcntl(STDERR_FILENO, F_GETFL)
    guard flags >= 0, fcntl(STDERR_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else { return }
    _ = (code + "\n").utf8CString.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count - 1) }
}

func inspect(_ node: AccessibilityNode) -> [String: Any] {
    var value: [String: Any] = ["role": node.role, "enabled": node.isEnabled, "children": node.children.map(inspect)]
    if let identifier = node.identifier { value["identifier"] = identifier }
    if let title = node.title { value["title"] = title }
    if let text = node.value { value["value"] = text }
    return value
}

func run(_ configuration: BridgeProcessConfiguration, inspection: Bool) throws {
    let cancellation = BridgeCancellation()
    signal(SIGPIPE, SIG_IGN)
    let outcomeWriter = try configuration.custody == nil ? nil : BridgeOutcomeWriter()
    defer { outcomeWriter?.close() }
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
    let signals = [SIGTERM, SIGINT].map { number in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { cancellation.cancel() }; source.resume(); return source
    }
    defer { signals.forEach { $0.cancel() } }
    let clock = SystemBridgeClock()
    // Resolve the client once, before any AX handle, stdout or media: no
    // running client (or a stale/foreign configured PID) is a no-join outcome
    // and an exit diagnostic, never a crash or a hang. Capture binds the
    // resolved launch time, so PID recycling can only make it fail its
    // launch-date check, never follow a later process by PID alone.
    let client: ResolvedClient
    switch ClientProcessResolver.resolve(bundleIdentifier: configuration.bundleIdentifier, bundlePath: configuration.bundlePath,
                                         explicitPid: configuration.pid,
                                         running: ClientProcessResolver.systemProcesses(bundleIdentifier: configuration.bundleIdentifier)) {
    case .success(let resolved): client = resolved
    case .failure(let failure):
        // A failed private write leaves the outcome missing, which the parent
        // already treats as unresolved custody; the diagnostic stays the cause.
        if let binding = configuration.custody, let writer = outcomeWriter {
            _ = try? writer.write(BridgeProcessOutcome(binding: binding, status: .clientUnavailable(failure), observedAt: clock.now()))
        }
        throw failure
    }
    let captureLaunchDate = configuration.audio == nil ? nil : client.launchDate
    let backend = SystemAXBackend(pid: client.pid, bundlePath: configuration.bundlePath,
                                  bundleId: configuration.bundleIdentifier, build: configuration.bundleVersion,
                                  callTimeout: configuration.axCallTimeout)
    let driver = AXAccessibilityDriver(backend: backend, clock: clock, cancellation: cancellation,
                                       maxNodes: inspection ? 128 : 512, maxStringBytes: inspection ? 1024 : 4096,
                                       readDeadline: min(configuration.actionDeadline, 2),
                                       measured: configuration.speakerSelectors, labels: configuration.labels)
    if inspection {
        let sink = try FileEvidenceSink(root: configuration.evidenceRoot, filename: "inspection-" + UUID().uuidString + ".jsonl", maxLineBytes: 1_048_576)
        defer { try? sink.close() }
        guard let tree = driver.snapshot(waitingUpTo: 0) else { throw BridgeProcessError.invalidInput }
        try sink.append(JSONSerialization.data(withJSONObject: ["schema": "feishu-ax-inspection/v1", "observedAt": clock.now(), "tree": inspect(tree)]) + Data([10]))
        try sink.close(); diagnostic("inspection_saved_private"); return
    }
    let sink = try FileEvidenceSink(root: configuration.evidenceRoot)
    defer { try? sink.close() }
    let writer = try BridgeOutputWriter(fd: STDOUT_FILENO, cancellation: cancellation)
    let timingClock = try configuration.audio == nil ? nil : CaptureClockPairSampler()
    let timedMedia: TimedMediaControlOwner?
    if let audio = configuration.audio, let timingClock {
        guard let captureLaunchDate else { throw BridgeProcessError.invalidInput }
        let request = try CaptureRequest(pid: client.pid, bundlePath: configuration.bundlePath,
            bundleIdentifier: configuration.bundleIdentifier, build: configuration.bundleVersion,
            launchDate: captureLaunchDate, displayID: audio.captureDisplayId)
        let session = TimedMediaSession(clock: timingClock,
            playbackRequest: try PlaybackRequest(outputDeviceUID: audio.outputDeviceUid),
            captureRequest: { request }, nowUnixMs: {
                let milliseconds = Date().timeIntervalSince1970 * 1000
                guard milliseconds.isFinite, milliseconds >= 0, milliseconds < Double(UInt64.max) else { return UInt64.max }
                return UInt64(milliseconds)
            })
        timedMedia = TimedMediaControlOwner(session: session, cancellation: cancellation)
    } else { timedMedia = nil }
    let process = BridgeProcess(driver: driver, labels: configuration.labels, clock: clock, sink: sink,
                                joinDeadline: configuration.joinDeadline, actionDeadline: configuration.actionDeadline, custody: configuration.custody,
                                v2Clock: timingClock, timedMedia: timedMedia,
                                identity: configuration.speakerSelectors.resolver(),
                                output: writer.write)
    let input = BridgeInputPump(fd: STDIN_FILENO, cancellation: cancellation)
    var failure: Error?
    do { try runBridgeControl(process: process, input: input, cancellation: cancellation, clock: clock,
                         observationInterval: configuration.audio == nil ? configuration.observationInterval : 0.25,
                         cleanupFailed: { diagnostic("operator_cleanup_required_departure_unconfirmed") }) }
    catch { failure = error }
    if let binding = configuration.custody, let writer = outcomeWriter, let status = process.shutdownResult {
        do { try writer.write(BridgeProcessOutcome(binding: binding, status: status, observedAt: clock.now())) }
        catch { failure = failure ?? error }
    }
    if let failure { throw failure }
}

do {
    switch try BridgeProcessConfiguration.arguments(Array(CommandLine.arguments.dropFirst())) {
    case .help:
        print("FeishuBridgeSpike --config /absolute/private/config.json [--inspect-ax]\nConfig1/2: control only. Config3: timed media with explicit display/output UID and authenticated Runtime2 endpoint.\nMeasured build/locale selectors and existing permissions required; no automatic routes or prompts.\nInspection is explicit, read-only, and saved only in the private evidence root.")
    case .run(let path, let inspection):
        try run(BridgeProcessConfiguration.read(path: path, inspection: inspection), inspection: inspection)
    }
} catch {
    diagnostic((error as? BridgeProcessError)?.rawValue ?? (error as? ClientResolutionFailure)?.rawValue ?? "bridge_failed")
    exit(2)
}
