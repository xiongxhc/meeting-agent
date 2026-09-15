import XCTest
@testable import FeishuBridgeSpike

func meetingFixture(_ path: String) throws -> Data {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try Data(contentsOf: root.appendingPathComponent(path))
}

final class BridgeProtocolV2Tests: XCTestCase {
    func testTimedCredentialIsStructurallyAbsentFromIncrementalEvidenceAndRetainedHistory() throws {
        let fixture = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/contracts/bridge-session-v2.json")) as! [String: Any]
        var media = (fixture["commands"] as! [[String: Any]])[1]
        var lease = media["mediaLease"] as! [String: Any]
        let secret = "synthetic-private-token-never-in-evidence"
        lease["credential"] = secret; media["mediaLease"] = lease
        let sink = MemoryEvidenceSink()
        let recorder = BridgeRecorder(sessionId: "bridge-independent", clock: SequentialClock(start: "2026-09-02T00:00:00.000Z"), sink: sink)
        XCTAssertTrue(recorder.record(command: try BridgeCommandMessageV2.decode(JSONSerialization.data(withJSONObject: media))))
        let line = try JSONSerialization.jsonObject(with: sink.data) as! [String: Any]
        let recorded = (line["message"] as! [String: Any])["mediaLease"] as! [String: Any]
        XCTAssertNil(recorded["credential"])
        XCTAssertEqual(recorded["sessionId"] as? String, "41")
        XCTAssertFalse(String(decoding: sink.data, as: UTF8.self).contains(secret))
        XCTAssertTrue(recorder.records.isEmpty); XCTAssertEqual(try recorder.jsonl(), "")
    }
    func testSharedFixtureAndLeaseBindingRejectUnknownLegacyAndLossyIntegers() throws {
        let fixture = try JSONSerialization.jsonObject(with: meetingFixture("fixtures/contracts/bridge-session-v2.json")) as! [String: Any]
        for command in fixture["commands"] as! [[String: Any]] {
            let data = try JSONSerialization.data(withJSONObject: command)
            let decoded = try BridgeCommandMessageV2.decode(data)
            XCTAssertEqual(decoded.sessionId, "bridge-independent")
            XCTAssertThrowsError(try JSONDecoder().decode(BridgeCommandMessage.self, from: data))
        }
        for event in fixture["events"] as! [[String: Any]] {
            let data = try JSONSerialization.data(withJSONObject: event)
            XCTAssertEqual(try BridgeEventMessageV2.decode(data).sessionId, "bridge-independent")
            XCTAssertThrowsError(try JSONDecoder().decode(BridgeEventMessage.self, from: data))
        }
        let media = (fixture["commands"] as! [[String: Any]])[1]
        for patch: [String: Any] in [["sessionId": 41], ["sessionId": "041"], ["sessionId": "18446744073709551616"], ["bridgeSessionId": "other"], ["mediaProtocolVersion": 1], ["captureFormat": "pcm_f32le/24000/1/20ms"], ["credential": ""], ["extra": true]] {
            var changed = media
            changed["mediaLease"] = (media["mediaLease"] as! [String: Any]).merging(patch) { _, new in new }
            XCTAssertThrowsError(try BridgeCommandMessageV2.decode(JSONSerialization.data(withJSONObject: changed)))
        }
    }
}
