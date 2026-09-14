import Foundation
import CoreMedia
import CoreGraphics
@preconcurrency import ScreenCaptureKit
import AppKit

public enum AudioStartOutcome: Equatable, Sendable { case started, cancelled, rejected, failedUnconfirmed }
public enum AudioCaptureState: Equatable, Sendable { case idle, starting, running, stopping, stopped, failedUnconfirmed }
public struct CaptureRequest: Sendable {
    public let pid: Int32, displayID: UInt32
    public let bundlePath: String, bundleIdentifier: String, build: String
    public let launchDate: Date
    public let startBudget: TimeInterval, stopBudget: TimeInterval
    public init(pid: Int32, bundlePath: String, bundleIdentifier: String, build: String, launchDate: Date,
                displayID: UInt32, format: AudioFormat = AudioFormat(encoding: "pcm_s16le", sampleRate: 24_000, channels: 1, frameMilliseconds: 20),
                startBudget: TimeInterval = 5, stopBudget: TimeInterval = 5) throws {
        guard pid > 0, displayID > 0, bundlePath.hasPrefix("/"),
              [bundlePath, bundleIdentifier, build].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 && !$0.contains("\0") }),
              launchDate.timeIntervalSince1970.isFinite,
              startBudget.isFinite, stopBudget.isFinite, startBudget > 0, stopBudget > 0, startBudget <= 30, stopBudget <= 30,
              format == AudioFormat(encoding: "pcm_s16le", sampleRate: 24_000, channels: 1, frameMilliseconds: 20) else { throw AudioPrimitiveError.invalidRequest }
        self.pid = pid; self.displayID = displayID; self.bundlePath = bundlePath; self.bundleIdentifier = bundleIdentifier
        self.build = build; self.launchDate = launchDate; self.startBudget = startBudget; self.stopBudget = stopBudget
    }
}

public protocol NativeAudioCaptureBackend: AnyObject, Sendable {
    func start(request: CaptureRequest, sample: @escaping @Sendable (CMSampleBuffer, CMClock?) -> Void,
               failed: @escaping @Sendable () -> Void, completion: @escaping @Sendable (Bool) -> Void)
    func stop(completion: @escaping @Sendable (Bool) -> Void)
}

/// One native generation per instance. Backend and CPU work stay separately owned;
/// construction/invalid requests never enumerate or touch permission/device APIs.
public final class SystemAudioCapture: @unchecked Sendable {
    private struct DroppedInput {
        let pts: CMTime, duration: CMTime, format: PCMSourceFormat
        let clock: ObjectIdentifier?
    }
    private let lock = NSLock()
    private let nativeQueue = DispatchQueue(label: "feishu.capture.native")
    private let processingQueue: DispatchQueue
    private let factory: @Sendable () -> any NativeAudioCaptureBackend
    private let clock: any CaptureClockMapping
    private var backend: (any NativeAudioCaptureBackend)?
    private var status: AudioCaptureState = .idle
    public var state: AudioCaptureState { lock.withLock { status } }
    private var request: CaptureRequest?
    private var sink: (@Sendable (CaptureDelivery) -> AudioAdmission)?
    private var startReply: (@Sendable (AudioStartOutcome) -> Void)?
    private var stopReply: (@Sendable (AudioStopOutcome) -> Void)?
    private var input: [CapturedNativeAudio] = []
    private var pumpScheduled = false
    private var suspended = false, suspensionBoundary = false
    private var converter: PcmCaptureConverter?
    private var startResolved = false
    private var stopAttempt: UInt64 = 0
    private var stopInFlight = false, postStartStopNeeded = false
    private var inputDuration = CMTime.zero
    private var inputLoss: DroppedInput?
    // The following channel/converter fields are confined to processingQueue.
    private var output: [CaptureDelivery] = []
    private var resetAfterOutputLoss = false
    private var conversionFinished = false
    private var nativeStopped = false
    private var fault: AudioPrimitiveError?
    public var failure: AudioPrimitiveError? { lock.withLock { fault } }

    public convenience init(backendFactory: @escaping @Sendable () -> any NativeAudioCaptureBackend = { ScreenCaptureAudioBackend() },
                            clock: any CaptureClockMapping = CoreMediaCaptureClock()) {
        self.init(backendFactory: backendFactory, clock: clock, processingQueue: DispatchQueue(label: "feishu.capture.convert"))
    }
    init(backendFactory: @escaping @Sendable () -> any NativeAudioCaptureBackend,
                clock: any CaptureClockMapping = CoreMediaCaptureClock(),
                processingQueue: DispatchQueue) {
        factory = backendFactory; self.clock = clock; self.processingQueue = processingQueue
    }

    public func start(_ request: CaptureRequest, sink: @escaping @Sendable (CaptureDelivery) -> AudioAdmission) async -> AudioStartOutcome {
        await withTaskCancellationHandler {
            if Task.isCancelled { return .cancelled }
            return await withCheckedContinuation { continuation in
                beginStart(request, sink: sink) { continuation.resume(returning: $0) }
            }
        } onCancel: { self.beginStop { _ in } }
    }

    private func beginStart(_ request: CaptureRequest, sink: @escaping @Sendable (CaptureDelivery) -> AudioAdmission,
                            reply: @escaping @Sendable (AudioStartOutcome) -> Void) {
        lock.lock()
        guard status == .idle else { lock.unlock(); reply(.rejected); return }
        status = .starting; self.request = request; self.sink = sink; startReply = reply
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + request.startBudget) { [weak self] in
            guard let self else { return }
            let callback = self.lock.withLock { () -> (@Sendable (AudioStartOutcome) -> Void)? in
                guard self.status == .starting else { return nil }
                self.status = .failedUnconfirmed
                let callback = self.startReply; self.startReply = nil; return callback
            }
            if let callback { callback(.failedUnconfirmed); self.beginStop { _ in } }
        }
        nativeQueue.async { [self] in
            guard lock.withLock({ status == .starting }) else {
                lock.withLock { startResolved = true }; stopped(true, attempt: lock.withLock { stopAttempt }); return
            }
            let native = factory()
            lock.withLock { backend = native }
            native.start(request: request, sample: { [weak self] sample, sourceClock in self?.receive(sample, sourceClock: sourceClock) },
                failed: { [weak self] in self?.fail(.nativeFailure) }, completion: { [weak self] success in self?.started(success) })
        }
    }

    private func started(_ success: Bool) {
        lock.lock()
        guard !startResolved else { lock.unlock(); return }
        startResolved = true
        let stopping = status != .starting
        let callback = startReply; startReply = nil
        if !stopping { status = success ? .running : .failedUnconfirmed }
        lock.unlock()
        if stopping { requestNativeStop(afterStart: true); return }
        callback?(success ? .started : .failedUnconfirmed)
        if !success { beginStop { _ in } }
    }

    public func stop() async -> AudioStopOutcome {
        await withCheckedContinuation { continuation in beginStop { continuation.resume(returning: $0) } }
    }

    public func resumeDelivery() {
        lock.withLock {
            guard !pumpScheduled, status != .idle, status != .stopped else { return }
            pumpScheduled = true; processingQueue.async { [weak self] in self?.pump() }
        }
    }

    /// Logical suspension discards incoming samples, with an explicit unknown-duration gap.
    /// It does not stop/restart the native stream or imply permission/device cleanup.
    public func suspendCapture() -> Bool {
        lock.withLock {
            guard status == .running, !suspended else { return false }
            suspended = true; suspensionBoundary = true
            if !pumpScheduled { pumpScheduled = true; processingQueue.async { [weak self] in self?.pump() } }
            return true
        }
    }
    public func resumeCapture() -> Bool {
        lock.withLock {
            guard status == .running, suspended, !suspensionBoundary else { return false }
            suspended = false; return true
        }
    }

    private func beginStop(_ reply: @escaping @Sendable (AudioStopOutcome) -> Void) {
        lock.lock()
        if status == .idle || status == .stopped { status = .stopped; lock.unlock(); reply(.stopped); return }
        guard stopReply == nil else { lock.unlock(); reply(.failedUnconfirmed); return }
        status = .stopping; stopReply = reply
        let start = startReply; startReply = nil
        let budget = request?.stopBudget ?? 5
        lock.unlock(); start?(.cancelled)
        DispatchQueue.global().asyncAfter(deadline: .now() + budget) { [weak self] in
            guard let self else { return }
            let callback = self.lock.withLock { () -> (@Sendable (AudioStopOutcome) -> Void)? in
                guard self.status != .stopped else { return nil }
                self.status = .failedUnconfirmed
                let callback = self.stopReply; self.stopReply = nil; return callback
            }
            callback?(.failedUnconfirmed)
        }
        requestNativeStop()
    }

    private func requestNativeStop(afterStart: Bool = false) {
        lock.lock()
        if stopInFlight {
            if afterStart { postStartStopNeeded = true }
            lock.unlock(); return
        }
        guard stopAttempt < UInt64.max else { lock.unlock(); fail(.boundsExceeded); return }
        stopInFlight = true; stopAttempt += 1
        let attempt = stopAttempt
        lock.unlock()
        nativeQueue.async { [self] in
            guard let backend = lock.withLock({ backend }) else { stopCompleted(true, attempt: attempt); return }
            backend.stop { [weak self] success in self?.stopCompleted(success, attempt: attempt) }
        }
    }

    private func stopCompleted(_ success: Bool, attempt: UInt64) {
        lock.lock()
        guard stopInFlight, attempt == stopAttempt else { lock.unlock(); return }
        stopInFlight = false
        let again = postStartStopNeeded; postStartStopNeeded = false
        lock.unlock()
        if again { requestNativeStop(); return }
        stopped(success, attempt: attempt)
    }

    private func stopped(_ success: Bool, attempt: UInt64) {
        guard lock.withLock({ startResolved && attempt == stopAttempt }) else { return }
        processingQueue.async { [self] in
            guard lock.withLock({ attempt == stopAttempt }) else { return }
            if !success { fail(.nativeFailure); return }
            nativeStopped = true
            pump()
        }
    }

    private func receive(_ sample: CMSampleBuffer, sourceClock: CMClock?) {
        lock.lock()
        guard status == .running, !suspended else { lock.unlock(); return }
        do {
            let (format, frames) = try CapturedNativeAudio.inspect(sample)
            let duration = CMTime(value: Int64(frames), timescale: Int32(format.sampleRate))
            let queued = CMTimeAdd(inputDuration, duration)
            if inputLoss != nil || input.count >= 8 || !queued.isNumeric || CMTimeCompare(queued, CMTime(value: 1, timescale: 4)) > 0 {
                let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                if let loss = inputLoss {
                    guard loss.format == format, loss.clock == sourceClock.map(ObjectIdentifier.init), loss.pts.isNumeric, pts.isNumeric,
                          CMTimeCompare(CMTimeAdd(loss.pts, loss.duration), pts) == 0 else { throw AudioPrimitiveError.boundsExceeded }
                    let total = CMTimeAdd(loss.duration, duration)
                    guard total.isNumeric else { throw AudioPrimitiveError.boundsExceeded }
                    inputLoss = DroppedInput(pts: loss.pts, duration: total, format: format, clock: loss.clock)
                } else { inputLoss = DroppedInput(pts: pts, duration: duration, format: format, clock: sourceClock.map(ObjectIdentifier.init)) }
            } else {
                input.append(try CapturedNativeAudio.copy(sample, sourceClock: sourceClock, clock: clock))
                inputDuration = queued
            }
        }
        catch { lock.unlock(); fail(error as? AudioPrimitiveError ?? .malformedSamples); return }
        if !pumpScheduled {
            pumpScheduled = true
            processingQueue.async { [weak self] in self?.pump() }
        }
        lock.unlock()
    }

    private func pump() {
        guard lock.withLock({ status != .stopped }) else { return }
        if converter == nil && !conversionFinished { converter = PcmCaptureConverter { [weak self] in self?.deliver($0) } }
        flushOutput()
        while true {
            lock.lock()
            let source = input.isEmpty ? nil : input.removeFirst()
            if let source { inputDuration = CMTimeSubtract(inputDuration, CMTime(value: Int64(source.samples.count), timescale: Int32(source.format.sampleRate))) }
            let loss = source == nil ? inputLoss : nil
            if source == nil { inputLoss = nil }
            let boundary = source == nil && loss == nil && suspensionBoundary
            if boundary { suspensionBoundary = false }
            if source == nil && loss == nil && !boundary { pumpScheduled = false }
            lock.unlock()
            guard source != nil || loss != nil || boundary else { break }
            do {
                if let source { try converter?.append(source) }
                if boundary { try converter?.discontinue(reason: .suspended) }
                if let loss {
                    try converter?.discontinue(reason: .inputOverflow,
                        sourcePTS: loss.pts.isNumeric ? loss.pts : nil, sourceDuration: loss.duration)
                }
                if resetAfterOutputLoss {
                    try converter?.discontinue(reason: .outputOverflow, reportBoundary: false)
                    resetAfterOutputLoss = false; flushOutput()
                }
            } catch { fail(error as? AudioPrimitiveError ?? .conversionFailed); break }
        }
        if nativeStopped && !conversionFinished {
            do { try converter?.finish() } catch { fail(error as? AudioPrimitiveError ?? .conversionFailed) }
            conversionFinished = true; resetAfterOutputLoss = false; flushOutput()
        }
        if nativeStopped && conversionFinished && output.isEmpty {
            let result = lock.withLock { () -> ((@Sendable (AudioStopOutcome) -> Void)?, AudioStopOutcome) in
                let outcome: AudioStopOutcome = fault == nil ? .stopped : .failedUnconfirmed
                status = fault == nil ? .stopped : .failedUnconfirmed
                input.removeAll(); inputLoss = nil; inputDuration = .zero; sink = nil
                let reply = stopReply; stopReply = nil; return (reply, outcome)
            }
            result.0?(result.1)
        }
    }
    private func deliver(_ delivery: CaptureDelivery) {
        switch delivery {
        case .packet(let packet):
            let packetCount = output.reduce(0) { count, event in if case .packet = event { count + 1 } else { count } }
            if resetAfterOutputLoss || packetCount >= 10 {
                if let index = output.firstIndex(where: { if case .discontinuity = $0 { true } else { false } }) {
                    guard case .discontinuity(let loss) = output[index], loss.reason == .outputOverflow,
                          loss.epoch == packet.epoch, let range = loss.outputRange, range.upperBound == packet.outputRange.lowerBound else { fail(.boundsExceeded); return }
                    output[index] = .discontinuity(CaptureLoss(epoch: loss.epoch, reason: .outputOverflow, sourcePTS: nil,
                        sourceDuration: nil, outputRange: range.lowerBound..<packet.outputRange.upperBound))
                } else {
                    output.append(.discontinuity(CaptureLoss(epoch: packet.epoch, reason: .outputOverflow,
                        sourcePTS: nil, sourceDuration: nil, outputRange: packet.outputRange)))
                }
                resetAfterOutputLoss = true
            } else { output.append(delivery) }
        case .discontinuity:
            guard !output.contains(where: { if case .discontinuity = $0 { true } else { false } }) else { fail(.boundsExceeded); return }
            output.append(delivery)
        case .failed: return
        }
        flushOutput()
    }
    private func flushOutput() {
        while let event = output.first {
            if resetAfterOutputLoss, case .discontinuity(let loss) = event, loss.reason == .outputOverflow { return }
            guard let callback = lock.withLock({ sink }) else { return }
            switch callback(event) {
            case .accepted: output.removeFirst()
            case .backpressured: return
            case .closed: fail(.nativeFailure); return
            }
        }
    }
    private func fail(_ error: AudioPrimitiveError) {
        let first = lock.withLock { () -> Bool in
            guard fault == nil else { return false }; fault = error; status = .failedUnconfirmed; return true
        }
        guard first else { return }
        processingQueue.async { [weak self] in
            guard let self else { return }
            _ = self.lock.withLock { self.sink }?(.failed(error))
        }
        beginStop { _ in }
    }
}

/// Real public ScreenCaptureKit backend. None of these methods is used by tests.
public final class ScreenCaptureAudioBackend: NSObject, NativeAudioCaptureBackend, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "feishu.sck.lifecycle")
    private let sampleQueue = DispatchQueue(label: "feishu.sck.samples")
    private let callbackLock = NSLock()
    private var capture: SCStream?
    private var stopRequested = false
    private var onSample: (@Sendable (CMSampleBuffer, CMClock?) -> Void)?
    private var onFailure: (@Sendable () -> Void)?

    public override init() { super.init() }
    private func valid(_ request: CaptureRequest) -> Bool {
        guard let application = NSRunningApplication(processIdentifier: request.pid), !application.isTerminated,
              application.launchDate == request.launchDate, application.bundleIdentifier == request.bundleIdentifier,
              application.bundleURL?.path == request.bundlePath,
              Bundle(url: URL(fileURLWithPath: request.bundlePath))?.object(forInfoDictionaryKey: "CFBundleVersion") as? String == request.build else { return false }
        return true
    }
    public func start(request: CaptureRequest, sample: @escaping @Sendable (CMSampleBuffer, CMClock?) -> Void,
                      failed: @escaping @Sendable () -> Void, completion: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            guard !stopRequested, capture == nil, CGPreflightScreenCaptureAccess(), valid(request) else { completion(false); return }
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { [weak self] content, error in
                guard let self else { completion(false); return }
                self.queue.async {
                    guard !self.stopRequested, error == nil, let content, self.valid(request) else { completion(false); return }
                    let displays = content.displays.filter { $0.displayID == request.displayID }
                    let applications = content.applications.filter { $0.processID == request.pid && $0.bundleIdentifier == request.bundleIdentifier }
                    guard displays.count == 1, applications.count == 1 else { completion(false); return }
                    let filter = SCContentFilter(display: displays[0], including: applications, exceptingWindows: [])
                    let configuration = SCStreamConfiguration()
                    configuration.capturesAudio = true; configuration.sampleRate = 48_000; configuration.channelCount = 2
                    configuration.excludesCurrentProcessAudio = true
                    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
                    do { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.sampleQueue) }
                    catch { completion(false); return }
                    self.capture = stream
                    self.callbackLock.withLock { self.onSample = sample; self.onFailure = failed }
                    stream.startCapture { error in completion(error == nil) }
                }
            }
        }
    }
    public func stop(completion: @escaping @Sendable (Bool) -> Void) {
        queue.async { [self] in
            stopRequested = true
            guard let stream = capture else { completion(true); return }
            stream.stopCapture { [self] error in
                queue.async {
                    guard error == nil else { completion(false); return }
                    do { try stream.removeStreamOutput(self, type: .audio) }
                    catch { completion(false); return }
                    self.callbackLock.withLock { self.onSample = nil; self.onFailure = nil }
                    self.capture = nil; completion(true)
                }
            }
        }
    }
    public func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        callbackLock.withLock { onSample }?(sampleBuffer, stream.synchronizationClock)
    }
    public func stream(_ stream: SCStream, didStopWithError error: any Error) { callbackLock.withLock { onFailure }?() }
}
