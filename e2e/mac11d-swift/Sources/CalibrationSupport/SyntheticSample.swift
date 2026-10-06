import Foundation
import CoreMedia
import AudioToolbox
import FeishuBridgeSpike

public func syntheticSample(frames: Int, pts: CMTime) throws -> CMSampleBuffer {
    guard (1...480).contains(frames), pts.isNumeric, CMTimeCompare(pts, .zero) >= 0 else {
        throw AudioPrimitiveError.malformedSamples
    }
    var format = AudioStreamBasicDescription(mSampleRate: 24_000, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4,
        mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32, mReserved: 0)
    var description: CMAudioFormatDescription?
    guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &format,
        layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil,
        formatDescriptionOut: &description) == noErr, let description else { throw AudioPrimitiveError.malformedSamples }
    var bytes = Data()
    for _ in 0..<frames {
        var value = Float(0.25).bitPattern.littleEndian
        withUnsafeBytes(of: &value) { bytes.append(contentsOf: $0) }
    }
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
        blockLength: bytes.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
        offsetToData: 0, dataLength: bytes.count, flags: 0, blockBufferOut: &block) == noErr,
        let block else { throw AudioPrimitiveError.malformedSamples }
    guard bytes.withUnsafeBytes({ CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block,
        offsetIntoDestination: 0, dataLength: bytes.count) }) == noErr else { throw AudioPrimitiveError.malformedSamples }
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 24_000),
        presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var sampleSize = 4, sample: CMSampleBuffer?
    let status = withUnsafePointer(to: &sampleSize) { size in
        CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: description,
            sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: size, sampleBufferOut: &sample)
    }
    guard status == noErr, let sample else { throw AudioPrimitiveError.malformedSamples }
    return sample
}
