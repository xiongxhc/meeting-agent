import Foundation

/// The exact producer boundary a timed recorder must match before capture may
/// close. Derived byte-for-byte from the accepted gateway's
/// `decode_capture_finish_body`/`encode_capture_finish_body` and from
/// `CaptureFinishBoundary::new`, which is the only admission rule for the
/// frame-present spelling.
public struct CaptureFinishBoundary: Equatable, Sendable {
    public struct Frame: Equatable, Sendable {
        public let sequence: UInt64, outputEndSample: UInt64
        public init(sequence: UInt64, outputEndSample: UInt64) {
            self.sequence = sequence; self.outputEndSample = outputEndSample
        }
    }
    public let session: UInt64, captureEpoch: UInt64
    public let frame: Frame?
    public let finalClockPairSequence: UInt64
    public init(session: UInt64, captureEpoch: UInt64, frame: Frame?, finalClockPairSequence: UInt64) throws {
        guard session > 0, captureEpoch > 0, finalClockPairSequence > 0 else { throw BridgeProcessError.invalidInput }
        if let frame { guard frame.sequence > 0, frame.outputEndSample > 0 else { throw BridgeProcessError.invalidInput } }
        self.session = session; self.captureEpoch = captureEpoch
        self.frame = frame; self.finalClockPairSequence = finalClockPairSequence
    }
}

/// Wire authority: accepted Runtime gateway `apps/runtime-gateway/src/media_server.rs`
/// at the meeting-online-profile pin. Media v3 reuses every media-v2 body and
/// direction rule for kinds 1, 2, 6, 7, 8 and 9 under the `MED3\u{03}` envelope,
/// leaves media-v1 playback/flush records byte-for-byte alone, and adds only the
/// capture-finish pair: kind 10 bridge-to-Runtime, kind 11 Runtime-to-bridge,
/// each a 41-byte body inside a 51-byte packet.
public enum RuntimeMediaCodecV3 {
    static let prefix = Data([77, 69, 68, 51, 3])
    static let bodyBytes = 41
    static let finishKind: UInt8 = 10, acknowledgementKind: UInt8 = 11

    /// Retags one already-encoded media-v2 timed record with the v3 envelope.
    /// The body is not re-derived, which is what makes the inherited records
    /// provably identical rather than separately maintained.
    public static func envelope(_ media2: Data) throws -> Data {
        guard media2.count >= 10, media2.prefix(5) == Data([77, 69, 68, 50, 2]),
              [1, 2, 6, 7, 8, 9].contains(media2[5]) else { throw BridgeProcessError.invalidInput }
        return prefix + media2.dropFirst(5)
    }

    public static func captureFinish(_ boundary: CaptureFinishBoundary) -> Data {
        prefix + Data([finishKind]) + RuntimeMediaCodecV2.be(UInt32(bodyBytes)) + body(boundary)
    }

    static func body(_ boundary: CaptureFinishBoundary) -> Data {
        RuntimeMediaCodecV2.be(boundary.session) + RuntimeMediaCodecV2.be(boundary.captureEpoch)
            + Data([boundary.frame == nil ? 0 : 1])
            + RuntimeMediaCodecV2.be(boundary.frame?.sequence ?? 0)
            + RuntimeMediaCodecV2.be(boundary.frame?.outputEndSample ?? 0)
            + RuntimeMediaCodecV2.be(boundary.finalClockPairSequence)
    }

    public static func decodeCaptureFinishBody(_ body: Data) throws -> CaptureFinishBoundary {
        guard body.count == bodyBytes else { throw BridgeProcessError.invalidInput }
        let bytes = Data(body)
        func uint(_ offset: Int) -> UInt64 { RuntimeMediaCodecV2.uint(bytes, offset, UInt64.self) }
        let present = bytes[16], sequence = uint(17), outputEnd = uint(25)
        let frame: CaptureFinishBoundary.Frame?
        switch (present, sequence, outputEnd) {
        case (1, let sequence, let outputEnd) where sequence > 0 && outputEnd > 0:
            frame = CaptureFinishBoundary.Frame(sequence: sequence, outputEndSample: outputEnd)
        case (0, 0, 0): frame = nil
        default: throw BridgeProcessError.invalidInput
        }
        return try CaptureFinishBoundary(session: uint(0), captureEpoch: uint(8), frame: frame,
            finalClockPairSequence: uint(33))
    }
}
