import Foundation
import AVFAudio
import CoreMedia

public enum AudioPrimitiveError: Error, Equatable {
    case invalidRequest, unsupportedFormat, malformedSamples, boundsExceeded, conversionFailed, nativeFailure, ownershipUnconfirmed
}
public enum AudioStopOutcome: Equatable, Sendable { case stopped, failedUnconfirmed }
public enum AudioAdmission: Equatable, Sendable { case accepted, backpressured, closed }

public struct PCMSourceFormat: Equatable, Sendable {
    public let sampleRate: Int, channels: Int, bytesPerSample: Int
    public let isFloat: Bool, isPlanar: Bool
    init(_ value: AudioStreamBasicDescription) throws {
        guard [24_000.0, 44_100.0, 48_000.0].contains(value.mSampleRate),
              value.mFormatID == kAudioFormatLinearPCM, [1, 2].contains(value.mChannelsPerFrame),
              value.mFramesPerPacket == 1 else { throw AudioPrimitiveError.unsupportedFormat }
        isFloat = value.mFormatFlags & kAudioFormatFlagIsFloat != 0
        isPlanar = value.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
        bytesPerSample = isFloat ? 4 : 2
        channels = Int(value.mChannelsPerFrame); sampleRate = Int(value.mSampleRate)
        let expectedFlags = (isFloat ? kAudioFormatFlagIsFloat : kAudioFormatFlagIsSignedInteger)
            | kAudioFormatFlagIsPacked | (isPlanar ? kAudioFormatFlagIsNonInterleaved : 0)
        guard value.mFormatFlags == expectedFlags, value.mBitsPerChannel == bytesPerSample * 8,
              value.mBytesPerFrame == bytesPerSample * (isPlanar ? 1 : channels),
              value.mBytesPerPacket == value.mBytesPerFrame else { throw AudioPrimitiveError.unsupportedFormat }
    }
}

public struct HostAudioSpan: Equatable, Sendable {
    public let startNs: Int64, endNs: Int64
    /// Directed integer rounding only; NOT a bound on capture or clock error.
    public let roundingEnvelopeNs: UInt64
}
public protocol CaptureClockMapping: Sendable {
    func hostTime(_ sourceTime: CMTime, from sourceClock: CMClock) -> CMTime
}
public struct CoreMediaCaptureClock: CaptureClockMapping {
    public init() {}
    public func hostTime(_ sourceTime: CMTime, from sourceClock: CMClock) -> CMTime {
        CMSyncConvertTime(sourceTime, from: sourceClock, to: CMClockGetHostTimeClock())
    }
}

/// Bounded copy only: no retained sample/block buffer leaves the native callback.
public struct CapturedNativeAudio: Sendable {
    public let samples: [Float]
    public let format: PCMSourceFormat
    public let sourcePTS: CMTime, sourceDuration: CMTime
    public let hostSpan: HostAudioSpan?
    public let sourceClockIdentity: ObjectIdentifier?
    public let captureUncertaintyNs: UInt64? = nil

    static func inspect(_ sample: CMSampleBuffer) throws -> (PCMSourceFormat, Int) {
        guard CMSampleBufferIsValid(sample), CMSampleBufferDataIsReady(sample),
              let description = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description) else { throw AudioPrimitiveError.malformedSamples }
        let format = try PCMSourceFormat(asbd.pointee)
        let count = CMSampleBufferGetNumSamples(sample)
        guard count > 0, count <= 8192, count * format.channels * format.bytesPerSample <= 65_536 else { throw AudioPrimitiveError.boundsExceeded }
        guard let block = CMSampleBufferGetDataBuffer(sample),
              CMBlockBufferGetDataLength(block) == count * format.channels * format.bytesPerSample else { throw AudioPrimitiveError.malformedSamples }
        return (format, count)
    }

    public static func copy(_ sample: CMSampleBuffer, sourceClock: CMClock?,
                            clock: any CaptureClockMapping = CoreMediaCaptureClock()) throws -> Self {
        let (format, count) = try inspect(sample)
        let bufferCount = format.isPlanar ? format.channels : 1
        let list = AudioBufferList.allocate(maximumBuffers: bufferCount)
        defer { list.unsafeMutablePointer.deallocate() }
        var retained: CMBlockBuffer?
        var needed = 0
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &needed,
            bufferListOut: list.unsafeMutablePointer, bufferListSize: MemoryLayout<AudioBufferList>.size + (bufferCount - 1) * MemoryLayout<AudioBuffer>.size,
            blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &retained) == noErr,
            list.count == (format.isPlanar ? format.channels : 1) else { throw AudioPrimitiveError.malformedSamples }
        for buffer in list {
            guard buffer.mNumberChannels == (format.isPlanar ? 1 : format.channels), buffer.mData != nil,
                  buffer.mDataByteSize == count * format.bytesPerSample * (format.isPlanar ? 1 : format.channels) else { throw AudioPrimitiveError.malformedSamples }
        }
        var mono = [Float](repeating: 0, count: count)
        for frame in 0..<count {
            var mixed: Double = 0
            for channel in 0..<format.channels {
                let buffer = list[format.isPlanar ? channel : 0]
                let offset = (format.isPlanar ? frame : frame * format.channels + channel) * format.bytesPerSample
                let pointer = buffer.mData!.advanced(by: offset)
                let value: Float
                if format.isFloat { value = Float(bitPattern: UInt32(littleEndian: pointer.loadUnaligned(as: UInt32.self))) }
                else { value = Float(Int16(littleEndian: pointer.loadUnaligned(as: Int16.self))) / 32768 }
                guard value.isFinite else { throw AudioPrimitiveError.malformedSamples }
                mixed += Double(value) / Double(format.channels)
            }
            mono[frame] = Float(mixed)
        }
        withExtendedLifetime(retained) {}
        let pts = CMSampleBufferGetPresentationTimeStamp(sample), duration = CMSampleBufferGetDuration(sample)
        var host: HostAudioSpan?
        if pts.isNumeric, duration.isNumeric,
           CMTimeCompare(duration, CMTime(value: Int64(count), timescale: Int32(format.sampleRate))) == 0,
           let sourceClock {
            let start = clock.hostTime(pts, from: sourceClock)
            let end = clock.hostTime(CMTimeAdd(pts, duration), from: sourceClock)
            if start.isNumeric, end.isNumeric, CMTimeCompare(start, .zero) >= 0, CMTimeCompare(end, start) > 0 {
                let lower = CMTimeConvertScale(start, timescale: 1_000_000_000, method: .roundTowardNegativeInfinity)
                let upper = CMTimeConvertScale(end, timescale: 1_000_000_000, method: .roundTowardPositiveInfinity)
                if lower.isNumeric, upper.isNumeric, upper.value > lower.value {
                    host = HostAudioSpan(startNs: lower.value, endNs: upper.value, roundingEnvelopeNs: 2)
                }
            }
        }
        return Self(samples: mono, format: format, sourcePTS: pts, sourceDuration: duration,
                    hostSpan: host, sourceClockIdentity: sourceClock.map(ObjectIdentifier.init))
    }
}

public struct RationalSampleRange: Equatable, Sendable {
    /// Source-frame positions, denominator 24,000; never rounded per callback.
    public let lowerNumerator: Int64, upperNumerator: Int64
    public let denominator: Int64 = 24_000
}
public struct SourceSampleSpan: Sendable {
    public let bufferInputRange: Range<Int64>
    public let nominalRange: RationalSampleRange
    public let sourcePTS: CMTime, sourceDuration: CMTime
    public let convertedBufferHostSpan: HostAudioSpan?
}
/// Encloses source buffers needed by the converter's filter. NOT packet timing.
/// Deliberately a different, non-Codable type from a nominal packet host span.
public struct SourceSupportEnvelope: Equatable, Sendable {
    public let lowerHostNs: Int64, upperHostNs: Int64
}
public enum PacketMappingQuality: Equatable, Sendable {
    case piecewiseNominalSourceInterpolation, unknownClock, unknownPriming, filterEdge, incompleteSourceCoverage
}
public struct CapturedPcmPacket: Sendable {
    public let pcm: Data
    public let epoch: UInt64, sequence: UInt64
    public let outputRange: Range<Int64>
    public var sampleCount: Int { Int(outputRange.count) }
    public let sourceRange: RationalSampleRange
    public let sourceSpans: [SourceSampleSpan]
    public let primeLeadingInputFrames: UInt32?, primeTrailingInputFrames: UInt32?
    /// Nominal local estimate only. No certified physical or UTC accuracy.
    public let nominalHostSpan: HostAudioSpan?
    public let sourceSupportEnvelope: SourceSupportEnvelope?
    public let mappingQuality: PacketMappingQuality
    public let captureUncertaintyNs: UInt64? = nil
}
public enum CaptureLossReason: Equatable, Sendable { case inputOverflow, outputOverflow, sourceReset, suspended, invalidSample }
public struct CaptureLoss: Sendable {
    public let epoch: UInt64
    public let reason: CaptureLossReason
    public let sourcePTS: CMTime?, sourceDuration: CMTime?
    public let outputRange: Range<Int64>?
}
public enum CaptureDelivery: Sendable { case packet(CapturedPcmPacket), discontinuity(CaptureLoss), failed(AudioPrimitiveError) }
