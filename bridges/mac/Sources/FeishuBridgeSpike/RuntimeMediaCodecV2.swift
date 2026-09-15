import Foundation

/// Wire authority: accepted Runtime 4c97c47 docs/media-protocol-v2.md and mirrored vectors.
public enum RuntimeMediaCodecV2 {
    static func wrap(_ kind: UInt8, _ body: Data) -> Data {
        Data([77, 69, 68, 50, 2, kind]) + be(UInt32(body.count)) + body
    }
    public static func capture(session: UInt64, timing: Data, pcm: Data) throws -> Data {
        try validateTiming(timing, pcmBytes: pcm.count)
        guard session > 0 else { throw BridgeProcessError.invalidInput }
        return wrap(2, be(session) + Data([1]) + be(UInt32(24_000)) + be(UInt16(1)) + timing + be(UInt32(pcm.count)) + pcm)
    }
    public static func authentication(session: UInt64, bridge: String, token: String) throws -> Data {
        guard session > 0, !token.isEmpty, token.utf8.count <= 128 else { throw BridgeProcessError.invalidInput }
        return wrap(1, be(session) + Data([UInt8(token.utf8.count)]) + Data(token.utf8) + (try identifier(bridge)))
    }
    public static func epoch(session: UInt64, bridge: String, domain: String, epoch: UInt64) throws -> Data {
        guard session > 0, epoch > 0 else { throw BridgeProcessError.invalidInput }
        return wrap(6, be(session) + (try identifier(bridge)) + (try identifier(domain)) + be(epoch) + Data([1]))
    }
    public static func discontinuity(session: UInt64, epoch: UInt64, reason: UInt8) throws -> Data {
        guard session > 0, epoch > 0, (1...8).contains(reason) else { throw BridgeProcessError.invalidInput }
        return wrap(8, be(session) + be(epoch) + Data([reason]))
    }
    static func identifier(_ value: String) throws -> Data {
        guard TimedMediaLease.identifier(value) else { throw BridgeProcessError.invalidInput }
        return Data([UInt8(value.utf8.count)]) + Data(value.utf8)
    }
    public static func clockPair(session: UInt64, pair: CaptureClockPair) throws -> Data {
        guard session > 0, pair.epoch > 0, pair.sequence > 0, pair.hostBeforeNs > 0, pair.hostAfterNs >= pair.hostBeforeNs,
              pair.wallResolutionNs > 0 else { throw BridgeProcessError.invalidInput }
        return wrap(7, be(session) + (try identifier(pair.clockDomainId)) + be(pair.epoch) + be(pair.sequence)
            + be(pair.hostBeforeNs) + be(UInt64(bitPattern: pair.localUnixNs)) + be(pair.hostAfterNs)
            + be(pair.wallResolutionNs) + Data([0]) + be(UInt64(0)))
    }
    public static func acknowledgement(session: UInt64, sequence: UInt64, rendered: Bool) -> Data {
        Data([77, 69, 68, 49, 1, 3]) + be(session) + be(sequence) + Data([rendered ? 2 : 1])
    }
    public static func flushAcknowledgement(session: UInt64, generation: UInt64) -> Data {
        Data([77, 69, 68, 49, 1, 5]) + be(session) + be(generation)
    }
    static func be<T: FixedWidthInteger>(_ value: T) -> Data {
        var number = value.bigEndian
        return withUnsafeBytes(of: &number) { Data($0) }
    }
    static func uint<T: FixedWidthInteger>(_ data: Data, _ offset: Int, _: T.Type) -> T {
        data.withUnsafeBytes { T(bigEndian: $0.loadUnaligned(fromByteOffset: offset, as: T.self)) }
    }
    static func validateTiming(_ data: Data, pcmBytes: Int) throws {
        guard data.count == 88, data[0] == 1, data[1] <= 3, data[3] == 0,
              (1...5).contains(data[2]), data[1] & 2 == 0 || data[1] & 1 == 1,
              (data[2] == 1) == (data[1] & 1 == 1),
              uint(data, 4, UInt64.self) > 0, uint(data, 12, UInt64.self) > 0,
              pcmBytes > 0, pcmBytes <= 65_536,
              UInt64(uint(data, 28, UInt32.self)) * 2 == UInt64(pcmBytes),
              uint(data, 48, UInt32.self) == 24_000 else { throw BridgeProcessError.invalidInput }
        let start = uint(data, 20, UInt64.self), count = UInt64(uint(data, 28, UInt32.self)), rate = UInt64(uint(data, 52, UInt32.self))
        let end = start.addingReportingOverflow(count), lower = start.multipliedReportingOverflow(by: rate)
        let upper = end.partialValue.multipliedReportingOverflow(by: rate)
        guard rate > 0, !end.overflow, !lower.overflow, !upper.overflow,
              lower.partialValue == uint(data, 32, UInt64.self), upper.partialValue == uint(data, 40, UInt64.self) else { throw BridgeProcessError.invalidInput }
        if data[1] & 1 == 1 {
            guard uint(data, 64, UInt64.self) > uint(data, 56, UInt64.self) else { throw BridgeProcessError.invalidInput }
        } else {
            guard data[56..<88].allSatisfy({ $0 == 0 }) else { throw BridgeProcessError.invalidInput }
        }
        if data[1] & 2 == 0, uint(data, 80, UInt64.self) != 0 { throw BridgeProcessError.invalidInput }
    }

    /// Endpoint-only wire evidence is admitted only after checking every retained
    /// nominal source piece. Filter-support envelopes never enter this encoder.
    public static func timing(_ packet: CapturedPcmPacket) throws -> Data {
        guard packet.outputRange.lowerBound >= 0, packet.sampleCount > 0, packet.sampleCount <= 480,
              packet.sourceRange.lowerNumerator >= 0, packet.sourceRange.upperNumerator > packet.sourceRange.lowerNumerator,
              packet.sourceRange.denominator == 24_000 else { throw BridgeProcessError.invalidInput }
        let width = packet.sourceRange.upperNumerator - packet.sourceRange.lowerNumerator
        guard width % Int64(packet.sampleCount) == 0, let rate = UInt32(exactly: width / Int64(packet.sampleCount)) else { throw BridgeProcessError.invalidInput }
        var quality: UInt8
        switch packet.mappingQuality {
        case .piecewiseNominalSourceInterpolation: quality = 1
        case .unknownClock: quality = 2
        case .unknownPriming: quality = 3
        case .filterEdge: quality = 4
        case .incompleteSourceCoverage: quality = 5
        }
        var host = packet.nominalHostSpan
        if quality == 1 && !completeNominalCoverage(packet) { quality = 5; host = nil }
        if quality == 1 && host == nil { quality = 2 }
        if quality != 1 { host = nil }
        var bytes = Data([1, host == nil ? 0 : 1, quality, 0])
        bytes += be(packet.epoch) + be(packet.sequence) + be(UInt64(packet.outputRange.lowerBound)) + be(UInt32(packet.sampleCount))
        bytes += be(UInt64(packet.sourceRange.lowerNumerator)) + be(UInt64(packet.sourceRange.upperNumerator)) + be(UInt32(24_000)) + be(rate)
        if let host, host.startNs >= 0, host.endNs > host.startNs {
            bytes += be(UInt64(host.startNs)) + be(UInt64(host.endNs)) + be(host.roundingEnvelopeNs) + be(UInt64(0))
        } else {
            guard host == nil else { throw BridgeProcessError.invalidInput }
            bytes += Data(count: 32)
        }
        try validateTiming(bytes, pcmBytes: packet.pcm.count)
        return bytes
    }
    private static func completeNominalCoverage(_ packet: CapturedPcmPacket) -> Bool {
        guard !packet.sourceSpans.isEmpty, packet.sourceSpans.count <= 64,
              packet.primeLeadingInputFrames != nil, packet.primeTrailingInputFrames != nil else { return false }
        var next = packet.sourceRange.lowerNumerator
        var previous: SourceSampleSpan?
        for piece in packet.sourceSpans {
            guard piece.nominalRange.lowerNumerator == next, piece.nominalRange.upperNumerator > next,
                  piece.sourcePTS.isNumeric, piece.sourceDuration.isNumeric,
                  let host = piece.convertedBufferHostSpan, host.startNs >= 0, host.endNs > host.startNs else { return false }
            if let previous {
                guard previous.bufferInputRange.upperBound == piece.bufferInputRange.lowerBound,
                      CMTimeCompare(CMTimeAdd(previous.sourcePTS, previous.sourceDuration), piece.sourcePTS) == 0,
                      let priorHost = previous.convertedBufferHostSpan,
                      abs(host.startNs - priorHost.endNs) <= 1 else { return false }
            }
            next = piece.nominalRange.upperNumerator; previous = piece
        }
        return next == packet.sourceRange.upperNumerator
    }
}

import CoreMedia

public struct RuntimePlaybackFrame: Equatable, Sendable {
    public let session: UInt64, networkSequence: UInt64, turn: UInt64, generation: UInt64, utterance: UInt64, sequence: UInt64
    public let pcm: Data
}
public enum RuntimeMediaInbound: Equatable, Sendable {
    case authenticated(session: UInt64, bridge: String)
    case playback(RuntimePlaybackFrame)
    case flush(session: UInt64, generation: UInt64)
}

/// One bounded incomplete packet; the caller feeds at most 4 KiB per read and
/// handles the returned packets before requesting more bytes.
public struct RuntimeMediaDecoder {
    private var pending = Data()
    public var hasIncompletePacket: Bool { !pending.isEmpty }
    public var awaitingPlaybackBody: Bool { pending.count >= 6 && pending.prefix(6) == Data([77, 69, 68, 49, 1, 2]) }
    /// Stop exactly at packet boundaries. A following flush header may be read
    /// while one playback packet waits for native credit, without buffering a
    /// second playback body or hiding a coalesced control packet behind it.
    public var nextReadMaximum: Int {
        if pending.count < 6 { return 6 - pending.count }
        if pending[3] == 50 {
            if pending.count < 10 { return 10 - pending.count }
            return max(1, min(4096, 10 + Int(RuntimeMediaCodecV2.uint(pending, 6, UInt32.self)) - pending.count))
        }
        let header = pending[5] == 2 ? 66 : 22
        if pending.count < header { return header - pending.count }
        return max(1, min(4096, header + Int(RuntimeMediaCodecV2.uint(pending, 62, UInt32.self)) - pending.count))
    }
    public init() {}
    public mutating func append(_ data: Data) throws -> [RuntimeMediaInbound] {
        guard data.count <= 4096, pending.count + data.count <= 65_536 + 66 + 4096 else { throw BridgeProcessError.inputTooLarge }
        pending += data
        var output: [RuntimeMediaInbound] = []
        while pending.count >= 6 {
            if pending.prefix(5) == Data([77, 69, 68, 50, 2]) {
                guard pending[5] == 9 else { throw BridgeProcessError.invalidInput }
                if pending.count < 10 { break }
                let length = Int(RuntimeMediaCodecV2.uint(pending, 6, UInt32.self))
                guard (10...73).contains(length) else { throw BridgeProcessError.invalidInput }
                if pending.count < 10 + length { break }
                let session = RuntimeMediaCodecV2.uint(pending, 10, UInt64.self)
                guard session > 0, Int(pending[18]) + 9 == length,
                      let bridge = String(data: pending[19..<10 + length], encoding: .utf8), TimedMediaLease.identifier(bridge) else { throw BridgeProcessError.invalidInput }
                output.append(.authenticated(session: session, bridge: bridge))
                pending = Data(pending.dropFirst(10 + length)); continue
            }
            guard pending.prefix(5) == Data([77, 69, 68, 49, 1]) else { throw BridgeProcessError.invalidInput }
            let kind = pending[5]
            guard kind == 2 || kind == 4 else { throw BridgeProcessError.invalidInput }
            let header = kind == 2 ? 66 : 22
            if pending.count < header { break }
            let size = kind == 2 ? Int(RuntimeMediaCodecV2.uint(pending, 62, UInt32.self)) : 0
            guard kind != 2 || (size > 0 && size <= 65_536 && size.isMultiple(of: 2) && pending[6] == 2 && pending[55] == 1
                && RuntimeMediaCodecV2.uint(pending, 56, UInt32.self) == 24_000 && RuntimeMediaCodecV2.uint(pending, 60, UInt16.self) == 1) else { throw BridgeProcessError.invalidInput }
            if pending.count < header + size { break }
            func u(_ at: Int) -> UInt64 { RuntimeMediaCodecV2.uint(pending, at, UInt64.self) }
            if kind == 4 { output.append(.flush(session: u(6), generation: u(14))) }
            else { output.append(.playback(RuntimePlaybackFrame(session: u(7), networkSequence: u(15), turn: u(23), generation: u(31), utterance: u(39), sequence: u(47), pcm: Data(pending[66..<66 + size])))) }
            pending = Data(pending.dropFirst(header + size))
        }
        return output
    }
    public func finish() throws { if !pending.isEmpty { throw BridgeProcessError.invalidInput } }
}
