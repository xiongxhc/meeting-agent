import Foundation

public protocol TimedMediaControl: AnyObject {
    func start(_ lease: TimedMediaLease) -> Bool
    func stop() -> Bool
    func takeEvents() -> [BridgeEvent]
}
public final class TimedMediaControlOwner: TimedMediaControl {
    private let session: TimedMediaSession
    private let cancellation: BridgeCancellation
    private var pending: Task<Void, Never>?
    private var stopResult: Bool?
    public init(session: TimedMediaSession, cancellation: BridgeCancellation) {
        self.session = session; self.cancellation = cancellation
    }
    public func start(_ lease: TimedMediaLease) -> Bool {
        guard pending == nil, stopResult == nil, !cancellation.isCancelled else { return false }
        return perform(seconds: 18, observeCancellation: true) { [session] in await session.start(lease) } ?? false
    }
    public func stop() -> Bool {
        if let stopResult { return stopResult }
        let old = pending; old?.cancel()
        let deadline = ProcessInfo.processInfo.systemUptime + TimedMediaSession.maximumCloseSeconds
        let result = perform(seconds: TimedMediaSession.maximumCloseSeconds, observeCancellation: false) { [session] in
            let clean = await session.stop(deadline: deadline)
            await old?.value
            return clean
        } ?? false
        stopResult = result; return result
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
    private let factory: @Sendable (UInt64, TimeInterval?) -> TimedMediaCycle
    private let nowUnixMs: @Sendable () -> UInt64
    private var cycle: TimedMediaCycle?
    private var supervisor: Task<Void, Never>?
    private var stopRequested = false
    private var reconnectDeadline: TimeInterval?
    private var attempts = 0
    public private(set) var diagnostics: Set<String> = []
    private var events: [BridgeEvent] = []
    public func takeEvents() -> [BridgeEvent] { let values = events; events.removeAll(); return values }
    private func event(_ value: BridgeEvent) {
        // One initial connect, at most3 retry attempts and one terminal stop:
        // <=15 lifecycle +4 unique static diagnostics, even without polling.
        guard events.count < 24 else { return }
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
                nowUnixMs: @escaping @Sendable () -> UInt64) {
        let metadataBudget = TimedMetadataBudget()
        self.nowUnixMs = nowUnixMs
        factory = { epoch, deadline in
            TimedMediaCycle(clock: clock, playbackRequest: playbackRequest, captureRequest: captureRequest,
                connectionFactory: connectionFactory, captureFactory: captureFactory, rendererFactory: rendererFactory,
                nowUnixMs: nowUnixMs, firstEpoch: epoch, admissionDeadline: deadline, metadataBudget: metadataBudget)
        }
    }
    public func start(_ lease: TimedMediaLease) async -> Bool {
        guard cycle == nil, !stopRequested else { return false }
        let first = factory(1, nil); cycle = first
        guard await first.start(lease), !stopRequested else { return false }
        event(.mediaConnected(endpoint: lease.connectEndpoint))
        supervisor = Task { await self.supervise(lease, first: first) }
        return true
    }
    private func supervise(_ lease: TimedMediaLease, first: TimedMediaCycle) async {
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
            if reconnectDeadline == nil {
                let now = nowUnixMs()
                let expiryRemaining = lease.expiresAtMs > now ? Double(lease.expiresAtMs - now) / 1000 : 0
                reconnectDeadline = min(ended.disconnectedAt + Double(lease.reconnectWindowMs) / 1000,
                    ProcessInfo.processInfo.systemUptime + expiryRemaining)
            }
            guard let deadline = reconnectDeadline, attempts < 3, ended.captureEpoch < UInt64.max,
                  ProcessInfo.processInfo.systemUptime + 0.1 < deadline, nowUnixMs() < lease.expiresAtMs else {
                diagnostic("reconnect_exhausted"); return
            }
            attempts += 1
            event(.reconnecting(attempt: attempts))
            do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
            guard !stopRequested, !Task.isCancelled, ProcessInfo.processInfo.systemUptime < deadline else { return }
            let next = factory(ended.captureEpoch + 1, deadline); current = next; cycle = next
            // Only complete ACK/native/capture readiness ends this outage.
            // Failed attempts and their cleanup retain the original deadline.
            if await next.start(lease) {
                reconnectDeadline = nil
                if !stopRequested {
                    event(.mediaConnected(endpoint: lease.connectEndpoint))
                    event(.reconnected(attempt: attempts))
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
        if let cycle {
            let ended = await cycle.waitEnded()
            if !ended.deliveryComplete { diagnostic("capture_delivery_interrupted") }
            if ended.finalPairUndelivered { diagnostic("final_clock_pair_undelivered") }
            result = ended.nativeCleanupConfirmed
        } else { result = true }
        if firstStop, cycle != nil { event(.mediaDisconnected(reason: result ? "media_stopped" : "media_cleanup_unconfirmed")) }
        return result
    }
}

private struct TimedCycleEnd: Sendable {
    let nativeCleanupConfirmed: Bool, deliveryComplete: Bool, transportFailure: Bool
    let finalPairUndelivered: Bool
    let disconnectedAt: TimeInterval, captureEpoch: UInt64
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
    private let nowUnixMs: @Sendable () -> UInt64
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
    private var terminal = false, pairStarted = false
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
                nowUnixMs: @escaping @Sendable () -> UInt64, firstEpoch: UInt64,
                admissionDeadline: TimeInterval?, metadataBudget: TimedMetadataBudget) {
        self.clock = clock; self.playbackRequest = playbackRequest; self.captureRequest = captureRequest
        self.connectionFactory = connectionFactory; self.captureFactory = captureFactory
        self.rendererFactory = rendererFactory; self.nowUnixMs = nowUnixMs
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
            guard !terminal, lease.expiresAtMs > nowUnixMs() else { throw RuntimeMediaConnectionError.closed }
            self.lease = lease
            let connection = try connectionFactory(lease.connectEndpoint); self.connection = connection
            let writer = TimedMediaWriter(connection); self.writer = writer
            let deadline = min(ProcessInfo.processInfo.systemUptime + 2, admissionDeadline ?? .infinity)
            try await connection.open(deadline: deadline)
            try checkActive()
            try checkAdmissionDeadline()
            try await writer.send(RuntimeMediaCodecV2.authentication(session: lease.sessionId, bridge: lease.bridgeSessionId, token: lease.credential), deadline: deadline)
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
            guard await renderer.start(playbackRequest) == .started else { throw RuntimeMediaConnectionError.closed }
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
            guard await capture.start(request, sink: { delivery.offer($0) }) == .started else { throw RuntimeMediaConnectionError.closed }
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
        if let admissionDeadline, ProcessInfo.processInfo.systemUptime >= admissionDeadline { throw RuntimeMediaConnectionError.timedOut }
    }
    private func noteFailure(_ error: Error) {
        guard !terminal else { return }
        disconnectedAt = disconnectedAt ?? ProcessInfo.processInfo.systemUptime
        transportFailure = error is RuntimeMediaConnectionError
    }
    private func checkActive() throws {
        guard !Task.isCancelled, !terminal, let lease, lease.expiresAtMs > nowUnixMs() else { throw RuntimeMediaConnectionError.closed }
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
                    try await metadata(RuntimeMediaCodecV2.epoch(session: lease.sessionId, bridge: lease.bridgeSessionId, domain: clock.clockDomainId, epoch: captureEpoch))
                }
                var timing = try RuntimeMediaCodecV2.timing(packet)
                timing.replaceSubrange(4..<12, with: RuntimeMediaCodecV2.be(captureEpoch))
                try await writer.send(RuntimeMediaCodecV2.capture(session: lease.sessionId, timing: timing, pcm: packet.pcm), deadline: ProcessInfo.processInfo.systemUptime + 2)
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
            case .failed: throw RuntimeMediaConnectionError.unavailable
            }
            return true
        } catch { connection.cancel(); return false }
    }
    private func metadata(_ bytes: Data, deadline: TimeInterval? = nil) async throws {
        guard let writer else { throw RuntimeMediaConnectionError.closed }
        let now = ProcessInfo.processInfo.systemUptime
        try await metadataBudget.reserve(now)
        try await writer.send(bytes, deadline: min(now + 2, deadline ?? now + 2))
    }
    private func maintain() async {
        do {
            while !terminal {
                try await Task.sleep(for: .seconds(1))
                try Task.checkCancellation(); try checkActive()
                guard renderer?.failure == nil, capture?.state == .running, let lease else { throw RuntimeMediaConnectionError.unavailable }
                if let playbackProgressDeadline, ProcessInfo.processInfo.systemUptime >= playbackProgressDeadline { throw RuntimeMediaConnectionError.timedOut }
                try await metadata(RuntimeMediaCodecV2.clockPair(session: lease.sessionId, pair: clock.sample()))
            }
        } catch { if !terminal { _ = beginCleanup() } }
    }
    private func readLoop() async {
        guard let connection else { return }
        var partialDeadline: TimeInterval?
        do {
            let initial = afterAuthentication; afterAuthentication.removeAll()
            for message in initial { try await receive(message) }
            while !terminal {
                if decoder.awaitingPlaybackBody {
                    var heldForCredit = false
                    while !terminal && (pendingPlayback != nil || receipts.count >= 12) {
                        heldForCredit = true
                        await withCheckedContinuation { playbackCredit = $0 }
                    }
                    if terminal { break }
                    // A complete fixed header held for native credit is not a
                    // malicious slow fragment. Body progress gets its own bound.
                    if heldForCredit { partialDeadline = ProcessInfo.processInfo.systemUptime + 2 }
                }
                let bytes = try await connection.read(maximum: decoder.nextReadMaximum, deadline: partialDeadline)
                if terminal { break }
                guard !bytes.isEmpty else { throw RuntimeMediaConnectionError.closed }
                let messages = try decoder.append(bytes)
                for message in messages { try await receive(message) }
                if decoder.hasIncompletePacket {
                    if partialDeadline == nil { partialDeadline = ProcessInfo.processInfo.systemUptime + 2 }
                } else { partialDeadline = nil }
            }
        } catch { if !terminal { noteFailure(error); _ = await beginCleanup().value } }
    }
    private func receive(_ message: RuntimeMediaInbound) async throws {
        try checkActive()
        guard let renderer, let lease, let writer else { throw RuntimeMediaConnectionError.closed }
        switch message {
        case .authenticated: throw BridgeProcessError.invalidInput
        case .flush(let source, let generation):
            guard source == lease.sessionId, generation > 0 else { throw BridgeProcessError.invalidInput }
            guard generation > lastFlushedGeneration else { return }
            guard runtimeGeneration == nil || runtimeGeneration == generation else { return }
            receipts.removeAll(); pendingPlayback = nil; playbackProgressDeadline = nil
            guard await renderer.cancel(expectedGeneration: renderer.generation) == .stopped else { throw RuntimeMediaConnectionError.closed }
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
                if lastFlushedGeneration > 0, !renderer.resume(generation: renderer.generation) { throw RuntimeMediaConnectionError.closed }
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
        guard !terminal, renderer?.generation == generation else { return }
        playbackProgressDeadline = ProcessInfo.processInfo.systemUptime + 2
        if receipts[sequence]?.generation == generation { receipts[sequence]?.played = true }
        do { try await acknowledgePlayed(sequence); try await pumpPlayback(); signalPlaybackCredit() }
        catch { _ = await beginCleanup().value }
    }
    private func signalPlaybackCredit() { let reply = playbackCredit; playbackCredit = nil; reply?.resume() }
    private func pumpPlayback() async throws {
        guard !playbackPumping, !terminal, let renderer, let writer, let lease else { return }
        playbackPumping = true
        defer { playbackPumping = false }
        while let current = pendingPlayback, !terminal {
            let count = min(960, current.frame.pcm.count - current.offset)
            let sequence = playbackSequence + 1
            let part = Data(current.frame.pcm[current.offset..<current.offset + count])
            switch renderer.enqueue(try PlaybackPcmPacket(generation: renderer.generation, sequence: sequence, pcm: part)) {
            case .backpressured: return
            case .closed: throw RuntimeMediaConnectionError.closed
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
        terminal = true
        pendingPlayback = nil; receipts.removeAll(); signalPlaybackCredit()
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
            await maintenance?.value
            if let capture, await capture.stop() != .stopped { confirmed = false; nativeConfirmed = false }
            if let delivery, await delivery.finish() == false { confirmed = false }
            if finalPair, let lease {
                do { try await self.metadata(RuntimeMediaCodecV2.clockPair(session: lease.sessionId, pair: clock.sample()), deadline: deadline) }
                catch { confirmed = false; finalPairUndelivered = true }
            }
            if let renderer, await renderer.stop() != .stopped { confirmed = false; nativeConfirmed = false }
            if let connection, await connection.close() == false { confirmed = false; nativeConfirmed = false }
            await writer?.finish()
            watchdog.cancel(); await watchdog.value
            let withinBudget = ProcessInfo.processInfo.systemUptime <= deadline
            self.complete(nativeConfirmed: nativeConfirmed && withinBudget, delivered: confirmed && withinBudget, finalPairUndelivered: finalPairUndelivered)
            return confirmed && withinBudget
        }
        cleanup = task
        return task
    }
    private func complete(nativeConfirmed: Bool, delivered: Bool, finalPairUndelivered: Bool) {
        let value = TimedCycleEnd(nativeCleanupConfirmed: nativeConfirmed, deliveryComplete: delivered,
            transportFailure: transportFailure, finalPairUndelivered: finalPairUndelivered,
            disconnectedAt: disconnectedAt ?? ProcessInfo.processInfo.systemUptime, captureEpoch: captureEpoch)
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
    private var queue: [Pending] = []
    private var queuedBytes = 0
    private var worker: Task<Void, Never>?
    private var closed = false
    init(_ connection: any RuntimeMediaConnection) { self.connection = connection }
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
                closed = true; value.reply.resume(throwing: error); connection.cancel()
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
