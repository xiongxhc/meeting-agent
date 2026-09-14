import Foundation
@preconcurrency import AVFAudio
import CoreMedia

/// Serialized CPU-only streaming conversion; this class never creates an engine.
public final class PcmCaptureConverter {
    private struct Entry {
        let range: Range<Int64>
        let source: CapturedNativeAudio
    }
    private let emit: (CaptureDelivery) -> Void
    private let primeInfo: (AVAudioConverter) -> AVAudioConverterPrimeInfo
    private var converter: AVAudioConverter?
    private var format: PCMSourceFormat?
    private var ledger: [Entry] = []
    private var partial: [Int16] = []
    private var acceptedInput: Int64 = 0, outputFrames: Int64 = 0
    private var previous: CapturedNativeAudio?
    public private(set) var inputFramesSupplied: Int64 = 0
    public private(set) var epoch: UInt64 = 1
    private var sequence: UInt64 = 0
    private var finished = false

    public convenience init(emit: @escaping (CaptureDelivery) -> Void) { self.init(primeInfo: { $0.primeInfo }, emit: emit) }
    init(primeInfo: @escaping (AVAudioConverter) -> AVAudioConverterPrimeInfo, emit: @escaping (CaptureDelivery) -> Void) {
        self.primeInfo = primeInfo; self.emit = emit
    }

    public func append(_ source: CapturedNativeAudio) throws {
        guard !finished else { throw AudioPrimitiveError.invalidRequest }
        if let previous, !continuous(previous, source) { try discontinue(reason: .sourceReset) }
        if converter == nil { try configure(source.format) }
        guard source.format == format else { throw AudioPrimitiveError.unsupportedFormat }
        guard ledger.count < 64 else { throw AudioPrimitiveError.boundsExceeded }
        let end = acceptedInput.addingReportingOverflow(Int64(source.samples.count))
        guard !end.overflow, end.partialValue <= Int64.max / 24_000 else { throw AudioPrimitiveError.boundsExceeded }
        ledger.append(Entry(range: acceptedInput..<end.partialValue, source: source))
        acceptedInput = end.partialValue; previous = source
        try convert(samples: source.samples, ending: false)
    }

    public func finish() throws {
        try endEpoch()
        finished = true
    }

    public func discontinue(reason: CaptureLossReason, sourcePTS: CMTime? = nil, sourceDuration: CMTime? = nil,
                            reportBoundary: Bool = true) throws {
        guard !finished, epoch < UInt64.max else { throw AudioPrimitiveError.boundsExceeded }
        try endEpoch()
        if reportBoundary {
            emit(.discontinuity(CaptureLoss(epoch: epoch, reason: reason, sourcePTS: sourcePTS,
                sourceDuration: sourceDuration, outputRange: nil)))
        }
        epoch += 1
    }

    private func continuous(_ a: CapturedNativeAudio, _ b: CapturedNativeAudio) -> Bool {
        guard a.format == b.format, a.sourceClockIdentity == b.sourceClockIdentity,
              a.sourcePTS.isNumeric, a.sourceDuration.isNumeric, b.sourcePTS.isNumeric,
              CMTimeCompare(a.sourceDuration, CMTime(value: Int64(a.samples.count), timescale: Int32(a.format.sampleRate))) == 0,
              CMTimeCompare(CMTimeAdd(a.sourcePTS, a.sourceDuration), b.sourcePTS) == 0 else { return false }
        if let first = a.hostSpan, let second = b.hostSpan { return abs(second.startNs - first.endNs) <= 2 }
        return a.hostSpan == nil && b.hostSpan == nil
    }

    private func endEpoch() throws {
        guard converter != nil else { return }
        try convert(samples: [], ending: true)
        if !partial.isEmpty { try publish() }
        converter = nil; format = nil; ledger.removeAll(); previous = nil
    }

    private func configure(_ source: PCMSourceFormat) throws {
        guard let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(source.sampleRate), channels: 1, interleaved: false),
              let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false),
              let native = AVAudioConverter(from: input, to: output) else { throw AudioPrimitiveError.conversionFailed }
        native.primeMethod = .normal
        converter = native; format = source
        acceptedInput = 0; outputFrames = 0; partial.removeAll(); ledger.removeAll()
    }

    private func convert(samples: [Float], ending: Bool) throws {
        guard let converter else { throw AudioPrimitiveError.conversionFailed }
        let feed = ConverterFeed(samples: samples, format: converter.inputFormat)
        for _ in 0..<64 {
            guard let output = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 480) else { throw AudioPrimitiveError.conversionFailed }
            var error: NSError?
            let before = feed.position
            let status = converter.convert(to: output, error: &error) { requested, inputStatus in
                if let buffer = feed.take(Int(requested)) { inputStatus.pointee = .haveData; return buffer }
                inputStatus.pointee = ending ? .endOfStream : .noDataNow
                return nil
            }
            let supplied = inputFramesSupplied.addingReportingOverflow(Int64(feed.position - before))
            guard !supplied.overflow, error == nil, status != .error else { throw AudioPrimitiveError.conversionFailed }
            inputFramesSupplied = supplied.partialValue
            guard let values = output.floatChannelData?[0] else { throw AudioPrimitiveError.conversionFailed }
            for index in 0..<Int(output.frameLength) {
                let value = values[index]
                guard value.isFinite, outputFrames < Int64.max else { throw AudioPrimitiveError.conversionFailed }
                let scaled = max(-32768.0, min(32767.0, (Double(value) * 32768).rounded()))
                partial.append(Int16(scaled)); outputFrames += 1
                if partial.count == 480 { try publish() }
            }
            if status == .inputRanDry || status == .endOfStream {
                guard feed.position == samples.count else { throw AudioPrimitiveError.conversionFailed }
                return
            }
        }
        throw AudioPrimitiveError.boundsExceeded
    }

    private func publish() throws {
        guard let format, let converter, sequence < UInt64.max else { throw AudioPrimitiveError.boundsExceeded }
        let outputRange = (outputFrames - Int64(partial.count))..<outputFrames
        let lower = try multiply(outputRange.lowerBound, Int64(format.sampleRate))
        let upper = try multiply(outputRange.upperBound, Int64(format.sampleRate))
        guard upper <= Int64.max - 23_999 else { throw AudioPrimitiveError.boundsExceeded }
        let sourceRange = RationalSampleRange(lowerNumerator: lower, upperNumerator: upper)
        let prime = primeInfo(converter)
        // Same-rate converters have been observed returning nonsensical primeInfo.
        // Zero below bounds ledger retention ONLY, never represents known support.
        let knownPrime = prime.leadingFrames <= 8192 && prime.trailingFrames <= 8192
        let leading = knownPrime ? Int64(prime.leadingFrames) : 0
        let trailing = knownPrime ? Int64(prime.trailingFrames) : 0
        let supportLower = lower / 24_000 - leading
        let supportUpper = (upper + 23_999) / 24_000 + trailing
        let nominalEntries = ledger.filter { $0.range.upperBound * 24_000 > lower && $0.range.lowerBound * 24_000 < upper }
        let support = ledger.filter { $0.range.upperBound > supportLower && $0.range.lowerBound < supportUpper }
        guard nominalEntries.count <= 64, support.count <= 64 else { throw AudioPrimitiveError.boundsExceeded }
        let spans = nominalEntries.map {
            SourceSampleSpan(bufferInputRange: $0.range,
                nominalRange: RationalSampleRange(lowerNumerator: max(lower, $0.range.lowerBound * 24_000), upperNumerator: min(upper, $0.range.upperBound * 24_000)),
                sourcePTS: $0.source.sourcePTS, sourceDuration: $0.source.sourceDuration,
                convertedBufferHostSpan: $0.source.hostSpan)
        }
        var quality: PacketMappingQuality = .incompleteSourceCoverage
        var host: HostAudioSpan?, envelope: SourceSupportEnvelope?
        if !knownPrime { quality = .unknownPriming }
        else if supportLower < 0 || supportUpper > acceptedInput { quality = .filterEdge }
        else if let first = support.first, let last = support.last,
                first.range.lowerBound <= supportLower, last.range.upperBound >= supportUpper {
            quality = .unknownClock
            if support.allSatisfy({ $0.source.hostSpan != nil }),
               let a = nominalEntries.first, let b = nominalEntries.last,
               let start = try interpolate(a, numerator: lower, roundUp: false),
               let end = try interpolate(b, numerator: upper, roundUp: true), end > start,
               let firstHost = first.source.hostSpan, let lastHost = last.source.hostSpan {
                host = HostAudioSpan(startNs: start, endNs: end, roundingEnvelopeNs: 4)
                envelope = SourceSupportEnvelope(lowerHostNs: firstHost.startNs, upperHostNs: lastHost.endNs)
                quality = .piecewiseNominalSourceInterpolation
            }
        }
        var bytes = Data(capacity: partial.count * 2)
        for sample in partial { var value = sample.littleEndian; withUnsafeBytes(of: &value) { bytes.append(contentsOf: $0) } }
        sequence += 1
        emit(.packet(CapturedPcmPacket(pcm: bytes, epoch: epoch, sequence: sequence, outputRange: outputRange,
            sourceRange: sourceRange, sourceSpans: spans, primeLeadingInputFrames: knownPrime ? prime.leadingFrames : nil,
            primeTrailingInputFrames: knownPrime ? prime.trailingFrames : nil, nominalHostSpan: host, sourceSupportEnvelope: envelope, mappingQuality: quality)))
        partial.removeAll(keepingCapacity: true)
        let retainFrom = upper / 24_000 - leading
        ledger.removeAll { $0.range.upperBound <= retainFrom }
    }

    private func interpolate(_ entry: Entry, numerator: Int64, roundUp: Bool) throws -> Int64? {
        guard let host = entry.source.hostSpan else { return nil }
        let relative = numerator - (try multiply(entry.range.lowerBound, 24_000))
        let denominator = try multiply(Int64(entry.range.count), 24_000)
        guard relative >= 0, relative <= denominator else { return nil }
        let product = try multiply(host.endNs - host.startNs, relative)
        let delta = product / denominator + (roundUp && product % denominator != 0 ? 1 : 0)
        let sum = host.startNs.addingReportingOverflow(delta)
        return sum.overflow ? nil : sum.partialValue
    }

    private func multiply(_ lhs: Int64, _ rhs: Int64) throws -> Int64 {
        let result = lhs.multipliedReportingOverflow(by: rhs)
        guard !result.overflow else { throw AudioPrimitiveError.boundsExceeded }
        return result.partialValue
    }
}

/// AVAudioConverter invokes this synchronously; one callback range is supplied once.
private final class ConverterFeed: @unchecked Sendable {
    let samples: [Float], format: AVAudioFormat
    var position = 0
    init(samples: [Float], format: AVAudioFormat) { self.samples = samples; self.format = format }
    func take(_ requested: Int) -> AVAudioPCMBuffer? {
        let count = min(requested, samples.count - position)
        guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
              let destination = buffer.floatChannelData?[0] else { return nil }
        samples.withUnsafeBufferPointer { destination.update(from: $0.baseAddress!.advanced(by: position), count: count) }
        buffer.frameLength = AVAudioFrameCount(count); position += count
        return buffer
    }
}
