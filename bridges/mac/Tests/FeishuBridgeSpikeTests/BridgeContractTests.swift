import XCTest

@testable import FeishuBridgeSpike

/// Cross-language contract tests (controller ruling R21).
///
/// These read `fixtures/contracts/bridge-session-v1.json` — the frozen bytes,
/// from disk, not a literal copied into this file — and prove the Swift view of
/// `bridge-session/v1` decodes and re-encodes every command type and every event
/// type without loss. A contract shared by two languages with a test in only one
/// of them is frozen in name only.
final class BridgeContractTests: XCTestCase {

    /// The repo root, derived from this file's own path. Five levels up from
    /// `bridges/mac/Tests/FeishuBridgeSpikeTests/BridgeContractTests.swift`.
    private static let repoRoot: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // FeishuBridgeSpikeTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // mac
        .deletingLastPathComponent()  // bridges
        .deletingLastPathComponent()  // repo root

    private static let contractURL: URL =
        repoRoot
        .appendingPathComponent("fixtures")
        .appendingPathComponent("contracts")
        .appendingPathComponent("bridge-session-v1.json")

    private func frozenBytes() throws -> Data {
        try Data(contentsOf: Self.contractURL)
    }

    private func decodedTranscript() throws -> BridgeSessionTranscript {
        try JSONDecoder().decode(BridgeSessionTranscript.self, from: frozenBytes())
    }

    func testFrozenContractFixtureExistsOnDisk() throws {
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: Self.contractURL.path),
            "the frozen contract fixture must be read from disk at \(Self.contractURL.path)"
        )
    }

    func testDecodesEveryCommandTypeInTheContract() throws {
        let transcript = try decodedTranscript()
        XCTAssertEqual(transcript.sessionId, "sess_0000000000000001")
        XCTAssertEqual(
            transcript.commands.map { $0.command.typeName },
            ["join", "connect_media", "post_disclosure", "leave", "release_lease"]
        )
        XCTAssertEqual(
            Set(transcript.commands.map { $0.command.typeName }),
            Set(BridgeCommand.allTypeNames),
            "the fixture must exercise every declared command type"
        )
    }

    func testDecodesEveryEventTypeInTheContract() throws {
        let transcript = try decodedTranscript()
        XCTAssertEqual(
            Set(transcript.events.map { $0.event.typeName }),
            Set(BridgeEvent.allTypeNames),
            "the fixture must exercise every declared event type"
        )
        XCTAssertEqual(
            transcript.events.map(\.sequence),
            Array(1...14),
            "sequence numbers decode in order"
        )
    }

    func testBothActiveSpeakerShapesDecodeAndNeverGuessAnIdentity() throws {
        let speakers = try decodedTranscript().events.compactMap { message -> ActiveSpeaker? in
            guard case .activeSpeaker(let speaker) = message.event else { return nil }
            return speaker
        }
        XCTAssertEqual(speakers.count, 2)
        XCTAssertEqual(speakers.first, .uiExact(feishuUserId: "ou_000000000000000000000000000001"))
        XCTAssertEqual(speakers.last, .ambiguous)
        XCTAssertEqual(speakers.last?.feishuUserId, nil)
        XCTAssertEqual(speakers.last?.confidence, "ambiguous")
    }

    func testAudioGapDecodesBothAnEndedAndAnOpenGap() throws {
        let gaps = try decodedTranscript().events.compactMap {
            message -> (AudioDirection, String, String?)? in
            guard case .audioGap(let direction, let startedAt, let endedAt) = message.event else {
                return nil
            }
            return (direction, startedAt, endedAt)
        }
        XCTAssertEqual(gaps.count, 2)
        XCTAssertEqual(gaps.first?.0, .capture)
        XCTAssertEqual(gaps.first?.2, "2026-09-02T14:03:39.500Z")
        XCTAssertEqual(gaps.last?.0, .playback)
        XCTAssertNil(gaps.last?.2, "an unfinished gap keeps a null endedAt, never a filled-in guess")
    }

    func testRoundTripsToSemanticallyIdenticalJson() throws {
        let transcript = try decodedTranscript()
        let reencoded = try JSONEncoder().encode(transcript)

        let original = try JSONSerialization.jsonObject(with: frozenBytes())
        let actual = try JSONSerialization.jsonObject(with: reencoded)
        XCTAssertEqual(
            original as? NSDictionary,
            actual as? NSDictionary,
            "re-encoding the frozen bytes must not add, drop, or alter a single member"
        )

        let redecoded = try JSONDecoder().decode(BridgeSessionTranscript.self, from: reencoded)
        XCTAssertEqual(redecoded, transcript)
    }

    func testAmbiguousActiveSpeakerEncodesAnExplicitNullRatherThanOmittingTheKey() throws {
        let message = BridgeEventMessage(
            sessionId: "sess_test",
            sequence: 1,
            observedAt: "2026-09-02T14:00:00.000Z",
            event: .activeSpeaker(.ambiguous)
        )
        let object =
            try JSONSerialization.jsonObject(with: JSONEncoder().encode(message))
            as? [String: Any]
        XCTAssertTrue(
            object?["feishuUserId"] is NSNull,
            "feishuUserId must be present and null; an omitted key is a different wire shape"
        )
        XCTAssertEqual(object?["confidence"] as? String, "ambiguous")
    }

    // MARK: - fail-closed decoding

    /// Asserts not merely that decoding threw, but that it threw the contract's
    /// own rejection with the code and path the TypeScript view uses.
    private func expectRejection(
        _ json: String,
        code: BridgeContractError.Code,
        path: String,
        _ message: String,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(
            try JSONDecoder().decode(BridgeEventMessage.self, from: Data(json.utf8)),
            message, line: line
        ) { error in
            guard let rejection = error as? BridgeContractError else {
                return XCTFail("expected a BridgeContractError, got \(error)", line: line)
            }
            XCTAssertEqual(rejection.code, code, message, line: line)
            XCTAssertEqual(rejection.path, path, message, line: line)
        }
    }

    func testRejectsAnUnknownSchemaVersion() {
        expectRejection(
            """
            {"schema":"bridge-session/v2","sessionId":"s","sequence":1,
             "observedAt":"2026-09-02T14:00:00Z","type":"joined","meetingOccurrenceId":"m"}
            """,
            code: .schemaUnknown, path: "/schema",
            "an unrecognised schema version is rejected, never upgraded"
        )
    }

    func testRejectsAnUnknownFieldRatherThanIgnoringIt() {
        expectRejection(
            """
            {"schema":"bridge-session/v1","sessionId":"s","sequence":1,
             "observedAt":"2026-09-02T14:00:00Z","type":"joined","meetingOccurrenceId":"m",
             "extra":"nope"}
            """,
            code: .unknownField, path: "/extra",
            "unknown fields are rejected, not ignored"
        )
    }

    func testRejectsUiExactWithoutAnObservedIdentity() {
        expectRejection(
            """
            {"schema":"bridge-session/v1","sessionId":"s","sequence":1,
             "observedAt":"2026-09-02T14:00:00Z","type":"active_speaker",
             "feishuUserId":null,"confidence":"ui_exact"}
            """,
            code: .speakerIdentityRequired, path: "/feishuUserId",
            "ui_exact requires an observed user id"
        )
    }

    func testRejectsAmbiguousCarryingAnIdentity() {
        expectRejection(
            """
            {"schema":"bridge-session/v1","sessionId":"s","sequence":1,
             "observedAt":"2026-09-02T14:00:00Z","type":"active_speaker",
             "feishuUserId":"ou_1","confidence":"ambiguous"}
            """,
            code: .speakerIdentityForbidden, path: "/feishuUserId",
            "ambiguous must stay anonymous; speaker identity is never guessed"
        )
    }

    func testRejectsANonUtcTimestamp() {
        expectRejection(
            """
            {"schema":"bridge-session/v1","sessionId":"s","sequence":1,
             "observedAt":"2026-09-02 14:00:00","type":"joined","meetingOccurrenceId":"m"}
            """,
            code: .timestampFormat, path: "/observedAt",
            "observedAt must be a Z-suffixed UTC timestamp"
        )
    }

    func testRejectsAnEmptyRequiredString() {
        expectRejection(
            """
            {"schema":"bridge-session/v1","sessionId":"s","sequence":1,
             "observedAt":"2026-09-02T14:00:00Z","type":"participant_left","feishuUserId":""}
            """,
            code: .fieldType, path: "/feishuUserId",
            "required strings are non-empty"
        )
    }
}
