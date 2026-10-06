import Foundation
import Darwin
import FeishuBridgeSpike
import CalibrationSupport

func diagnostic(_ code: String) {
    let flags = fcntl(STDERR_FILENO, F_GETFL)
    guard flags >= 0, fcntl(STDERR_FILENO, F_SETFL, flags | O_NONBLOCK) == 0 else { return }
    _ = (code + "\n").utf8CString.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count - 1) }
}

func run(_ arguments: CalibrationArguments) throws {
    let configuration = try BridgeProcessConfiguration.read(path: arguments.configPath, inspection: false)
    guard configuration.audio != nil, let custody = configuration.custody else { throw BridgeProcessError.invalidInput }
    let telemetry = try CalibrationTelemetry(path: arguments.telemetryPath, scenario: arguments.scenario)
    defer { try? telemetry.close() }
    let outcome = try BridgeOutcomeWriter()
    defer { outcome.close() }
    let cancellation = BridgeCancellation()
    signal(SIGPIPE, SIG_IGN)
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
    let signals = [SIGTERM, SIGINT].map { number in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { cancellation.cancel() }; source.resume(); return source
    }
    defer { signals.forEach { $0.cancel() } }
    let systemSource = SystemCapturePairClock()
    let source = try CoherentCalibrationClock(anchorHost: systemSource.hostNanoseconds(),
        anchorUnixNs: systemSource.wallSample().unixNs, host: { try systemSource.hostNanoseconds() })
    let metadataFault = MetadataFaultClock(source: source, onFault: { try telemetry.barrier(.metadataClockFault) })
    let sampler = try CaptureClockPairSampler(source: arguments.scenario == .metadataPrimary ? metadataFault : source)
    let counts = CalibrationState()
    let faults = FaultConnectionState()
    let nativeFault = NativeFaultState()
    let expiryFault = ExpiryFaultConnectionState()
    let rollback = try arguments.expiresAtMs.map { try RollbackAdmissionClock(source: source, expiresAtMs: $0) }
    let session = try TimedMediaSession(clock: sampler,
        playbackRequest: PlaybackRequest(outputDeviceUID: "mac11d.synthetic.output"),
        captureRequest: {
            try CaptureRequest(pid: 123, bundlePath: "/Applications/Synthetic.app", bundleIdentifier: "test.synthetic",
                build: "1", launchDate: Date(timeIntervalSince1970: 1), displayID: 123)
        },
        // Both paths use the shipped real endpoint. Only the explicit test scenario
        // decorates first-cycle read/write ownership; authentication is unchanged.
        connectionFactory: { endpoint in
            if [.confirmedCleanupWrite, .unconfirmedCleanupWrite].contains(arguments.scenario) {
                return try faults.create(endpoint: endpoint,
                    captureReady: { counts.snapshot.captureStarts > 0 },
                    captureProgress: { counts.snapshot.emittedBuffers >= 3 },
                    onFault: { try telemetry.barrier(.transportWriteFault) })
            }
            if arguments.scenario == .expiryRollback, let rollback {
                return try expiryFault.create(endpoint: endpoint, expiryDeadline: rollback.expiryDeadline,
                    progress: { counts.snapshot.emittedBuffers >= 181 },
                    onFault: { try telemetry.barrier(.expiryTransportFault) })
            }
            if [.metadataPrimary, .nativePrimary].contains(arguments.scenario) { metadataFault.connectionCreated() }
            return try RuntimeMediaEndpointClient(endpoint: endpoint)
        },
        captureFactory: { SystemAudioCapture(backendFactory: {
            if [.nativePrimary, .unconfirmedCleanupWrite].contains(arguments.scenario) {
                return NativeFaultCapture(mode: arguments.scenario == .nativePrimary ? .nativePrimary : .delayedStop,
                    state: nativeFault, counts: counts, barrier: { try telemetry.barrier($0) },
                    onFault: { try telemetry.barrier(.nativePrimaryFault) },
                    onLateStop: { try telemetry.barrier(.nativeStopCompletionLate) })
            }
            return SyntheticCapture(state: counts, fullBufferCount: arguments.scenario == .expiryRollback ? 180 : 2, barrier: {
                try telemetry.barrier($0)
                if arguments.scenario == .metadataPrimary && $0 == .captureEmissionComplete { metadataFault.invalidateMetadata() }
                if $0 == .captureEmissionComplete, let rollback, let expires = arguments.expiresAtMs {
                    try rollback.rollbackAfterExpiry()
                    guard try rollback.nowUnixMs() < expires else { throw BridgeProcessError.invalidInput }
                    try telemetry.barrier(.wallRollback)
                }
            })
        }) },
        rendererFactory: { played in AudioOutputRenderer(backendFactory: {
            SelectedAudioOutputBackend(devices: SyntheticOutputLookup(), engineFactory: {
                SyntheticOutput(state: counts, barrier: { try telemetry.barrier($0) })
            })
        }, onPlayed: played) },
        nowUnixMs: {
            if let rollback { return (try? rollback.nowUnixMs()) ?? UInt64.max }
            guard let wall = try? source.wallSample().unixNs, wall >= 0 else { return UInt64.max }
            return UInt64(wall / 1_000_000)
        })
    let media = TimedMediaControlOwner(session: session, cancellation: cancellation)
    let clock = SystemBridgeClock()
    let sink = try FileEvidenceSink(root: configuration.evidenceRoot)
    defer { try? sink.close() }
    let writer = try BridgeOutputWriter(fd: STDOUT_FILENO, cancellation: cancellation)
    let process = BridgeProcess(driver: SyntheticAccessibility(labels: configuration.labels), labels: configuration.labels,
        clock: clock, sink: sink, joinDeadline: configuration.joinDeadline, actionDeadline: configuration.actionDeadline,
        custody: custody, v2Clock: sampler, timedMedia: media, output: writer.write)
    let input = BridgeInputPump(fd: STDIN_FILENO, cancellation: cancellation)
    try telemetry.barrier(.childReady)
    var failure: Error?
    do {
        try runBridgeControl(process: process, input: input, cancellation: cancellation, clock: clock,
            observationInterval: configuration.observationInterval,
            cleanupFailed: { diagnostic("mac11d_cleanup_unconfirmed") })
    } catch { failure = error }
    do {
        try telemetry.barrier(.controlFinished)
        try telemetry.result(counts: counts.snapshot, stop: media.stopResult(), departure: process.shutdownResult,
            faults: [.confirmedCleanupWrite, .unconfirmedCleanupWrite].contains(arguments.scenario) ? faults.snapshot : nil,
            metadataFault: arguments.scenario == .metadataPrimary ? metadataFault.snapshot : nil,
            nativeFault: [.nativePrimary, .unconfirmedCleanupWrite].contains(arguments.scenario) ? nativeFault.snapshot : nil,
            nativeConnections: arguments.scenario == .nativePrimary ? metadataFault.snapshot.connectionsCreated : nil,
            expiryFault: arguments.scenario == .expiryRollback ? expiryFault.snapshot : nil,
            rollbackApplied: rollback?.rollbackApplied)
        try telemetry.close()
    } catch { failure = failure ?? error }
    if let status = process.shutdownResult {
        do { try outcome.write(BridgeProcessOutcome(binding: custody, status: status, observedAt: clock.now())) }
        catch { failure = failure ?? error }
    }
    if let failure { throw failure }
}

do { try run(CalibrationArguments.parse(Array(CommandLine.arguments.dropFirst()))) }
catch { diagnostic((error as? BridgeProcessError)?.rawValue ?? "mac11d_calibration_failed"); exit(2) }
