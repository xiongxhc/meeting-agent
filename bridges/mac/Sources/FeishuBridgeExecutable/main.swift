import Foundation
import Darwin
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
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
    let signals = [SIGTERM, SIGINT].map { number in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { cancellation.cancel() }; source.resume(); return source
    }
    defer { signals.forEach { $0.cancel() } }
    let clock = SystemBridgeClock()
    let backend = SystemAXBackend(pid: configuration.pid, bundlePath: configuration.bundlePath,
                                  bundleId: configuration.bundleIdentifier, build: configuration.bundleVersion,
                                  callTimeout: configuration.axCallTimeout)
    let driver = AXAccessibilityDriver(backend: backend, clock: clock, cancellation: cancellation,
                                       maxNodes: inspection ? 128 : 512, maxStringBytes: inspection ? 1024 : 4096,
                                       readDeadline: min(configuration.actionDeadline, 2))
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
    let process = BridgeProcess(driver: driver, labels: configuration.labels, clock: clock, sink: sink,
                                joinDeadline: configuration.joinDeadline, actionDeadline: configuration.actionDeadline,
                                output: writer.write)
    let input = BridgeInputPump(fd: STDIN_FILENO, cancellation: cancellation)
    try runBridgeControl(process: process, input: input, cancellation: cancellation, clock: clock,
                         observationInterval: configuration.observationInterval,
                         cleanupFailed: { diagnostic("operator_cleanup_required_departure_unconfirmed") })
}

do {
    switch try BridgeProcessConfiguration.arguments(Array(CommandLine.arguments.dropFirst())) {
    case .help:
        print("FeishuBridgeSpike --config /absolute/private/config.json [--inspect-ax]\nControl-only bridge; measured build/locale selectors required. Media unavailable.\nInspection is explicit, read-only, and saved only in the private evidence root.")
    case .run(let path, let inspection):
        try run(BridgeProcessConfiguration.read(path: path, inspection: inspection), inspection: inspection)
    }
} catch {
    diagnostic((error as? BridgeProcessError)?.rawValue ?? "bridge_failed")
    exit(2)
}
