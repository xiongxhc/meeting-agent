import XCTest
import CoreMedia
@testable import FeishuBridgeSpike

func fixtureHex(_ text: String) -> Data {
    let bytes = Array(text.utf8)
    return Data(stride(from: 0, to: bytes.count, by: 2).map { UInt8(String(decoding: bytes[$0..<$0 + 2], as: UTF8.self), radix: 16)! })
}

final class RuntimeMediaCodecV2Tests: XCTestCase {
    func testClockPairSignedWallExtremesAndAbsentPhysicalAccuracyNeverAdmitZeroHost() throws {
        for wall in [Int64.min, Int64.max] {
            let pair = CaptureClockPair(clockDomainId: "d", epoch: UInt64.max, sequence: UInt64.max,
                hostBeforeNs: UInt64.max - 1, hostAfterNs: UInt64.max, localUnixNs: wall, wallResolutionNs: UInt64.max)
            let bytes = try RuntimeMediaCodecV2.clockPair(session: 41, pair: pair)
            XCTAssertEqual(RuntimeMediaCodecV2.uint(bytes, 44, UInt64.self), UInt64(bitPattern: wall))
            XCTAssertEqual(Data(bytes.suffix(9)), Data(count: 9))
        }
        let zero = CaptureClockPair(clockDomainId: "d", epoch: 1, sequence: 1,
            hostBeforeNs: 0, hostAfterNs: 1, localUnixNs: 0, wallResolutionNs: 1)
        XCTAssertThrowsError(try RuntimeMediaCodecV2.clockPair(session: 41, pair: zero))
    }
    func testCPUConverterRetainsRationalTailAndDelayNeverReplacesSourceTiming() throws {
        var packets: [CapturedPcmPacket] = []
        let converter = PcmCaptureConverter { if case .packet(let packet) = $0 { packets.append(packet) } }
        for offset in stride(from: 0, to: 9606, by: 997) {
            let count = min(997, 9606 - offset)
            let source = try syntheticAudio(rate: 48_000, values: [Array(repeating: 0.1, count: count)], pts: CMTime(value: Int64(offset), timescale: 48_000))
            try converter.append(CapturedNativeAudio.copy(source, sourceClock: CMClockGetHostTimeClock(), clock: IdentityCaptureClock()))
        }
        try converter.finish()
        XCTAssertEqual(packets.reduce(0) { $0 + $1.sampleCount }, 4803)
        XCTAssertEqual(packets.last?.sampleCount, 3)
        for packet in packets {
            let bytes = try RuntimeMediaCodecV2.timing(packet)
            XCTAssertEqual(RuntimeMediaCodecV2.uint(bytes, 20, UInt64.self), UInt64(packet.outputRange.lowerBound))
            XCTAssertEqual(RuntimeMediaCodecV2.uint(bytes, 40, UInt64.self), UInt64(packet.outputRange.upperBound) * 48_000)
            XCTAssertEqual(RuntimeMediaCodecV2.uint(bytes, 80, UInt64.self), 0)
            _ = try RuntimeMediaCodecV2.capture(session: 41, timing: bytes, pcm: packet.pcm)
            if let span = packet.nominalHostSpan {
                XCTAssertEqual(bytes[1], 1)
                XCTAssertEqual(RuntimeMediaCodecV2.uint(bytes, 56, UInt64.self), UInt64(span.startNs))
                XCTAssertEqual(RuntimeMediaCodecV2.uint(bytes, 64, UInt64.self), UInt64(span.endNs))
            }
        }
        let packet = try XCTUnwrap(packets.first { $0.nominalHostSpan != nil && $0.sourceSpans.count > 1 })
        let gap = CapturedPcmPacket(pcm: packet.pcm, epoch: packet.epoch, sequence: packet.sequence,
            outputRange: packet.outputRange, sourceRange: packet.sourceRange, sourceSpans: Array(packet.sourceSpans.dropFirst()),
            primeLeadingInputFrames: packet.primeLeadingInputFrames, primeTrailingInputFrames: packet.primeTrailingInputFrames,
            nominalHostSpan: packet.nominalHostSpan, sourceSupportEnvelope: packet.sourceSupportEnvelope, mappingQuality: packet.mappingQuality)
        let missing = try RuntimeMediaCodecV2.timing(gap)
        XCTAssertEqual(missing[1], 0); XCTAssertEqual(missing[2], 5)
        XCTAssertTrue(missing[56..<88].allSatisfy { $0 == 0 })
        let first = packet.sourceSpans[0]
        for corrupt in [
            SourceSampleSpan(bufferInputRange: 0..<1, nominalRange: first.nominalRange, sourcePTS: first.sourcePTS, sourceDuration: first.sourceDuration, convertedBufferHostSpan: first.convertedBufferHostSpan),
            SourceSampleSpan(bufferInputRange: first.bufferInputRange, nominalRange: first.nominalRange, sourcePTS: first.sourcePTS, sourceDuration: .zero, convertedBufferHostSpan: first.convertedBufferHostSpan)
        ] {
            let changed = CapturedPcmPacket(pcm: packet.pcm, epoch: packet.epoch, sequence: packet.sequence,
                outputRange: packet.outputRange, sourceRange: packet.sourceRange, sourceSpans: [corrupt] + packet.sourceSpans.dropFirst(),
                primeLeadingInputFrames: packet.primeLeadingInputFrames, primeTrailingInputFrames: packet.primeTrailingInputFrames,
                nominalHostSpan: packet.nominalHostSpan, sourceSupportEnvelope: packet.sourceSupportEnvelope, mappingQuality: packet.mappingQuality)
            XCTAssertEqual(try RuntimeMediaCodecV2.timing(changed)[1], 0, "invalid source correspondence cannot supply packet endpoints")
        }
        XCTAssertEqual(try RuntimeMediaCodecV2.timing(packet), try RuntimeMediaCodecV2.timing(packet), "encoding has no receipt clock or delay input")
    }
    func testPreparedAuthenticationConfirmationDecoderIsFragmentBounded() throws {
        let packet = try authAcceptedFixture()
        for split in 0...packet.count {
            var decoder = RuntimeMediaDecoder()
            let first = try decoder.append(Data(packet.prefix(split)))
            let second = try decoder.append(Data(packet.dropFirst(split)))
            XCTAssertEqual(first + second, [.authenticated(session: 41, bridge: "bridge-independent")])
            try decoder.finish()
        }
        for changed in [Data([77,69,68,50,3,9,0,0,0,10]), Data([77,69,68,50,2,9,0,0,0,74]), RuntimeMediaCodecV2.wrap(9, Data(repeating: 0, count: 10)), RuntimeMediaCodecV2.wrap(10, Data(repeating: 0, count: 10))] {
            var decoder = RuntimeMediaDecoder()
            XCTAssertThrowsError(try decoder.append(changed))
        }
        var truncated = RuntimeMediaDecoder()
        _ = try truncated.append(Data(packet.dropLast()))
        XCTAssertThrowsError(try truncated.finish())
    }
    func testCaptureRejectsMalformedFlagsCoordinatesAndOversizedPayload() throws {
        let fixture = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/runtime-4c97c47/timed-capture-v1/frame.json")) as! [String: Any]
        let valid = fixtureHex(fixture["timingHex"] as! String)
        for offset in [0, 1, 2, 3, 28, 32, 40, 48, 80] {
            var changed = valid; changed[offset] ^= 255
            XCTAssertThrowsError(try RuntimeMediaCodecV2.capture(session: 41, timing: changed, pcm: Data(count: 4)), "offset \(offset)")
        }
        var reversed = valid; reversed.replaceSubrange(64..<72, with: Data(count: 8))
        XCTAssertThrowsError(try RuntimeMediaCodecV2.capture(session: 41, timing: reversed, pcm: Data(count: 4)))
        XCTAssertThrowsError(try RuntimeMediaCodecV2.capture(session: 41, timing: valid, pcm: Data(count: 65_537)))
        XCTAssertThrowsError(try RuntimeMediaCodecV2.authentication(session: 41, bridge: "x\n", token: "test"))
        XCTAssertThrowsError(try RuntimeMediaCodecV2.authentication(session: 41, bridge: "x", token: String(repeating: "x", count: 129)))
    }
    func testAcceptedRuntimeFrameAndMetadataBytes() throws {
        let frame = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/runtime-4c97c47/timed-capture-v1/frame.json")) as! [String: Any]
        let metadata = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/runtime-4c97c47/timed-capture-v1/metadata.json")) as! [String: Any]
        let timing = fixtureHex(frame["timingHex"] as! String)
        XCTAssertEqual(try RuntimeMediaCodecV2.capture(session: 41, timing: timing, pcm: fixtureHex("0000ff7f")), fixtureHex(frame["frameHex"] as! String))
        XCTAssertEqual(try RuntimeMediaCodecV2.authentication(session: 41, bridge: "bridge-independent", token: "fixture-token"), fixtureHex(metadata["authenticationHex"] as! String))
        XCTAssertEqual(try RuntimeMediaCodecV2.epoch(session: 41, bridge: "bridge-independent", domain: "source-process", epoch: 1), fixtureHex(metadata["epochPacketHex"] as! String))
    }
}
