import XCTest
import CoreMedia
import AVFAudio
@testable import FeishuBridgeSpike

final class PcmCaptureConverterTests: XCTestCase {
    func testMinuteOf44100InputHasNoPerBufferRoundingDrift() throws {
        var output = 0, last: CapturedPcmPacket?
        let converter = PcmCaptureConverter { if case .packet(let p) = $0 { output += p.sampleCount; last = p } }
        let total = 44_100 * 60
        for offset in stride(from: 0, to: total, by: 997) {
            let count = min(997, total - offset)
            let sample = try syntheticAudio(rate: 44_100, values: [Array(repeating: 0.1, count: count)], pts: CMTime(value: Int64(offset), timescale: 44_100))
            try converter.append(CapturedNativeAudio.copy(sample, sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock()))
        }
        try converter.finish()
        XCTAssertEqual(converter.inputFramesSupplied, Int64(total))
        XCTAssertEqual(output, 24_000 * 60)
        XCTAssertEqual(last?.sourceRange.upperNumerator, Int64(total) * 24_000)
    }
    func testSourceMapLimitFailsInsteadOfCreatingAnUnboundedLedger() throws {
        let converter = PcmCaptureConverter { _ in }
        for offset in 0..<64 {
            try converter.append(CapturedNativeAudio.copy(syntheticAudio(rate: 48_000, values: [[0.1]], pts: CMTime(value: Int64(offset), timescale: 48_000)), sourceClock: nil))
        }
        XCTAssertThrowsError(try converter.append(CapturedNativeAudio.copy(syntheticAudio(rate: 48_000, values: [[0.1]], pts: CMTime(value: 64, timescale: 48_000)), sourceClock: nil))) {
            XCTAssertEqual($0 as? AudioPrimitiveError, .boundsExceeded)
        }
        try converter.finish()
    }
    func testNormalPrimingInteriorImpulseRetainsNominalSourcePosition() throws {
        for rate in [24_000, 44_100, 48_000] {
            var input = [Float](repeating: 0, count: rate * 2); input[rate] = 0.75
            let packets = try convertCPU(input, rate: rate, partition: 997)
            let samples = packets.flatMap { packet in
                packet.pcm.withUnsafeBytes { bytes in
                    (0..<packet.sampleCount).map { Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: $0 * 2, as: Int16.self)) }
                }
            }
            let peak = samples.indices.max { abs(Int(samples[$0])) < abs(Int(samples[$1])) }
            XCTAssertEqual(peak, 24_000, "normal-prime nominal correspondence at \(rate)")
        }
    }
    func testActualCPUImpulseRampAndLongRatioArePartitionInvariant() throws {
        for rate in [24_000, 44_100, 48_000] {
            let count = rate * 3
            let samples = (0..<count).map { index -> Float in
                if index == rate { return 0.75 }
                return Float(index % 1000) / 4000 - 0.125
            }
            let a = try convertCPU(samples, rate: rate, partition: 997)
            let b = try convertCPU(samples, rate: rate, partition: 4093)
            XCTAssertEqual(a.map(\.pcm), b.map(\.pcm), "persistent stream must not depend on callback partition at \(rate)")
            XCTAssertEqual(a.reduce(0) { $0 + $1.sampleCount }, 72_000)
            XCTAssertEqual(a.last?.sourceRange.upperNumerator, Int64(72_000 * rate))
            XCTAssertTrue(a.allSatisfy { $0.sourceSpans.count <= 64 && $0.captureUncertaintyNs == nil })
            for packet in a where packet.nominalHostSpan != nil {
                let span = try XCTUnwrap(packet.nominalHostSpan)
                XCTAssertLessThanOrEqual(abs((span.endNs - span.startNs) - 20_000_000), 4)
                XCTAssertEqual(packet.mappingQuality, .piecewiseNominalSourceInterpolation)
                XCTAssertLessThanOrEqual(packet.sourceSupportEnvelope!.lowerHostNs, span.startNs)
                XCTAssertGreaterThanOrEqual(packet.sourceSupportEnvelope!.upperHostNs, span.endNs)
            }
        }
    }
    func testSaturationStereoAndExplicitSuspendNeverPadOrBridge() throws {
        var packets: [CapturedPcmPacket] = [], losses: [CaptureLoss] = []
        let converter = PcmCaptureConverter { event in
            if case .packet(let p) = event { packets.append(p) }
            if case .discontinuity(let l) = event { losses.append(l) }
        }
        let samples = try syntheticAudio(channels: 2, planar: true, values: [[2, -2, 0.5], [2, -2, -0.5]])
        try converter.append(CapturedNativeAudio.copy(samples, sourceClock: nil))
        try converter.discontinue(reason: .suspended)
        try converter.append(CapturedNativeAudio.copy(syntheticAudio(values: [[0.25]]), sourceClock: nil))
        try converter.finish()
        XCTAssertEqual(packets.map(\.sampleCount), [3, 1])
        XCTAssertEqual(packets[0].pcm, Data([255, 127, 0, 128, 0, 0]))
        XCTAssertEqual(packets.map(\.epoch), [1, 2])
        XCTAssertEqual(losses.map(\.reason), [.suspended])
        XCTAssertTrue(packets.allSatisfy { $0.nominalHostSpan == nil })
    }
    func testFormatClockAndRegressingPTSResetInsteadOfBorrowingOldMapping() throws {
        var epochs: [UInt64] = []
        let converter = PcmCaptureConverter { if case .packet(let p) = $0 { epochs.append(p.epoch) } }
        for (rate, pts, clock) in [(24_000, CMTime.zero, CMClockGetHostTimeClock()),
                                   (24_000, CMTime(value: 480, timescale: 24_000), nil),
                                   (48_000, CMTime(value: 960, timescale: 24_000), nil),
                                   (48_000, CMTime.zero, nil)] {
            try converter.append(CapturedNativeAudio.copy(syntheticAudio(rate: rate, pts: pts), sourceClock: clock, clock: IdentityCaptureClock()))
        }
        try converter.finish()
        XCTAssertEqual(epochs, [1, 2, 3, 4])
    }
    private func convertCPU(_ samples: [Float], rate: Int, partition: Int) throws -> [CapturedPcmPacket] {
        var packets: [CapturedPcmPacket] = []
        let converter = PcmCaptureConverter { if case .packet(let p) = $0 { packets.append(p) } }
        for offset in stride(from: 0, to: samples.count, by: partition) {
            let end = min(offset + partition, samples.count)
            let buffer = try syntheticAudio(rate: rate, values: [Array(samples[offset..<end])], pts: CMTime(value: Int64(offset), timescale: Int32(rate)))
            try converter.append(CapturedNativeAudio.copy(buffer, sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock()))
        }
        try converter.finish()
        XCTAssertEqual(converter.inputFramesSupplied, Int64(samples.count))
        return packets
    }
    func testInvalidNativePrimeInfoNeverBecomesZeroOrPacketTiming() throws {
        var packets: [CapturedPcmPacket] = []
        let converter = PcmCaptureConverter(primeInfo: { _ in AVAudioConverterPrimeInfo(leadingFrames: 1_073_739_776, trailingFrames: 4_294_963_200) }) {
            if case .packet(let packet) = $0 { packets.append(packet) }
        }
        try converter.append(CapturedNativeAudio.copy(syntheticAudio(), sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock()))
        try converter.finish()
        XCTAssertEqual(packets.first?.sampleCount, 480)
        XCTAssertNil(packets.first?.primeLeadingInputFrames)
        XCTAssertNil(packets.first?.primeTrailingInputFrames)
        XCTAssertNil(packets.first?.nominalHostSpan)
        XCTAssertEqual(packets.first?.mappingQuality, .unknownPriming)
    }
    func testSourceDiscontinuityClosesEpochInsteadOfSpanningTheHole() throws {
        var deliveries: [CaptureDelivery] = []
        let converter = PcmCaptureConverter { deliveries.append($0) }
        try converter.append(CapturedNativeAudio.copy(syntheticAudio(), sourceClock: nil))
        try converter.append(CapturedNativeAudio.copy(syntheticAudio(pts: CMTime(value: 1, timescale: 1)), sourceClock: nil))
        try converter.finish()
        let packets = deliveries.compactMap { if case .packet(let packet) = $0 { packet } else { nil } }
        XCTAssertEqual(packets.map(\.epoch), [1, 2])
        XCTAssertEqual(packets.map { $0.outputRange.lowerBound }, [0, 0])
        XCTAssertEqual(deliveries.filter { if case .discontinuity = $0 { true } else { false } }.count, 1)
    }
    func testCPUConverterPreservesCumulativeCountsAndRealTailAcrossPartitions() throws {
        for rate in [24_000, 44_100, 48_000] {
            var packets: [CapturedPcmPacket] = []
            let converter = PcmCaptureConverter { if case .packet(let packet) = $0 { packets.append(packet) } }
            var offset = 0
            while offset < rate {
                let count = min(997, rate - offset)
                let sample = try syntheticAudio(rate: rate, values: [Array(repeating: 0.25, count: count)], pts: CMTime(value: Int64(offset), timescale: Int32(rate)))
                try converter.append(CapturedNativeAudio.copy(sample, sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock()))
                offset += count
            }
            try converter.finish()
            XCTAssertEqual(converter.inputFramesSupplied, Int64(rate))
            XCTAssertEqual(packets.reduce(0) { $0 + $1.sampleCount }, 24_000)
            XCTAssertEqual(packets.first?.outputRange.lowerBound, 0)
            XCTAssertEqual(packets.last?.outputRange.upperBound, 24_000)
            XCTAssertTrue(packets.allSatisfy { $0.sampleCount <= 480 && $0.pcm.count == $0.sampleCount * 2 && $0.captureUncertaintyNs == nil })
            if rate != 24_000 { XCTAssertTrue(packets.dropFirst(2).dropLast(2).contains { $0.nominalHostSpan != nil }, "rate \(rate)") }
            XCTAssertTrue(packets.filter { $0.primeLeadingInputFrames == nil }.allSatisfy { $0.nominalHostSpan == nil && $0.mappingQuality == .unknownPriming })
        }
        var packets: [CapturedPcmPacket] = []
        let tail = PcmCaptureConverter { if case .packet(let packet) = $0 { packets.append(packet) } }
        try tail.append(CapturedNativeAudio.copy(syntheticAudio(values: [Array(repeating: 0.5, count: 503)]), sourceClock: nil))
        try tail.finish()
        XCTAssertEqual(packets.map(\.sampleCount), [480, 23])
        XCTAssertEqual(packets.last?.pcm, Data(Array(repeating: [UInt8(0), 64], count: 23).flatMap { $0 }))
    }
}
