import XCTest
import AVFAudio
import CoreMedia
@testable import FeishuBridgeSpike

final class CapturedAudioTests: XCTestCase {
    func testInvalidTimesPreserveAudioWithoutInventingAHostSpan() throws {
        for pts in [CMTime.invalid, .indefinite, CMTime(value: -1, timescale: 1)] {
            let captured = try CapturedNativeAudio.copy(syntheticAudio(pts: pts), sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock())
            XCTAssertNil(captured.hostSpan)
            XCTAssertEqual(captured.samples.count, 480)
        }
        let inconsistent = try CapturedNativeAudio.copy(syntheticAudio(duration: CMTime(value: 1, timescale: 48_000)),
            sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock())
        XCTAssertNil(inconsistent.hostSpan)
        XCTAssertEqual(inconsistent.samples.count, 480)
    }
    func testSourceClockConversionUsesSamplePTSWithDirectedRoundingNotReceiptTime() throws {
        let sample = try syntheticAudio(pts: CMTime(value: 1, timescale: 3))
        let captured = try CapturedNativeAudio.copy(sample, sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock())
        XCTAssertEqual(captured.hostSpan?.startNs, 333_333_333)
        XCTAssertEqual(captured.hostSpan?.endNs, 353_333_334)
        XCTAssertEqual(captured.hostSpan?.roundingEnvelopeNs, 2)
        XCTAssertEqual(captured.sourcePTS, CMTime(value: 1, timescale: 3))
        XCTAssertNil(captured.captureUncertaintyNs)
        let zero = try CapturedNativeAudio.copy(syntheticAudio(), sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock())
        XCTAssertEqual(zero.hostSpan?.startNs, 0)
        let unknown = try CapturedNativeAudio.copy(sample, sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock(invalid: true))
        XCTAssertNil(unknown.hostSpan)
        XCTAssertEqual(unknown.samples.count, 480)
    }
    func testActualSampleLayoutDownmixAndBounds() throws {
        for rate in [24_000, 44_100, 48_000] {
            for planar in [false, true] {
                for integer in [false, true] {
                    let sample = try syntheticAudio(rate: rate, channels: 2, planar: planar, integer: integer,
                        values: [[0.5, -0.5], [-0.5, 0.5]], pts: .zero)
                    let captured = try CapturedNativeAudio.copy(sample, sourceClock: nil)
                    XCTAssertEqual(captured.samples, [0, 0])
                    XCTAssertEqual(captured.format.sampleRate, rate)
                    XCTAssertNil(captured.hostSpan)
                    XCTAssertNil(captured.captureUncertaintyNs)
                }
            }
        }
        XCTAssertThrowsError(try CapturedNativeAudio.copy(syntheticAudio(rate: 16_000), sourceClock: nil))
        XCTAssertThrowsError(try CapturedNativeAudio.copy(syntheticAudio(values: [[Float.nan]]), sourceClock: nil))
        XCTAssertThrowsError(try CapturedNativeAudio.copy(syntheticAudio(values: [Array(repeating: 0, count: 8193)]), sourceClock: nil))
    }
}

struct IdentityCaptureClock: CaptureClockMapping {
    var invalid = false
    func hostTime(_ sourceTime: CMTime, from sourceClock: CMClock) -> CMTime { invalid ? .invalid : sourceTime }
}

/// Memory-only CoreMedia fixture, never an engine, capture stream, or device.
func syntheticAudio(rate: Int = 24_000, channels: Int = 1, planar: Bool = false, integer: Bool = false,
                    values: [[Float]] = [Array(repeating: 0.25, count: 480)], pts: CMTime = .zero, duration: CMTime? = nil) throws -> CMSampleBuffer {
    let frames = values[0].count
    precondition(values.count == channels && values.allSatisfy { $0.count == frames })
    let bytesPerSample = integer ? 2 : 4
    var asbd = AudioStreamBasicDescription(mSampleRate: Double(rate), mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: (integer ? kAudioFormatFlagIsSignedInteger : kAudioFormatFlagIsFloat) | kAudioFormatFlagIsPacked | (planar ? kAudioFormatFlagIsNonInterleaved : 0),
        mBytesPerPacket: UInt32(bytesPerSample * (planar ? 1 : channels)), mFramesPerPacket: 1,
        mBytesPerFrame: UInt32(bytesPerSample * (planar ? 1 : channels)), mChannelsPerFrame: UInt32(channels),
        mBitsPerChannel: UInt32(bytesPerSample * 8), mReserved: 0)
    var description: CMAudioFormatDescription?
    XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
        magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description), noErr)
    var bytes = Data()
    func append(_ value: Float) {
        if integer {
            var encoded = Int16(max(-32768, min(32767, Int((value * 32768).rounded())))).littleEndian
            withUnsafeBytes(of: &encoded) { bytes.append(contentsOf: $0) }
        } else {
            var encoded = value.bitPattern.littleEndian
            withUnsafeBytes(of: &encoded) { bytes.append(contentsOf: $0) }
        }
    }
    if planar { for channel in values { for sample in channel { append(sample) } } }
    else { for frame in 0..<frames { for channel in values { append(channel[frame]) } } }
    var block: CMBlockBuffer?
    XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
        blockLength: bytes.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
        offsetToData: 0, dataLength: bytes.count, flags: 0, blockBufferOut: &block), noErr)
    let unwrapped = try XCTUnwrap(block)
    XCTAssertEqual(bytes.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: unwrapped, offsetIntoDestination: 0, dataLength: bytes.count) }, noErr)
    var timing = CMSampleTimingInfo(duration: duration ?? CMTime(value: 1, timescale: Int32(rate)), presentationTimeStamp: pts, decodeTimeStamp: .invalid)
    var sample: CMSampleBuffer?
    var sampleSize = bytesPerSample * channels
    let status = withUnsafePointer(to: &sampleSize) { size in
        CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: unwrapped, formatDescription: description,
            sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: planar ? 0 : 1, sampleSizeArray: planar ? nil : size, sampleBufferOut: &sample)
    }
    XCTAssertEqual(status, noErr)
    return try XCTUnwrap(sample)
}
