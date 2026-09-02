import Foundation

/// The media half of the bridge.
///
/// **The architectural rule this file exists to hold.** Media frames travel
/// directly between this bridge and the Rust Conversation Runtime data plane.
/// TypeScript/Node is the control plane only: it sends `connect_media` with an
/// endpoint, a session token, a format and an expiry, and it receives
/// `media_connected`, `media_disconnected` and `audio_gap` back. It never
/// relays an audio frame, and it could not — `BridgeControlPlane`, the only door
/// to it, accepts a `BridgeEvent`, and no case of that enum can carry audio
/// bytes. The frame path here touches exactly two collaborators, the media
/// endpoint and the audio device, and neither is on the control plane.
///
/// The second rule, inherited from the rest of this package: a claim is made
/// only from what was observed. A gap whose end was not observed keeps
/// `endedAt: null` rather than being given a plausible one, a format that could
/// not be negotiated is a refusal rather than a quiet substitution, and a
/// silence the bridge itself caused — a mute, a barge-in — is not reported as an
/// `audio_gap` at all, because it is explained.

// MARK: - media types

/// A PCM stream shape, in the wire form `connect_media.format` carries:
/// `<encoding>/<sampleRate>/<channels>/<frameMs>ms`, e.g.
/// `pcm_s16le/48000/1/20ms`.
public struct AudioFormat: Equatable, Sendable {
    public let encoding: String
    public let sampleRate: Int
    public let channels: Int
    /// How much audio one frame carries. It sets the jitter buffer's bound in
    /// frames and the tolerance the capture gap detector uses.
    public let frameMilliseconds: Int

    public init(encoding: String, sampleRate: Int, channels: Int, frameMilliseconds: Int) {
        self.encoding = encoding
        self.sampleRate = sampleRate
        self.channels = channels
        self.frameMilliseconds = frameMilliseconds
    }

    public var wireValue: String {
        "\(encoding)/\(sampleRate)/\(channels)/\(frameMilliseconds)ms"
    }

    /// nil when the string is not a format this bridge understands. The caller
    /// refuses the session; it never falls back to a default, because a bridge
    /// capturing at a shape the runtime did not ask for is silent corruption.
    public static func parse(_ wireValue: String) -> AudioFormat? {
        let parts = wireValue.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 4, !parts[0].isEmpty, parts[3].hasSuffix("ms"),
            let sampleRate = Int(parts[1]), sampleRate > 0,
            let channels = Int(parts[2]), channels > 0,
            let frameMilliseconds = Int(parts[3].dropLast(2)), frameMilliseconds > 0
        else { return nil }
        return AudioFormat(
            encoding: String(parts[0]), sampleRate: sampleRate, channels: channels,
            frameMilliseconds: frameMilliseconds)
    }
}

/// One frame of encoded media on its way to or from the runtime. `payload` is
/// opaque bytes: nothing in this package inspects, decodes, resamples, or
/// stores them.
public struct AudioFrame: Equatable, Sendable {
    public let direction: AudioDirection
    /// 1-based, per direction, per media session.
    public let sequence: Int
    /// The monotonic media timeline, never the wall clock — a clock correction
    /// mid-meeting must not move a frame.
    public let timestampMilliseconds: Int
    public let payload: [UInt8]

    public init(
        direction: AudioDirection, sequence: Int, timestampMilliseconds: Int, payload: [UInt8]
    ) {
        self.direction = direction
        self.sequence = sequence
        self.timestampMilliseconds = timestampMilliseconds
        self.payload = payload
    }
}

// MARK: - ports

/// The bridge's only source of time, extending `BridgeClock` with the monotonic
/// reading frames are stamped from. A real implementation reads
/// `mach_absolute_time`; the tests move it by hand. Nothing here calls `Date()`.
public protocol MediaClock: BridgeClock {
    /// Milliseconds on a timeline that only moves forward. If it ever goes
    /// backwards the bridge fails the session rather than emitting a backwards
    /// stamp.
    func monotonicMilliseconds() -> Int
}

/// The data-plane connection to the Rust Conversation Runtime. This is the far
/// end of every frame: capture frames go into `send`, playback frames come out
/// of the sink, and nothing sits in between.
///
/// A real implementation opens a socket to the endpoint `connect_media`
/// carried. `LoopbackMediaClient` is the in-process stand-in the tests use.
public protocol MediaEndpointClient: AnyObject {
    /// - Returns: nil when the session opened, otherwise a machine-readable
    ///   reason it did not.
    func open(endpoint: String, sessionToken: String, format: AudioFormat) -> String?
    func send(_ frame: AudioFrame)
    func setPlaybackSink(_ sink: @escaping (AudioFrame) -> Void)
    func close(reason: String)
}

/// The machine's audio hardware. Real device I/O stays behind this protocol for
/// the reason `AccessibilityDriver` exists: so `swift test` needs no audio
/// device, no microphone permission, and no AVFoundation import in the testable
/// core.
public protocol AudioDevicePort: AnyObject {
    /// The formats this machine's capture and playback path can actually carry.
    /// An offered format that is not in here is refused, not approximated.
    var supportedFormats: [AudioFormat] { get }
    func play(_ frame: AudioFrame)
}

/// The door to the TypeScript coordinator, and the only one. It carries
/// `bridge-session/v1` events; the implementation stamps the session envelope
/// (session id, sequence) so the media half never has to know it.
///
/// Audio is not expressible on this surface. That is the point.
public protocol BridgeControlPlane: AnyObject {
    func emit(_ event: BridgeEvent, observedAt: String)
}

// MARK: - outcomes

public enum MediaConnectOutcome: Equatable, Sendable {
    case connected(AudioFormat)
    /// The bridge refused before opening anything: a format it cannot carry, an
    /// expired token, a session already open.
    case rejected(reason: String)
    /// The endpoint itself would not open.
    case failed(reason: String)
}

// MARK: - the bridge

/// Duplex media for one meeting.
///
/// Stateful, hence a class: the negotiated format, the monotonic baseline, the
/// jitter buffer, the mute flag and the barge-in gate are all session state.
/// Single-threaded by design — a real deployment drives it from the audio
/// device's callback thread and nothing else.
public final class AudioBridge {
    private let clock: any MediaClock
    private let device: any AudioDevicePort
    private let mediaClient: any MediaEndpointClient
    private let controlPlane: any BridgeControlPlane
    private let jitterBufferMilliseconds: Int

    public private(set) var negotiatedFormat: AudioFormat?
    public private(set) var isMuted = false

    /// How many frames the playback buffer holds before it starts dropping. Zero
    /// until a format is negotiated, because the bound is a duration and only
    /// the format converts it to frames.
    public private(set) var jitterBufferCapacityFrames = 0
    public private(set) var capturedFramesSent = 0
    public private(set) var playbackFramesDroppedByOverflow = 0
    public private(set) var playbackFramesDroppedByCancellation = 0
    public var bufferedPlaybackFrames: Int { jitterBuffer.count }

    private var jitterBuffer: [AudioFrame] = []
    private var playbackCancelled = false
    private var captureSequence = 0
    /// The monotonic reading and the wall instant of the last capture frame that
    /// was actually observed. Both are cleared by anything that explains a
    /// silence, so an explained silence cannot become a gap.
    private var lastCaptureMonotonic: Int?
    private var lastCaptureObservedAt: String?
    /// Start instant of a playback gap that is open — dropping is still
    /// happening, so its end has not been observed.
    private var openPlaybackGapStartedAt: String?

    /// - Parameters:
    ///   - jitterBufferMilliseconds: how much playback audio may queue up.
    ///     The default is deliberately shallow: barge-in must stop agent speech
    ///     within 300 ms, cancellation discards whatever is queued, and so a
    ///     buffer deeper than that budget buys nothing and costs latency on
    ///     every turn. 200 ms absorbs ordinary network jitter and still leaves
    ///     headroom under the 300 ms figure.
    public init(
        clock: any MediaClock,
        device: any AudioDevicePort,
        mediaClient: any MediaEndpointClient,
        controlPlane: any BridgeControlPlane,
        jitterBufferMilliseconds: Int = 200
    ) {
        precondition(jitterBufferMilliseconds > 0, "the jitter buffer bound must be positive")
        self.clock = clock
        self.device = device
        self.mediaClient = mediaClient
        self.controlPlane = controlPlane
        self.jitterBufferMilliseconds = jitterBufferMilliseconds
    }

    // MARK: connect / disconnect

    /// Honours one `connect_media` command. The bridge dials the endpoint
    /// itself; the coordinator that sent the command does not carry a byte of
    /// what follows.
    public func connect(endpoint: String, sessionToken: String, format: String, expiresAt: String)
        -> MediaConnectOutcome
    {
        guard negotiatedFormat == nil else { return .rejected(reason: "media_already_connected") }
        guard let requested = AudioFormat.parse(format) else {
            return .rejected(reason: "media_format_unparseable")
        }
        guard device.supportedFormats.contains(requested) else {
            return .rejected(reason: "media_format_unsupported")
        }

        let observedAt = clock.now()
        guard let expiry = UtcTimestamp.milliseconds(from: expiresAt),
            let now = UtcTimestamp.milliseconds(from: observedAt)
        else {
            return .rejected(reason: "media_session_token_expiry_unreadable")
        }
        guard expiry > now else { return .rejected(reason: "media_session_token_expired") }

        if let reason = mediaClient.open(
            endpoint: endpoint, sessionToken: sessionToken, format: requested)
        {
            return .failed(reason: reason)
        }

        negotiatedFormat = requested
        jitterBufferCapacityFrames = max(
            1, jitterBufferMilliseconds / requested.frameMilliseconds)
        // Every counter, sequence and gap is per media session. Carrying any of
        // it across a reconnect would let the new session close a gap the old
        // one opened, which is a fabricated observation.
        captureSequence = 0
        capturedFramesSent = 0
        playbackFramesDroppedByOverflow = 0
        playbackFramesDroppedByCancellation = 0
        playbackCancelled = false
        openPlaybackGapStartedAt = nil
        mediaClient.setPlaybackSink { [weak self] frame in self?.receivePlayback(frame) }
        controlPlane.emit(.mediaConnected(endpoint: endpoint), observedAt: observedAt)
        return .connected(requested)
    }

    /// Ends the media session. An `audio_gap` that is still open stays open: its
    /// end was never observed, and inventing one here would be exactly the claim
    /// this package refuses to make. The bridge simply stops tracking it — the
    /// open event it already emitted is the whole of the record.
    public func disconnect(reason: String) {
        guard negotiatedFormat != nil else { return }
        negotiatedFormat = nil
        jitterBufferCapacityFrames = 0
        jitterBuffer.removeAll()
        lastCaptureMonotonic = nil
        lastCaptureObservedAt = nil
        openPlaybackGapStartedAt = nil
        mediaClient.close(reason: reason)
        controlPlane.emit(.mediaDisconnected(reason: reason), observedAt: clock.now())
    }

    // MARK: capture — the frame path out

    /// Called by the capture device once per frame. The frame goes straight to
    /// the media endpoint; the only other thing this method may do is report a
    /// discontinuity it observed.
    ///
    /// - Returns: the frame that was sent, or nil when nothing was sent —
    ///   no session, muted, or a clock fault.
    @discardableResult
    public func captureFrame(payload: [UInt8]) -> AudioFrame? {
        guard let format = negotiatedFormat, !isMuted else { return nil }

        let monotonic = clock.monotonicMilliseconds()
        if let last = lastCaptureMonotonic, monotonic < last {
            // The one source of frame timing went backwards. Stamping the frame
            // anyway would put a lie in the media timeline, so the session fails
            // instead, loudly.
            disconnect(reason: "media_clock_regressed")
            return nil
        }
        let observedAt = clock.now()

        // A gap is claimed between two frames that were both observed: the last
        // capture this bridge saw, and this one. `startedAt` is therefore the
        // instant of the last observed capture, not a computed end-of-audio.
        if let last = lastCaptureMonotonic, let lastObservedAt = lastCaptureObservedAt,
            monotonic - last > format.frameMilliseconds * 2
        {
            controlPlane.emit(
                .audioGap(direction: .capture, startedAt: lastObservedAt, endedAt: observedAt),
                observedAt: observedAt)
        }
        lastCaptureMonotonic = monotonic
        lastCaptureObservedAt = observedAt

        captureSequence += 1
        let frame = AudioFrame(
            direction: .capture, sequence: captureSequence, timestampMilliseconds: monotonic,
            payload: payload)
        mediaClient.send(frame)
        capturedFramesSent += 1
        return frame
    }

    /// Muting stops frames reaching the endpoint. It is not an `audio_gap`: the
    /// silence is explained, and the continuity baseline is dropped so the first
    /// frame after unmuting cannot be read as a stall either.
    public func setMuted(_ muted: Bool) {
        guard muted != isMuted else { return }
        isMuted = muted
        lastCaptureMonotonic = nil
        lastCaptureObservedAt = nil
    }

    // MARK: playback — the frame path in

    /// Every playback frame arrives here, straight from the endpoint's sink.
    private func receivePlayback(_ frame: AudioFrame) {
        guard negotiatedFormat != nil else { return }
        guard !playbackCancelled else {
            playbackFramesDroppedByCancellation += 1
            return
        }

        if jitterBuffer.count >= jitterBufferCapacityFrames {
            // Overflow policy: drop the oldest, keep the newest. In a live
            // conversation the stale frame is the worthless one, and holding it
            // would add latency to everything behind it. The drop is never
            // silent — it is counted, and it opens an audio_gap.
            jitterBuffer.removeFirst()
            playbackFramesDroppedByOverflow += 1
            if openPlaybackGapStartedAt == nil {
                let observedAt = clock.now()
                openPlaybackGapStartedAt = observedAt
                controlPlane.emit(
                    .audioGap(direction: .playback, startedAt: observedAt, endedAt: nil),
                    observedAt: observedAt)
            }
        } else if let startedAt = openPlaybackGapStartedAt {
            // The buffer took a frame without dropping one: now the gap's end
            // has been observed, and only now is it reported.
            let observedAt = clock.now()
            openPlaybackGapStartedAt = nil
            controlPlane.emit(
                .audioGap(direction: .playback, startedAt: startedAt, endedAt: observedAt),
                observedAt: observedAt)
        }
        jitterBuffer.append(frame)
    }

    /// The device's render callback: plays at most one buffered frame.
    /// - Returns: whether a frame was played.
    @discardableResult
    public func renderTick() -> Bool {
        guard negotiatedFormat != nil, !playbackCancelled, !jitterBuffer.isEmpty else {
            return false
        }
        device.play(jitterBuffer.removeFirst())
        return true
    }

    /// Barge-in. Drops everything queued at once — it does not wait for the
    /// buffer to drain — and keeps discarding what the endpoint sends until
    /// `resumePlayback()`, because the runtime goes on emitting the cancelled
    /// utterance for as long as the cancellation takes to reach it. Without that
    /// gate the buffer refills and the agent talks over the interruption.
    ///
    /// This is not an `audio_gap`: the silence was asked for.
    public func cancelPlayback() {
        playbackCancelled = true
        jitterBuffer.removeAll()
    }

    /// Reopens the playback path for the next utterance.
    public func resumePlayback() {
        playbackCancelled = false
    }
}

// MARK: - timestamps

/// Reads the Z-suffixed UTC timestamps the contract uses. Formatting is not here
/// on purpose: every instant this file reports is one the clock handed it, not
/// one it computed.
enum UtcTimestamp {
    static func milliseconds(from iso: String) -> Int? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) {
            return Int((date.timeIntervalSince1970 * 1000).rounded())
        }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: iso) else { return nil }
        return Int((date.timeIntervalSince1970 * 1000).rounded())
    }
}
