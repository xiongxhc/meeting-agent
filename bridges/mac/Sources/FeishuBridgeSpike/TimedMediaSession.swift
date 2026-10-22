import Foundation

/// What the producer can truthfully claim about the encrypted recorder having
/// drained every ordered record through its declared boundary. Only an exact
/// echoed kind 11 on the same authenticated connection is `confirmed`; nothing
/// local — a completed socket write, a confirmed native cleanup, a closed
/// connection — may be promoted to it.
public enum TimedMediaDrainOutcome: Equatable, Sendable {
    /// A media-v2 lease. The v2 wire makes no drain claim at all.
    case notApplicable
    case confirmed(CaptureFinishBoundary)
    case unconfirmed(reason: String)

    /// The wire view (D029 §1). `notApplicable` has no wire spelling at all:
    /// the member is omitted rather than nulled.
    public var report: CaptureDrainReport? {
        switch self {
        case .notApplicable: nil
        case .confirmed(let boundary): .confirmed(CaptureDrainReport.Boundary(boundary))
        case .unconfirmed(let reason): .unconfirmed(reason: reason)
        }
    }
}

public struct TimedMediaStopResult: Equatable, Sendable {
    public let cleanupConfirmed: Bool
    public let drain: TimedMediaDrainOutcome
}

/// The answer to `renew_media_lease`. Only `.renewed` moves the reconnect
/// admission cutoff, and only forward. No outcome touches capture.
public enum TimedMediaRenewal: Equatable, Sendable {
    case renewed, unchanged
    /// No running lease: before start, after stop, or after media gave up.
    case notActive
    case sessionMismatch, regressed
    /// The new expiry is already in the past; a lapsed lease is not revived.
    case expired
    /// The media owner could not answer within its bound.
    case unavailable
}

public protocol TimedMediaControl: AnyObject {
    func start(_ lease: TimedMediaLease) -> Bool
    func stop() -> Bool
    func renew(_ renewal: MediaLeaseRenewal) -> TimedMediaRenewal
    /// The typed stop result, available once `stop` has returned.
    func stopResult() -> TimedMediaStopResult?
    func takeEvents() -> [BridgeEvent]
}
public final class TimedMediaControlOwner: TimedMediaControl {
    private let session: TimedMediaSession
    private let cancellation: BridgeCancellation
    private var pending: Task<Void, Never>?
    private var cleanupResult: Bool?
    private var typedStopResult: TimedMediaStopResult?
    public init(session: TimedMediaSession, cancellation: BridgeCancellation) {
        self.session = session; self.cancellation = cancellation
    }
    public func stopResult() -> TimedMediaStopResult? { typedStopResult }
    public func start(_ lease: TimedMediaLease) -> Bool {
        guard pending == nil, cleanupResult == nil, !cancellation.isCancelled else { return false }
        return perform(seconds: 18, observeCancellation: true) { [session] in await session.start(lease) } ?? false
    }
    public func stop() -> Bool {
        if let cleanupResult { return cleanupResult }
        let old = pending; old?.cancel()
        let deadline = ProcessInfo.processInfo.systemUptime + TimedMediaSession.maximumCloseSeconds
        let typed = perform(seconds: TimedMediaSession.maximumCloseSeconds, observeCancellation: false) { [session] in
            let clean = await session.stop(deadline: deadline)
            await old?.value
            return await session.stopResult() ?? TimedMediaStopResult(cleanupConfirmed: clean, drain: .unconfirmed(reason: "drain_not_attempted"))
        }
        typedStopResult = typed
        let result = typed?.cleanupConfirmed ?? false
        cleanupResult = result; return result
    }
    public func renew(_ renewal: MediaLeaseRenewal) -> TimedMediaRenewal {
        guard cleanupResult == nil else { return .notActive }
        guard pending == nil else { return .unavailable }
        return perform(seconds: 0.25, observeCancellation: false) { [session] in
            await session.renew(sessionId: renewal.sessionId, expiresAtMs: renewal.expiresAtMs)
        } ?? .unavailable
    }
    public func takeEvents() -> [BridgeEvent] {
        guard pending == nil else { return [] }
        return perform(seconds: 0.25, observeCancellation: false) { [session] in await session.takeEvents() } ?? []
    }
    private func perform<Value: Sendable>(seconds: TimeInterval, observeCancellation: Bool,
                                          operation: @escaping @Sendable () async -> Value) -> Value? {
        let box = TimedMediaResultBox<Value>()
        let task = Task.detached { box.complete(await operation()) }; pending = task
        var deadline = ProcessInfo.processInfo.systemUptime + seconds, cancelling = false
        while true {
            if let value = box.wait(seconds: 0.02) { pending = nil; return value }
            if observeCancellation, cancellation.isCancelled, !cancelling {
                task.cancel(); cancelling = true
                deadline = ProcessInfo.processInfo.systemUptime + TimedMediaSession.maximumCloseSeconds
            }
            if ProcessInfo.processInfo.systemUptime >= deadline { task.cancel(); return nil }
        }
    }
}
private final class TimedMediaResultBox<Value: Sendable>: @unchecked Sendable {
    private let condition = NSCondition()
    private var value: Value?
    func complete(_ value: Value) { condition.lock(); self.value = value; condition.broadcast(); condition.unlock() }
    func wait(seconds: TimeInterval) -> Value? {
        condition.lock(); defer { condition.unlock() }
        if value == nil { _ = condition.wait(until: Date(timeIntervalSinceNow: seconds)) }
        return value
    }
}

/// One timed lease, consuming accepted Runtime4c97c47 confirmation on every
/// socket. Network delivery and positively confirmed native cleanup are distinct.
public actor TimedMediaSession {
    public typealias RendererFactory = @Sendable (@escaping @Sendable (UInt64, UInt64) -> Void) -> AudioOutputRenderer
    public static let maximumCloseSeconds = TimedMediaCycle.maximumCloseSeconds
    /// Attempts per outage; the count restarts after a successful reconnect.
    public static let reconnectAttemptLimit = 3
    /// Attempts across outages in any rolling window, so a flapping link that
    /// keeps recovering cannot reconnect forever.
    public static let reconnectRateLimit = 6
    public static let reconnectRateWindow: TimeInterval = 60
    private let factory: @Sendable (UInt64, TimeInterval?) -> TimedMediaCycle
    private let nowUnixMs: @Sendable () -> UInt64
    private let nowMonotonic: @Sendable () -> TimeInterval
    private var credentialDeadline: TimeInterval?
    /// The running lease's Runtime session and wall expiry, for renewal checks.
    private var activeLease: (sessionId: UInt64, expiresAtMs: UInt64)?
    private var mediaEnded = false
    private var cycle: TimedMediaCycle?
    private var supervisor: Task<Void, Never>?
    private var stopRequested = false
    private var outageStartedAt: TimeInterval?
    private var attempts = 0
    private var attemptTimes: [TimeInterval] = []
    public private(set) var diagnostics: Set<String> = []
    private var stopped: TimedMediaStopResult?
    public func stopResult() -> TimedMediaStopResult? { stopped }
    private var events: [BridgeEvent] = []
    public func takeEvents() -> [BridgeEvent] { let values = events; events.removeAll(); return values }
    private func event(_ value: BridgeEvent) {
        // Bounded between polls: at most6 retry attempts per rolling window
        // (4 lifecycle events each) plus unique static diagnostics.
        guard events.count < 32 else { return }
        events.append(value)
    }
    private func diagnostic(_ reason: String) {
        if diagnostics.insert(reason).inserted { event(.mediaDisconnected(reason: reason)) }
    }
    public init(clock: CaptureClockPairSampler, playbackRequest: PlaybackRequest,
                captureRequest: @escaping @Sendable () throws -> CaptureRequest,
                connectionFactory: @escaping @Sendable (String) throws -> any RuntimeMediaConnection = { try RuntimeMediaEndpointClient(endpoint: $0) },
                captureFactory: @escaping @Sendable () -> SystemAudioCapture = { SystemAudioCapture() },
                rendererFactory: @escaping RendererFactory = { AudioOutputRenderer(onPlayed: $0) },
                nowUnixMs: @escaping @Sendable () -> UInt64,
                nowMonotonic: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        let metadataBudget = TimedMetadataBudget()
        self.nowUnixMs = nowUnixMs
        self.nowMonotonic = nowMonotonic
        factory = { epoch, deadline in
            TimedMediaCycle(clock: clock, playbackRequest: playbackRequest, captureRequest: captureRequest,
                connectionFactory: connectionFactory, captureFactory: captureFactory, rendererFactory: rendererFactory,
                nowMonotonic: nowMonotonic, firstEpoch: epoch, admissionDeadline: deadline, metadataBudget: metadataBudget)
        }
    }
    public func start(_ lease: TimedMediaLease) async -> Bool {
        guard cycle == nil, !stopRequested else { return false }
        // Anchor before the wall read: time spent sampling cannot extend admission.
        // This is a one-time authentication cutoff, never a healthy-stream TTL.
        let before = nowMonotonic(), wall = nowUnixMs()
        guard before.isFinite, before >= 0, lease.expiresAtMs > wall else { return false }
        let cutoff = before + Double(lease.expiresAtMs - wall) / 1000
        guard cutoff.isFinite, nowMonotonic() < cutoff else { return false }
        credentialDeadline = cutoff
        activeLease = (lease.sessionId, lease.expiresAtMs)
        let first = factory(1, cutoff); cycle = first
        guard await first.start(lease), !stopRequested else { return false }
        event(.mediaConnected(endpoint: lease.connectEndpoint))
        supervisor = Task { await self.supervise(lease, first: first) }
        return true
    }
    /// Moves the reconnect-admission cutoff forward to a renewed expiry of the
    /// same credential. It never touches the running cycle, so capture and the
    /// encrypted recording it feeds are unaffected whatever the answer.
    public func renew(sessionId: UInt64, expiresAtMs: UInt64) -> TimedMediaRenewal {
        guard !stopRequested, !mediaEnded, let current = activeLease, let deadline = credentialDeadline else { return .notActive }
        guard sessionId == current.sessionId else { return .sessionMismatch }
        guard expiresAtMs >= current.expiresAtMs else { return .regressed }
        let before = nowMonotonic(), wall = nowUnixMs()
        guard before.isFinite, before >= 0, expiresAtMs > wall else { return .expired }
        guard expiresAtMs > current.expiresAtMs else { return .unchanged }
        let cutoff = before + Double(expiresAtMs - wall) / 1000
        guard cutoff.isFinite else { return .expired }
        credentialDeadline = max(deadline, cutoff)
        activeLease = (current.sessionId, expiresAtMs)
        return .renewed
    }
    /// One outage's admission deadline, recomputed so a renewal during the
    /// outage applies to the next attempt.
    private func outageDeadline(_ lease: TimedMediaLease) -> TimeInterval? {
        guard let outageStartedAt, let credentialDeadline else { return nil }
        return min(outageStartedAt + Double(lease.reconnectWindowMs) / 1000, credentialDeadline)
    }
    private func supervise(_ lease: TimedMediaLease, first: TimedMediaCycle) async {
        defer { mediaEnded = true }
        var current = first
        while !stopRequested {
            let ended = await current.waitEnded()
            _ = await current.stop()
            if !ended.deliveryComplete { diagnostic("capture_delivery_interrupted") }
            if ended.finalPairUndelivered { diagnostic("final_clock_pair_undelivered") }
            guard !stopRequested, !Task.isCancelled else { return }
            event(.mediaDisconnected(reason: ended.nativeCleanupConfirmed ? "media_transport_interrupted" : "media_cleanup_unconfirmed"))
            guard ended.nativeCleanupConfirmed, ended.transportFailure else {
                diagnostic("media_failed"); return
            }
            if outageStartedAt == nil { outageStartedAt = ended.disconnectedAt }
            let now = nowMonotonic()
            attemptTimes.removeAll { now - $0 >= Self.reconnectRateWindow }
            guard let deadline = outageDeadline(lease), attempts < Self.reconnectAttemptLimit,
                  attemptTimes.count < Self.reconnectRateLimit, ended.captureEpoch < UInt64.max,
                  now + 0.1 < deadline else {
                diagnostic("reconnect_exhausted"); return
            }
            attempts += 1; attemptTimes.append(now)
            event(.reconnecting(attempt: attempts))
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            guard !stopRequested, !Task.isCancelled else { return }
            // The cutoff can pass during the backoff: that is a give-up too, so
            // the coordinator can relaunch instead of media ending silently.
            guard let admission = outageDeadline(lease), nowMonotonic() < admission else {
                diagnostic("reconnect_exhausted"); return
            }
            let next = factory(ended.captureEpoch + 1, admission); current = next; cycle = next
            // Only complete ACK/native/capture readiness ends this outage.
            // Failed attempts and their cleanup keep the outage's deadline.
            if await next.start(lease) {
                let attempt = attempts
                outageStartedAt = nil; attempts = 0
                if !stopRequested {
                    event(.mediaConnected(endpoint: lease.connectEndpoint))
                    event(.reconnected(attempt: attempt))
                }
            }
        }
    }
    public func suspendCapture() async -> Bool {
        guard !stopRequested else { return false }; return await cycle?.suspendCapture() == true
    }
    public func resumeCapture() async -> Bool {
        guard !stopRequested else { return false }; return await cycle?.resumeCapture() == true
    }
    public func stop(deadline: TimeInterval? = nil) async -> Bool {
        let firstStop = !stopRequested
        stopRequested = true; supervisor?.cancel()
        _ = await cycle?.stop(deadline: deadline)
        await supervisor?.value
        let result: Bool
        var drain = TimedMediaDrainOutcome.notApplicable
        if let cycle {
            let ended = await cycle.waitEnded()
            if !ended.deliveryComplete { diagnostic("capture_delivery_interrupted") }
            if ended.finalPairUndelivered { diagnostic("final_clock_pair_undelivered") }
            result = ended.nativeCleanupConfirmed
            drain = ended.drain
            switch drain {
            case .notApplicable: break
            case .confirmed: diagnostic("capture_drain_confirmed")
            case .unconfirmed: diagnostic("capture_drain_unconfirmed")
            }
        } else { result = true }
        // D029 §1: the terminal event is the one moment the drain outcome exists,
        // so it carries it. A v2 lease reports `.notApplicable` and the member is
        // omitted, leaving the v1 bytes exactly as they were.
        if firstStop, cycle != nil {
            event(.mediaDisconnected(reason: result ? "media_stopped" : "media_cleanup_unconfirmed",
                captureDrain: drain.report))
        }
        stopped = TimedMediaStopResult(cleanupConfirmed: result, drain: drain)
        return result
    }
}

private struct TimedCycleEnd: Sendable {
    let nativeCleanupConfirmed: Bool, deliveryComplete: Bool, transportFailure: Bool
    let finalPairUndelivered: Bool
    let disconnectedAt: TimeInterval, captureEpoch: UInt64
    let drain: TimedMediaDrainOutcome
}

private actor TimedMetadataBudget {
    private var times: [TimeInterval] = []
    func reserve(_ now: TimeInterval) throws {
        times.removeAll { now - $0 >= 1 }
        guard times.count < 128 else { throw BridgeProcessError.inputTooLarge }
        times.append(now)
    }
}

private actor TimedMediaCycle {
    /// One absolute close deadline, including maintenance/write draining, native
    /// capture tail, final pair, renderer stop, connection and task ownership.
    /// Native phase budgets must each be <=5s; ordinary worst-case phase sum is
    /// 2 + 5 + 2 + 2 + 5 + 1 =17s, leaving3s owner/scheduling margin.
    public static let maximumCloseSeconds: TimeInterval = 20
    typealias RendererFactory = TimedMediaSession.RendererFactory
    private let clock: CaptureClockPairSampler
    private let playbackRequest: PlaybackRequest
    private let captureRequest: @Sendable () throws -> CaptureRequest
    private let connectionFactory: @Sendable (String) throws -> any RuntimeMediaConnection
    private let captureFactory: @Sendable () -> SystemAudioCapture
    private let rendererFactory: RendererFactory
    private let nowMonotonic: @Sendable () -> TimeInterval
    private var connection: (any RuntimeMediaConnection)?
    private var writer: TimedMediaWriter?
    private var capture: SystemAudioCapture?
    private var delivery: CaptureWriteSlot?
    private var renderer: AudioOutputRenderer?
    private var lease: TimedMediaLease?
    private var starting: Task<Bool, Never>?
    private var reading: Task<Void, Never>?
    private var maintenance: Task<Void, Never>?
    private var cleanup: Task<Bool, Never>?
    /// `running -> finishingCapture -> terminal`. The old boolean terminated the
    /// sole read loop before an acknowledgement could ever arrive, so media v3
    /// needs the intermediate state in which admission is closed but the one
    /// reader stays alive.
    private enum CycleState { case running, finishingCapture, terminal }
    private var state = CycleState.running
    private var terminal: Bool { state == .terminal }
    private var pairStarted = false
    private var mediaVersion: UInt8 = 2
    private var lastFrame: CaptureFinishBoundary.Frame?
    private var finishOutcome: TimedMediaDrainOutcome?
    private var finishWaiter: CheckedContinuation<TimedMediaDrainOutcome, Never>?
    private var expectedBoundary: CaptureFinishBoundary?
    private var readingEnded = false
    private var decoder = RuntimeMediaDecoder()
    private var afterAuthentication: [RuntimeMediaInbound] = []
    private struct PlaybackReceipt {
        let network: UInt64, generation: UInt64
        var admitted = false, played = false
    }
    private var receipts: [UInt64: PlaybackReceipt] = [:]
    private var runtimeGeneration: UInt64?, lastFlushedGeneration: UInt64 = 0
    private var playbackSequence: UInt64 = 0, lastNetworkSequence: UInt64 = 0
    private var pendingPlayback: (frame: RuntimePlaybackFrame, offset: Int, finalSequence: UInt64)?
    private var playbackPumping = false
    private var playbackCredit: CheckedContinuation<Void, Never>?
    private var playbackProgressDeadline: TimeInterval?
    private var captureEpoch: UInt64
    private let epochOffset: UInt64
    private let admissionDeadline: TimeInterval?
    private let metadataBudget: TimedMetadataBudget
    private var disconnectedAt: TimeInterval?
    private var transportFailure = false
    private var ended: TimedCycleEnd?
    private var endWaiter: CheckedContinuation<TimedCycleEnd, Never>?
    public init(clock: CaptureClockPairSampler, playbackRequest: PlaybackRequest,
                captureRequest: @escaping @Sendable () throws -> CaptureRequest,
                connectionFactory: @escaping @Sendable (String) throws -> any RuntimeMediaConnection = { try RuntimeMediaEndpointClient(endpoint: $0) },
                captureFactory: @escaping @Sendable () -> SystemAudioCapture = { SystemAudioCapture() },
                rendererFactory: @escaping RendererFactory = { AudioOutputRenderer(onPlayed: $0) },
                nowMonotonic: @escaping @Sendable () -> TimeInterval, firstEpoch: UInt64,
                admissionDeadline: TimeInterval?, metadataBudget: TimedMetadataBudget) {
        self.clock = clock; self.playbackRequest = playbackRequest; self.captureRequest = captureRequest
        self.connectionFactory = connectionFactory; self.captureFactory = captureFactory
        self.rendererFactory = rendererFactory; self.nowMonotonic = nowMonotonic
        captureEpoch = firstEpoch; epochOffset = firstEpoch - 1
        self.admissionDeadline = admissionDeadline; self.metadataBudget = metadataBudget
    }
    func waitEnded() async -> TimedCycleEnd {
        if let ended { return ended }
        return await withCheckedContinuation { endWaiter = $0 }
    }
    public func start(_ lease: TimedMediaLease) async -> Bool {
        guard starting == nil, !terminal else { return false }
        let task = Task { await self.begin(lease) }; starting = task
        return await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
            Task { await self.cancelStart() }
        }
    }
    private func cancelStart() { _ = beginCleanup() }
    private func begin(_ lease: TimedMediaLease) async -> Bool {
        do {
            guard !terminal else { throw RuntimeMediaConnectionError.closed }
            try checkAdmissionDeadline()
            self.lease = lease
            mediaVersion = lease.mediaProtocolVersion
            decoder = RuntimeMediaDecoder(version: mediaVersion)
            let connection = try connectionFactory(lease.connectEndpoint); self.connection = connection
            let writer = TimedMediaWriter(connection) { [weak self] error in await self?.noteFailure(error) }; self.writer = writer
            let deadline = min(ProcessInfo.processInfo.systemUptime + 2, admissionDeadline ?? .infinity)
            try await connection.open(deadline: deadline)
            try checkActive()
            try checkAdmissionDeadline()
            try await writer.send(try tagged(RuntimeMediaCodecV2.authentication(session: lease.sessionId, bridge: lease.bridgeSessionId, token: lease.credential)), deadline: deadline)
            var accepted = false
            while !accepted {
                let bytes = try await connection.read(maximum: decoder.nextReadMaximum, deadline: deadline)
                try checkActive()
                guard !bytes.isEmpty else { throw RuntimeMediaConnectionError.closed }
                let messages = try decoder.append(bytes)
                guard let first = messages.first else { continue }
                guard first == .authenticated(session: lease.sessionId, bridge: lease.bridgeSessionId) else { throw BridgeProcessError.invalidInput }
                afterAuthentication = Array(messages.dropFirst()); accepted = true
            }
            try checkActive()
            try checkAdmissionDeadline()
            let request = try captureRequest()
            guard request.startBudget <= 5, request.stopBudget <= 5, playbackRequest.operationBudget <= 5 else { throw AudioPrimitiveError.invalidRequest }
            let renderer = rendererFactory { [weak self] generation, sequence in
                Task { await self?.played(generation: generation, sequence: sequence) }
            }; self.renderer = renderer
            guard await renderer.start(playbackRequest) == .started else { throw AudioPrimitiveError.nativeFailure }
            try checkActive()
            try checkAdmissionDeadline()
            try await metadata(RuntimeMediaCodecV2.epoch(session: lease.sessionId, bridge: lease.bridgeSessionId, domain: clock.clockDomainId, epoch: captureEpoch))
            if epochOffset > 0 { try await metadata(RuntimeMediaCodecV2.discontinuity(session: lease.sessionId, epoch: captureEpoch, reason: 3)) }
            try checkActive()
            try await metadata(RuntimeMediaCodecV2.clockPair(session: lease.sessionId, pair: clock.sample()))
            pairStarted = true
            try checkActive()
            try checkAdmissionDeadline()
            let capture = captureFactory(); self.capture = capture
            let delivery = CaptureWriteSlot(handler: { [weak self] value in
                guard let self else { return false }
                return await self.writeCapture(value)
            }, ready: { capture.resumeDelivery() })
            self.delivery = delivery
            guard await capture.start(request, sink: { delivery.offer($0) }) == .started else { throw AudioPrimitiveError.nativeFailure }
            try checkActive()
            try checkAdmissionDeadline()
            reading = Task { await self.readLoop() }
            maintenance = Task { await self.maintain() }
            return true
        } catch {
            noteFailure(error)
            _ = await beginCleanup().value
            return false
        }
    }
    private func checkAdmissionDeadline() throws {
        if let admissionDeadline, nowMonotonic() >= admissionDeadline { throw RuntimeMediaConnectionError.timedOut }
    }
    /// Media v3 reuses every v2 timed body under the v3 envelope; media-v1
    /// playback and flush acknowledgements are never retagged.
    private func tagged(_ bytes: Data) throws -> Data {
        mediaVersion == 3 ? try RuntimeMediaCodecV3.envelope(bytes) : bytes
    }
    private func noteFailure(_ error: Error) {
        guard !terminal, disconnectedAt == nil else { return }
        disconnectedAt = nowMonotonic()
        transportFailure = error is RuntimeMediaConnectionError
    }
    private func checkActive() throws {
        guard !Task.isCancelled, !terminal, lease != nil else { throw RuntimeMediaConnectionError.closed }
    }
    private func writeCapture(_ value: CaptureDelivery) async -> Bool {
        guard let connection, let writer, let lease else { return false }
        do {
            switch value {
            case .packet(let packet):
                let epoch = packet.epoch.addingReportingOverflow(epochOffset)
                guard !epoch.overflow, epoch.partialValue >= captureEpoch else { throw BridgeProcessError.invalidInput }
                if epoch.partialValue != captureEpoch {
                    captureEpoch = epoch.partialValue
                    // Runtime resets its frame watermark on every epoch advance,
                    // so the producer's retained boundary must reset with it.
                    lastFrame = nil
                    try await metadata(RuntimeMediaCodecV2.epoch(session: lease.sessionId, bridge: lease.bridgeSessionId, domain: clock.clockDomainId, epoch: captureEpoch))
                }
                var timing = try RuntimeMediaCodecV2.timing(packet)
                timing.replaceSubrange(4..<12, with: RuntimeMediaCodecV2.be(captureEpoch))
                try await writer.send(try tagged(RuntimeMediaCodecV2.capture(session: lease.sessionId, timing: timing, pcm: packet.pcm)), deadline: ProcessInfo.processInfo.systemUptime + 2)
                let outputEnd = UInt64(packet.outputRange.lowerBound).addingReportingOverflow(UInt64(packet.sampleCount))
                guard !outputEnd.overflow else { throw BridgeProcessError.invalidInput }
                lastFrame = CaptureFinishBoundary.Frame(sequence: packet.sequence, outputEndSample: outputEnd.partialValue)
            case .discontinuity(let loss):
                let epoch = loss.epoch.addingReportingOverflow(epochOffset)
                guard !epoch.overflow, epoch.partialValue == captureEpoch else { throw BridgeProcessError.invalidInput }
                let reason: UInt8
                switch loss.reason {
                case .inputOverflow, .outputOverflow: reason = 1
                case .suspended: reason = 4
                case .sourceReset: reason = 8
                case .invalidSample: reason = 7
                }
                try await metadata(RuntimeMediaCodecV2.discontinuity(session: lease.sessionId, epoch: captureEpoch, reason: reason))
            case .failed: throw AudioPrimitiveError.nativeFailure
            }
            return true
        } catch {
            noteFailure(error)
            _ = beginCleanup()
            connection.cancel()
            return false
        }
    }
    private func metadata(_ bytes: Data, deadline: TimeInterval? = nil) async throws {
        guard let writer else { throw RuntimeMediaConnectionError.closed }
        let now = ProcessInfo.processInfo.systemUptime
        try await metadataBudget.reserve(now)
        try await writer.send(try tagged(bytes), deadline: min(now + 2, deadline ?? now + 2))
    }
    private func maintain() async {
        do {
            while !terminal {
                try await Task.sleep(for: .seconds(1))
                try Task.checkCancellation(); try checkActive()
                guard renderer?.failure == nil, capture?.state == .running, let lease else { throw AudioPrimitiveError.nativeFailure }
                if let playbackProgressDeadline, ProcessInfo.processInfo.systemUptime >= playbackProgressDeadline { throw AudioPrimitiveError.nativeFailure }
                try await metadata(RuntimeMediaCodecV2.clockPair(session: lease.sessionId, pair: clock.sample()))
            }
        } catch { if !terminal { noteFailure(error); _ = beginCleanup() } }
    }
    private func readLoop() async {
        guard let connection else { readingEnded = true; return }
        var partialDeadline: TimeInterval?
        do {
            let initial = afterAuthentication; afterAuthentication.removeAll()
            for message in initial { try await receive(message) }
            while !terminal {
                if decoder.awaitingPlaybackBody, state == .running {
                    var heldForCredit = false
                    while state == .running && (pendingPlayback != nil || receipts.count >= 12) {
                        heldForCredit = true
                        await withCheckedContinuation { playbackCredit = $0 }
                    }
                    if terminal { break }
                    // A complete fixed header held for native credit is not a
                    // malicious slow fragment. Body progress gets its own bound.
                    if heldForCredit { partialDeadline = ProcessInfo.processInfo.systemUptime + 2 }
                }
                // The finish wait has no deadline of its own: the cleanup
                // watchdog already cancels this connection at the one close
                // deadline, which is what wakes a blocked read.
                let bytes = try await connection.read(maximum: decoder.nextReadMaximum,
                    deadline: state == .finishingCapture ? nil : partialDeadline)
                if terminal { break }
                guard !bytes.isEmpty else { throw RuntimeMediaConnectionError.closed }
                let messages = try decoder.append(bytes)
                for message in messages { try await receive(message) }
                // An exact acknowledgement ends the sole reader cleanly; it
                // never reads again and never awaits the cleanup task.
                if finishOutcome != nil { break }
                if decoder.hasIncompletePacket {
                    if partialDeadline == nil { partialDeadline = ProcessInfo.processInfo.systemUptime + 2 }
                } else { partialDeadline = nil }
            }
        } catch {
            // The sole reader signals its own failure and returns. It must never
            // await the cleanup task that is awaiting its waiter.
            readingEnded = true
            if state == .finishingCapture {
                settleFinish(error is RuntimeMediaConnectionError ? .unconfirmed(reason: "drain_ack_absent")
                    : .unconfirmed(reason: "drain_read_failed"))
            } else if !terminal { noteFailure(error); _ = await beginCleanup().value }
        }
        readingEnded = true
        if state == .finishingCapture { settleFinish(.unconfirmed(reason: "drain_ack_absent")) }
    }
    /// Resolves the one finish waiter exactly once. Nothing local may promote a
    /// settled negative to `confirmed`.
    private func settleFinish(_ outcome: TimedMediaDrainOutcome) {
        guard finishOutcome == nil else { return }
        finishOutcome = outcome
        let reply = finishWaiter; finishWaiter = nil; reply?.resume(returning: outcome)
    }
    private func awaitFinish() async -> TimedMediaDrainOutcome {
        if let finishOutcome { return finishOutcome }
        if readingEnded { return .unconfirmed(reason: "drain_ack_absent") }
        return await withCheckedContinuation { finishWaiter = $0 }
    }
    private func receive(_ message: RuntimeMediaInbound) async throws {
        if case .captureFinishAcknowledged(let boundary) = message {
            guard state == .finishingCapture, let expectedBoundary else { throw BridgeProcessError.invalidInput }
            settleFinish(boundary == expectedBoundary ? .confirmed(boundary) : .unconfirmed(reason: "drain_ack_mismatch"))
            return
        }
        // A playback or flush message decoded after the transition is discarded
        // and gets no Accepted, Rendered or flush acknowledgement. Absence of a
        // receipt plus the gateway's planned detach is the bounded outcome.
        guard state == .running else { return }
        try checkActive()
        guard let renderer, let lease, let writer else { throw RuntimeMediaConnectionError.closed }
        switch message {
        case .authenticated, .captureFinishAcknowledged: throw BridgeProcessError.invalidInput
        case .flush(let source, let generation):
            guard source == lease.sessionId, generation > 0 else { throw BridgeProcessError.invalidInput }
            guard generation > lastFlushedGeneration else { return }
            guard runtimeGeneration == nil || runtimeGeneration == generation else { return }
            receipts.removeAll(); pendingPlayback = nil; playbackProgressDeadline = nil
            guard await renderer.cancel(expectedGeneration: renderer.generation) == .stopped else { throw AudioPrimitiveError.ownershipUnconfirmed }
            try checkActive()
            lastFlushedGeneration = generation; runtimeGeneration = nil; playbackSequence = 0
            signalPlaybackCredit()
            try await writer.send(RuntimeMediaCodecV2.flushAcknowledgement(session: source, generation: generation), deadline: ProcessInfo.processInfo.systemUptime + 2)
        case .playback(let frame):
            guard frame.session == lease.sessionId, frame.networkSequence > lastNetworkSequence,
                  frame.generation > lastFlushedGeneration, runtimeGeneration == nil || frame.generation == runtimeGeneration,
                  pendingPlayback == nil, receipts.count < 12 else { throw BridgeProcessError.invalidInput }
            if runtimeGeneration == nil {
                runtimeGeneration = frame.generation
                if lastFlushedGeneration > 0, !renderer.resume(generation: renderer.generation) { throw AudioPrimitiveError.nativeFailure }
            }
            let end = playbackSequence.addingReportingOverflow(UInt64((frame.pcm.count + 959) / 960))
            guard !end.overflow else { throw BridgeProcessError.invalidInput }
            receipts[end.partialValue] = PlaybackReceipt(network: frame.networkSequence, generation: renderer.generation)
            pendingPlayback = (frame, 0, end.partialValue); lastNetworkSequence = frame.networkSequence
            if playbackProgressDeadline == nil { playbackProgressDeadline = ProcessInfo.processInfo.systemUptime + 2 }
            try await pumpPlayback()
        }
    }
    private func played(generation: UInt64, sequence: UInt64) async {
        // Receipt clearing plus this gate stop a late native callback from
        // manufacturing a Rendered acknowledgement after cleanup began.
        guard state == .running, renderer?.generation == generation else { return }
        playbackProgressDeadline = ProcessInfo.processInfo.systemUptime + 2
        if receipts[sequence]?.generation == generation { receipts[sequence]?.played = true }
        do { try await acknowledgePlayed(sequence); try await pumpPlayback(); signalPlaybackCredit() }
        catch { noteFailure(error); _ = await beginCleanup().value }
    }
    private func signalPlaybackCredit() { let reply = playbackCredit; playbackCredit = nil; reply?.resume() }
    private func pumpPlayback() async throws {
        guard !playbackPumping, state == .running, let renderer, let writer, let lease else { return }
        playbackPumping = true
        defer { playbackPumping = false }
        while let current = pendingPlayback, state == .running {
            let count = min(960, current.frame.pcm.count - current.offset)
            let sequence = playbackSequence + 1
            let part = Data(current.frame.pcm[current.offset..<current.offset + count])
            switch renderer.enqueue(try PlaybackPcmPacket(generation: renderer.generation, sequence: sequence, pcm: part)) {
            case .backpressured: return
            case .closed: throw AudioPrimitiveError.nativeFailure
            case .accepted: break
            }
            playbackSequence = sequence
            if current.offset + count < current.frame.pcm.count {
                pendingPlayback = (current.frame, current.offset + count, current.finalSequence)
            } else {
                pendingPlayback = nil
                try await writer.send(RuntimeMediaCodecV2.acknowledgement(session: lease.sessionId, sequence: current.frame.networkSequence, rendered: false), deadline: ProcessInfo.processInfo.systemUptime + 2)
                receipts[current.finalSequence]?.admitted = true
                try await acknowledgePlayed(current.finalSequence)
                signalPlaybackCredit()
            }
        }
    }
    private func acknowledgePlayed(_ sequence: UInt64) async throws {
        guard let receipt = receipts[sequence], receipt.admitted, receipt.played,
              let lease, let writer else { return }
        receipts.removeValue(forKey: sequence)
        if receipts.isEmpty { playbackProgressDeadline = nil }
        try await writer.send(RuntimeMediaCodecV2.acknowledgement(session: lease.sessionId, sequence: receipt.network, rendered: true), deadline: ProcessInfo.processInfo.systemUptime + 2)
    }
    public func stop(deadline: TimeInterval? = nil) async -> Bool {
        let result = await beginCleanup(deadline: deadline).value
        if let starting { _ = await starting.value }
        if let reading { await reading.value }
        if let maintenance { await maintenance.value }
        return result
    }
    public func suspendCapture() -> Bool { !terminal && capture?.suspendCapture() == true }
    public func resumeCapture() -> Bool { !terminal && capture?.resumeCapture() == true }
    private func beginCleanup(deadline externalDeadline: TimeInterval? = nil) -> Task<Bool, Never> {
        if let cleanup { return cleanup }
        // Media v3 closes admission without terminating the socket reader, so
        // the one read loop can still receive the acknowledgement; media v2 goes
        // straight to terminal exactly as before. Only a live sole reader can
        // ever receive that acknowledgement, so the transition is refused when
        // there is none rather than parking cleanup on an unresolvable waiter.
        let draining = mediaVersion == 3 && pairStarted && lease != nil && connection != nil
            && reading != nil && !readingEnded
        state = draining ? .finishingCapture : .terminal
        pendingPlayback = nil; receipts.removeAll(); playbackProgressDeadline = nil; signalPlaybackCredit()
        maintenance?.cancel()
        let deadline = min(ProcessInfo.processInfo.systemUptime + Self.maximumCloseSeconds, externalDeadline ?? .infinity)
        let capture = capture, delivery = delivery, renderer = renderer, connection = connection, writer = writer, lease = lease, finalPair = pairStarted, clock = clock, maintenance = maintenance
        let task = Task { () -> Bool in
            let watchdog = Task {
                do {
                    try await Task.sleep(for: .seconds(max(0, deadline - ProcessInfo.processInfo.systemUptime)))
                    connection?.cancel()
                } catch { /* cancelled only after all owned cleanup settles */ }
            }
            var confirmed = true
            var nativeConfirmed = true
            var finalPairUndelivered = false
            // A v3 lease that never reaches the exchange still claims nothing.
            var drain = mediaVersion == 3 ? TimedMediaDrainOutcome.unconfirmed(reason: "drain_not_attempted") : .notApplicable
            await maintenance?.value
            if let capture, await capture.stop() != .stopped { confirmed = false; nativeConfirmed = false }
            if let delivery, await delivery.finish() == false { confirmed = false }
            var finalPairSequence: UInt64?
            if finalPair, let lease {
                do {
                    let pair = try clock.sample()
                    try await self.metadata(RuntimeMediaCodecV2.clockPair(session: lease.sessionId, pair: pair), deadline: deadline)
                    finalPairSequence = pair.sequence
                } catch { confirmed = false; finalPairUndelivered = true }
            }
            // An unconfirmed drain is its own explicit fact. Exactly like an
            // undelivered final pair, it does not veto confirmed native cleanup
            // and it must not be spelled as interrupted capture delivery.
            if draining { drain = await self.finishCapture(pairSequence: finalPairSequence, deadline: deadline) }
            if let renderer, await renderer.stop() != .stopped { confirmed = false; nativeConfirmed = false }
            if let connection, await connection.close() == false { confirmed = false; nativeConfirmed = false }
            await writer?.finish()
            watchdog.cancel(); await watchdog.value
            let withinBudget = ProcessInfo.processInfo.systemUptime <= deadline
            self.complete(nativeConfirmed: nativeConfirmed && withinBudget, delivered: confirmed && withinBudget,
                finalPairUndelivered: finalPairUndelivered, drain: drain)
            return confirmed && withinBudget
        }
        cleanup = task
        return task
    }
    /// Sends the one capture-finish record carrying the exact retained boundary
    /// and awaits the byte-matching acknowledgement on the same connection. The
    /// wait adds no sleep, retry, poll or deadline: the cleanup watchdog above
    /// is what eventually wakes a blocked read.
    private func finishCapture(pairSequence: UInt64?, deadline: TimeInterval) async -> TimedMediaDrainOutcome {
        guard let lease, let writer, let pairSequence,
              let boundary = try? CaptureFinishBoundary(session: lease.sessionId, captureEpoch: captureEpoch,
                  frame: lastFrame, finalClockPairSequence: pairSequence) else {
            state = .terminal
            return .unconfirmed(reason: "drain_not_attempted")
        }
        expectedBoundary = boundary
        do {
            try await writer.send(RuntimeMediaCodecV3.captureFinish(boundary), deadline: deadline)
        } catch {
            settleFinish(.unconfirmed(reason: "drain_write_failed"))
        }
        var outcome = await awaitFinish()
        // Past the one close deadline the deadline is the truthful cause, not
        // whatever transport error the watchdog's cancellation produced.
        if case .unconfirmed = outcome, ProcessInfo.processInfo.systemUptime > deadline {
            outcome = .unconfirmed(reason: "drain_deadline")
        }
        state = .terminal
        signalPlaybackCredit()
        return outcome
    }
    private func complete(nativeConfirmed: Bool, delivered: Bool, finalPairUndelivered: Bool,
                          drain: TimedMediaDrainOutcome) {
        let value = TimedCycleEnd(nativeCleanupConfirmed: nativeConfirmed, deliveryComplete: delivered,
            transportFailure: transportFailure, finalPairUndelivered: finalPairUndelivered,
            disconnectedAt: disconnectedAt ?? nowMonotonic(), captureEpoch: captureEpoch, drain: drain)
        ended = value; let reply = endWaiter; endWaiter = nil; reply?.resume(returning: value)
    }
}

/// One native socket write. All callers retain their own bounded admission;
/// this is a small control-write serializer, not another PCM jitter buffer.
private actor TimedMediaWriter {
    private struct Pending {
        let bytes: Data, deadline: TimeInterval, reply: CheckedContinuation<Void, Error>
    }
    private let connection: any RuntimeMediaConnection
    private let failed: @Sendable (Error) async -> Void
    private var queue: [Pending] = []
    private var queuedBytes = 0
    private var worker: Task<Void, Never>?
    private var closed = false
    init(_ connection: any RuntimeMediaConnection, failed: @escaping @Sendable (Error) async -> Void) {
        self.connection = connection; self.failed = failed
    }
    func send(_ data: Data, deadline: TimeInterval) async throws {
        guard !closed, queue.count < 16, queuedBytes + data.count <= 69_632 else { throw RuntimeMediaConnectionError.busy }
        try await withCheckedThrowingContinuation { reply in
            queue.append(Pending(bytes: data, deadline: deadline, reply: reply)); queuedBytes += data.count
            if worker == nil { worker = Task { await self.pump() } }
        }
    }
    private func pump() async {
        while !queue.isEmpty, !closed {
            let value = queue.removeFirst(); queuedBytes -= value.bytes.count
            do {
                guard value.deadline > ProcessInfo.processInfo.systemUptime else { throw RuntimeMediaConnectionError.timedOut }
                try await connection.write(value.bytes, deadline: value.deadline)
                value.reply.resume()
            } catch {
                closed = true
                // Record the primary write error before induced read-close or
                // rejected queued writes can be mistaken for its cause.
                await failed(error)
                value.reply.resume(throwing: error); connection.cancel()
            }
        }
        if closed { rejectPending() }
        worker = nil
    }
    private func rejectPending() {
        let abandoned = queue; queue.removeAll(); queuedBytes = 0
        for value in abandoned { value.reply.resume(throwing: RuntimeMediaConnectionError.closed) }
    }
    func finish() async {
        closed = true; rejectPending()
        if let worker { await worker.value }
    }
}

/// Exactly one delivery owns socket progress. Backpressure remains in the
/// capture primitive's bounded queue, not a second PCM queue or task per sample.
private final class CaptureWriteSlot: @unchecked Sendable {
    private let lock = NSLock()
    private let handler: @Sendable (CaptureDelivery) async -> Bool
    private let ready: @Sendable () -> Void
    private var worker: Task<Void, Never>?
    private var closed = false, failed = false
    init(handler: @escaping @Sendable (CaptureDelivery) async -> Bool, ready: @escaping @Sendable () -> Void) {
        self.handler = handler; self.ready = ready
    }
    func offer(_ value: CaptureDelivery) -> AudioAdmission {
        lock.withLock {
            guard !closed else { return .closed }
            guard worker == nil else { return .backpressured }
            worker = Task {
                let success = await handler(value)
                lock.withLock { worker = nil; if !success { closed = true; failed = true } }
                ready()
            }
            return .accepted
        }
    }
    func finish() async -> Bool {
        let current = lock.withLock { closed = true; return worker }
        await current?.value
        return lock.withLock { !failed }
    }
}
