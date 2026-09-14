import Foundation
@preconcurrency import AVFAudio
import AudioToolbox
import CoreAudio

public struct PlaybackRequest: Sendable {
    public let outputDeviceUID: String
    public let operationBudget: TimeInterval
    public init(outputDeviceUID: String, operationBudget: TimeInterval = 5) throws {
        guard !outputDeviceUID.isEmpty, outputDeviceUID.utf8.count <= 512,
              !outputDeviceUID.contains("\0"), operationBudget.isFinite,
              operationBudget > 0, operationBudget <= 30 else { throw AudioPrimitiveError.invalidRequest }
        self.outputDeviceUID = outputDeviceUID; self.operationBudget = operationBudget
    }
}

public struct PlaybackPcmPacket: Sendable {
    public let generation: UInt64
    public let sequence: UInt64
    public let pcm: Data
    /// Exactly mono signed-16 little-endian at 24 kHz; a real unpadded tail is allowed.
    public init(generation: UInt64, sequence: UInt64, pcm: Data) throws {
        guard generation > 0, sequence > 0, !pcm.isEmpty, pcm.count <= 960,
              pcm.count.isMultiple(of: 2) else { throw AudioPrimitiveError.invalidRequest }
        self.generation = generation; self.sequence = sequence; self.pcm = pcm
    }
}

public protocol OutputDeviceLookup: Sendable {
    func resolve(uid: String) throws -> UInt32
    func usable(_ device: UInt32) -> Bool
}
public protocol OutputEngineBackend: AnyObject, Sendable {
    func selectDevice(_ device: UInt32) throws
    func currentDevice() throws -> UInt32
    func start(failed: @escaping @Sendable () -> Void) throws
    func schedule(_ pcm: Data, completion: @escaping @Sendable () -> Void) throws
    func cancel() throws
    func stop() throws
}
public protocol NativeAudioOutputBackend: AnyObject, Sendable {
    func start(_ request: PlaybackRequest, failed: @escaping @Sendable () -> Void) throws
    func schedule(_ pcm: Data, completion: @escaping @Sendable () -> Void) throws
    func cancel() throws
    func stop() throws
}

/// Used only on the owner's native queue. The engine factory is lazy, including on UID failure.
public final class SelectedAudioOutputBackend: NativeAudioOutputBackend, @unchecked Sendable {
    private let devices: any OutputDeviceLookup
    private let engineFactory: @Sendable () -> any OutputEngineBackend
    private var engine: (any OutputEngineBackend)?
    private var device: UInt32?
    public init(devices: any OutputDeviceLookup = CoreAudioOutputDeviceLookup(),
                engineFactory: @escaping @Sendable () -> any OutputEngineBackend = { AVAudioOutputEngine() }) {
        self.devices = devices; self.engineFactory = engineFactory
    }
    public func start(_ request: PlaybackRequest, failed: @escaping @Sendable () -> Void) throws {
        guard engine == nil else { throw AudioPrimitiveError.ownershipUnconfirmed }
        let selected = try devices.resolve(uid: request.outputDeviceUID)
        guard selected != kAudioObjectUnknown, devices.usable(selected) else { throw AudioPrimitiveError.nativeFailure }
        let candidate = engineFactory(); engine = candidate; device = selected
        try candidate.selectDevice(selected)
        guard try candidate.currentDevice() == selected else { throw AudioPrimitiveError.nativeFailure }
        try candidate.start(failed: failed)
    }
    public func schedule(_ pcm: Data, completion: @escaping @Sendable () -> Void) throws {
        guard let engine, let device, devices.usable(device), try engine.currentDevice() == device else {
            throw AudioPrimitiveError.nativeFailure
        }
        try engine.schedule(pcm, completion: completion)
    }
    public func cancel() throws { try engine?.cancel() }
    public func stop() throws { try engine?.stop(); engine = nil; device = nil }
}

/// One physical engine lifecycle. Each confirmed flush permits an explicitly resumed generation.
/// Two reserved/scheduled packets plus ten pending packets bound memory and native lookahead.
public final class AudioOutputRenderer: @unchecked Sendable {
    private enum State { case idle, starting, running, flushing, paused, stopping, stopped, failed }
    private let lock = NSLock()
    private let nativeQueue = DispatchQueue(label: "meeting.audio.render.native")
    private let ownerQueue: DispatchQueue
    private let backendFactory: @Sendable () -> any NativeAudioOutputBackend
    private var backend: (any NativeAudioOutputBackend)? // nativeQueue only
    private var state: State = .idle
    private var request: PlaybackRequest?
    private var pending: [PlaybackPcmPacket] = [], scheduled: [PlaybackPcmPacket] = []
    private var completionQueued: Set<UInt64> = []
    private var currentGeneration: UInt64 = 1, lastAccepted: UInt64 = 0, lastPlayed: UInt64 = 0
    private var operation: UInt64 = 0
    private var timer: DispatchSourceTimer?
    private var startReply: (@Sendable (AudioStartOutcome) -> Void)?
    private var stopReply: (@Sendable (AudioStopOutcome) -> Void)?
    private var fault: AudioPrimitiveError?
    public var generation: UInt64 { lock.withLock { currentGeneration } }
    public var lastPlayedSequence: UInt64 { lock.withLock { lastPlayed } }
    public var failure: AudioPrimitiveError? { lock.withLock { fault } }
    public convenience init(backendFactory: @escaping @Sendable () -> any NativeAudioOutputBackend = { SelectedAudioOutputBackend() }) {
        self.init(backendFactory: backendFactory, ownerQueue: DispatchQueue(label: "meeting.audio.render.owner"))
    }
    init(backendFactory: @escaping @Sendable () -> any NativeAudioOutputBackend, ownerQueue: DispatchQueue) {
        self.backendFactory = backendFactory; self.ownerQueue = ownerQueue
    }
    public func start(_ request: PlaybackRequest) async -> AudioStartOutcome {
        if Task.isCancelled { return .cancelled }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                beginStart(request) { continuation.resume(returning: $0) }
            }
        } onCancel: { self.beginEnd(flush: false) { _ in } }
    }
    private func beginStart(_ request: PlaybackRequest, reply: @escaping @Sendable (AudioStartOutcome) -> Void) {
        lock.lock()
        guard state == .idle else { lock.unlock(); reply(.rejected); return }
        state = .starting; self.request = request; startReply = reply; operation += 1
        let ticket = operation
        lock.unlock()
        deadline(ticket, seconds: request.operationBudget)
        nativeQueue.async { [self] in
            guard lock.withLock({ state == .starting && operation == ticket }) else { return }
            let native = backendFactory(); backend = native
            do {
                try native.start(request) { [weak self] in self?.fail(.nativeFailure) }
                lock.lock()
                let active = state == .starting && operation == ticket
                let callback = active ? startReply : nil
                if active { state = .running; startReply = nil; timer?.cancel(); timer = nil }
                lock.unlock()
                callback?(.started)
                // A queued stop owns cleanup after a cancelled/timed-out start.
            } catch { fail(.nativeFailure) }
        }
    }
    public func enqueue(_ packet: PlaybackPcmPacket) -> AudioAdmission {
        lock.lock()
        guard state == .running, packet.generation == currentGeneration,
              lastAccepted < UInt64.max, packet.sequence == lastAccepted + 1 else { lock.unlock(); return .closed }
        guard pending.count < 10 else { lock.unlock(); return .backpressured }
        pending.append(packet); lastAccepted = packet.sequence
        let work = reserveLocked()
        schedule(work)
        lock.unlock()
        return .accepted
    }
    private func reserveLocked() -> [PlaybackPcmPacket] {
        var work: [PlaybackPcmPacket] = []
        while state == .running, scheduled.count < 2, !pending.isEmpty {
            let packet = pending.removeFirst(); scheduled.append(packet); work.append(packet)
        }
        return work
    }
    private func schedule(_ packets: [PlaybackPcmPacket]) {
        for packet in packets {
            nativeQueue.async { [self] in
                guard lock.withLock({ state == .running && currentGeneration == packet.generation }) else { return }
                do {
                    guard let backend else { throw AudioPrimitiveError.nativeFailure }
                    try backend.schedule(packet.pcm) { [weak self] in
                        // Native playback callbacks never stop/flush or refill the player directly.
                        self?.queuePlayed(packet)
                    }
                } catch { fail(.nativeFailure) }
            }
        }
    }
    private func queuePlayed(_ packet: PlaybackPcmPacket) {
        lock.withLock {
            guard state == .running, packet.generation == currentGeneration,
                  scheduled.contains(where: { $0.sequence == packet.sequence }),
                  completionQueued.insert(packet.sequence).inserted else { return }
            ownerQueue.async { [weak self] in self?.played(packet) }
        }
    }
    private func played(_ packet: PlaybackPcmPacket) {
        lock.lock()
        guard state == .running, packet.generation == currentGeneration else { lock.unlock(); return }
        if packet.sequence <= lastPlayed { lock.unlock(); return }
        guard scheduled.first?.sequence == packet.sequence else { lock.unlock(); fail(.nativeFailure); return }
        scheduled.removeFirst(); completionQueued.remove(packet.sequence); lastPlayed = packet.sequence
        let work = reserveLocked()
        schedule(work); lock.unlock()
    }
    public func cancel() async -> AudioStopOutcome {
        await withCheckedContinuation { continuation in beginEnd(flush: true) { continuation.resume(returning: $0) } }
    }
    public func stop() async -> AudioStopOutcome {
        await withCheckedContinuation { continuation in beginEnd(flush: false) { continuation.resume(returning: $0) } }
    }
    public func resume(generation: UInt64) -> Bool {
        lock.withLock {
            guard state == .paused, generation == currentGeneration, fault == nil else { return false }
            state = .running; return true
        }
    }
    private func beginEnd(flush: Bool, reply: @escaping @Sendable (AudioStopOutcome) -> Void) {
        lock.lock()
        if state == .stopped || state == .idle { state = .stopped; lock.unlock(); reply(.stopped); return }
        guard stopReply == nil, state != .stopping, state != .flushing,
              !flush || state == .running || state == .paused,
              operation < UInt64.max, currentGeneration < UInt64.max else {
            lock.unlock(); reply(.failedUnconfirmed); return
        }
        state = flush ? .flushing : .stopping; operation += 1; currentGeneration += 1
        pending.removeAll(); scheduled.removeAll(); completionQueued.removeAll(); lastAccepted = 0; lastPlayed = 0
        let start = startReply; startReply = nil; stopReply = reply
        let ticket = operation, budget = request?.operationBudget ?? 5
        lock.unlock(); start?(.cancelled)
        deadline(ticket, seconds: budget)
        nativeQueue.async { [self] in
            do {
                if flush { try backend?.cancel() }
                else { try backend?.stop(); backend = nil }
                if flush && lock.withLock({ fault != nil }) { try backend?.stop(); backend = nil }
                lock.lock()
                guard operation == ticket else { lock.unlock(); return }
                state = flush && fault == nil ? .paused : (fault == nil ? .stopped : .failed)
                let callback = stopReply; stopReply = nil
                timer?.cancel(); timer = nil
                let outcome: AudioStopOutcome = fault == nil ? .stopped : .failedUnconfirmed
                lock.unlock(); callback?(outcome)
            } catch { fail(.nativeFailure) }
        }
    }
    private func deadline(_ ticket: UInt64, seconds: TimeInterval) {
        let source = DispatchSource.makeTimerSource(queue: ownerQueue)
        source.schedule(deadline: .now() + seconds)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            lock.lock()
            guard operation == ticket, startReply != nil || stopReply != nil else { lock.unlock(); return }
            if fault == nil { fault = .ownershipUnconfirmed }
            let start = startReply, stop = stopReply; startReply = nil; stopReply = nil
            timer?.cancel(); timer = nil
            let starting = state == .starting
            if starting { state = .failed }
            lock.unlock()
            start?(.failedUnconfirmed); stop?(.failedUnconfirmed)
            if starting { beginEnd(flush: false) { _ in } }
        }
        lock.withLock {
            if operation == ticket, startReply != nil || stopReply != nil { timer?.cancel(); timer = source }
            else { source.cancel() }
            source.resume()
        }
    }
    private func fail(_ error: AudioPrimitiveError) {
        lock.lock()
        guard fault == nil else { lock.unlock(); return }
        fault = error
        let start = startReply, stop = stopReply; startReply = nil; stopReply = nil
        let stopping = state == .stopping
        state = .failed
        lock.unlock()
        start?(.failedUnconfirmed); stop?(.failedUnconfirmed)
        if !stopping { beginEnd(flush: false) { _ in } }
    }
}

public struct CoreAudioOutputDeviceLookup: OutputDeviceLookup {
    public init() {}
    public func resolve(uid: String) throws -> UInt32 {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var qualifier = uid as CFString, device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafePointer(to: &qualifier) {
            AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                UInt32(MemoryLayout<CFString>.size), $0, &size, &device)
        }
        guard status == noErr,
              size == MemoryLayout<AudioObjectID>.size, device != kAudioObjectUnknown else { throw AudioPrimitiveError.nativeFailure }
        return device
    }
    public func usable(_ device: UInt32) -> Bool {
        var aliveAddress = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var alive: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(device, &aliveAddress, 0, nil, &size, &alive) == noErr, alive == 1 else { return false }
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        var streamBytes: UInt32 = 0
        return AudioObjectGetPropertyDataSize(device, &streams, 0, nil, &streamBytes) == noErr && streamBytes >= 4
    }
}

/// Instantiated only by an authorized start, never by renderer/config initialization.
public final class AVAudioOutputEngine: OutputEngineBackend, @unchecked Sendable {
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!
    private var observer: NSObjectProtocol?
    public init() {}
    public func selectDevice(_ device: UInt32) throws {
        guard device != kAudioObjectUnknown, engine == nil else { throw AudioPrimitiveError.invalidRequest }
        let engine = AVAudioEngine(); self.engine = engine
        player = AVAudioPlayerNode()
        guard let unit = engine.outputNode.audioUnit else { throw AudioPrimitiveError.nativeFailure }
        var selected = device
        guard AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                                   &selected, UInt32(MemoryLayout<UInt32>.size)) == noErr else { throw AudioPrimitiveError.nativeFailure }
    }
    public func currentDevice() throws -> UInt32 {
        guard let engine, let unit = engine.outputNode.audioUnit else { throw AudioPrimitiveError.nativeFailure }
        var device: UInt32 = 0, size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, &size) == noErr,
              size == MemoryLayout<UInt32>.size else { throw AudioPrimitiveError.nativeFailure }
        return device
    }
    public func start(failed: @escaping @Sendable () -> Void) throws {
        guard let engine, let player else { throw AudioPrimitiveError.nativeFailure }
        let hardware = engine.outputNode.outputFormat(forBus: 0)
        guard hardware.sampleRate > 0, hardware.channelCount > 0 else { throw AudioPrimitiveError.nativeFailure }
        engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: format)
        // The hardware mixer may convert rates/channels; the source contract remains mono 24 kHz.
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: engine, queue: nil) { _ in failed() }
        engine.prepare(); try engine.start()
    }
    public func schedule(_ pcm: Data, completion: @escaping @Sendable () -> Void) throws {
        guard let player, !pcm.isEmpty, pcm.count <= 960, pcm.count.isMultiple(of: 2),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count / 2)),
              let channel = buffer.floatChannelData?[0] else { throw AudioPrimitiveError.invalidRequest }
        buffer.frameLength = buffer.frameCapacity
        pcm.withUnsafeBytes { bytes in
            for index in 0..<Int(buffer.frameLength) {
                channel[index] = Float(Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: index * 2, as: Int16.self))) / 32768
            }
        }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in completion() }
        if !player.isPlaying { player.play() }
    }
    public func cancel() throws { player?.stop() }
    public func stop() throws {
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        player?.stop(); engine?.stop(); engine?.reset(); player = nil; engine = nil
    }
}
