import Foundation

/// An in-process stand-in for the Rust Conversation Runtime media endpoint.
///
/// It exists to make the architectural claim testable rather than asserted: the
/// bridge dials this object directly, hands it capture frames, and takes
/// playback frames back from it. There is no relay, no serialisation hop and no
/// second process between the two, so a test that finds every captured frame
/// here, in order and unaltered, has watched the whole path a frame travels.
///
/// `echoCapturedFrames` turns it into a duplex loop: each captured frame comes
/// straight back as its playback counterpart, which is what lets a full-duplex
/// exchange be exercised without a runtime, a network, or an audio device.
/// Nothing here is a transport — it makes no connection and holds no socket.
public final class LoopbackMediaClient: MediaEndpointClient {
    public private(set) var openedEndpoint: String?
    public private(set) var openedSessionToken: String?
    public private(set) var openedFormat: AudioFormat?
    public private(set) var openCount = 0
    public private(set) var closeReasons: [String] = []
    /// Every capture frame the bridge sent, in the order it sent them.
    public private(set) var received: [AudioFrame] = []

    /// Set to make the next `open` refuse, the way an unreachable or
    /// token-rejecting endpoint would.
    public var openFailureReason: String?

    private let echoCapturedFrames: Bool
    private var sink: ((AudioFrame) -> Void)?
    private var playbackSequence = 0

    public init(echoCapturedFrames: Bool = true) {
        self.echoCapturedFrames = echoCapturedFrames
    }

    public func open(endpoint: String, sessionToken: String, format: AudioFormat) -> String? {
        if let openFailureReason { return openFailureReason }
        openCount += 1
        openedEndpoint = endpoint
        openedSessionToken = sessionToken
        openedFormat = format
        return nil
    }

    public func send(_ frame: AudioFrame) {
        received.append(frame)
        guard echoCapturedFrames else { return }
        deliverPlayback(
            payload: frame.payload, timestampMilliseconds: frame.timestampMilliseconds)
    }

    public func setPlaybackSink(_ sink: @escaping (AudioFrame) -> Void) {
        self.sink = sink
    }

    /// The sink is deliberately left wired. A real endpoint cannot unsend a
    /// frame that is already in flight, so the bridge has to refuse a late one
    /// on its own account rather than relying on the far end to stop first.
    public func close(reason: String) {
        closeReasons.append(reason)
    }

    /// Pushes one playback frame the way the runtime's data plane would.
    /// The endpoint owns playback sequence numbers and timestamps, not the
    /// bridge, so they are stamped here.
    public func deliverPlayback(payload: [UInt8], timestampMilliseconds: Int) {
        playbackSequence += 1
        sink?(
            AudioFrame(
                direction: .playback, sequence: playbackSequence,
                timestampMilliseconds: timestampMilliseconds, payload: payload))
    }
}
