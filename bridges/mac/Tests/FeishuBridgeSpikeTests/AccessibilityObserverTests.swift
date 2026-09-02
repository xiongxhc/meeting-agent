import XCTest

@testable import FeishuBridgeSpike

/// Observation tests against fake accessibility trees.
///
/// The ambiguity policy under test is defined by `spikes/feishu/src/reducer.ts`,
/// not here: two or more highlighted tiles, or a single tile whose identity
/// cannot be resolved, yields an ambiguous observation carrying no person id.
/// A participant is never picked, and a speaker is never inferred from the
/// attendee list or from how long a tile has been lit.
final class AccessibilityObserverTests: XCTestCase {

    private let identity = FakeIdentityResolver(table: [
        "tile-1": "ou_00000000000000000000000000000a",
        "tile-2": "ou_00000000000000000000000000000b",
        "row-1": "ou_00000000000000000000000000000a",
        "row-2": "ou_00000000000000000000000000000b",
    ])

    private func observer() -> AccessibilityObserver {
        AccessibilityObserver(identity: identity)
    }

    private func reducer(chat: ChatControlPort = FakeChatControl(outcome: .sent))
        -> SessionObservationReducer
    {
        SessionObservationReducer(
            sessionId: "sess_mac_0000000000000001",
            identity: identity,
            chatControl: chat
        )
    }

    private let at1 = "2026-09-02T14:00:10.000Z"
    private let at2 = "2026-09-02T14:00:20.000Z"

    // MARK: - what the observer reads off a tree

    func testReadsRosterAndHighlightsFromAMeetingWindow() {
        let tree = FakeTree.inMeeting(
            roster: [("row-1", "Test Participant One"), ("row-2", "Test Participant Two")],
            tiles: [("tile-1", true), ("tile-2", false)]
        )

        XCTAssertEqual(
            observer().observations(from: tree, at: at1),
            [
                .rosterSnapshot(
                    observedAt: at1,
                    participants: [
                        RosterEntry(
                            feishuUserId: "ou_00000000000000000000000000000a",
                            displayName: "Test Participant One"),
                        RosterEntry(
                            feishuUserId: "ou_00000000000000000000000000000b",
                            displayName: "Test Participant Two"),
                    ]),
                .speakerHighlight(observedAt: at1, highlightedTileIds: ["tile-1"]),
            ]
        )
    }

    func testLocatesControlsByLocalizedTitleWhenNoIdentifierIsExposed() {
        let tree = FakeTree.inMeeting(
            roster: [("row-1", "Test Participant One")],
            tiles: [("tile-1", true)],
            localizedOnly: true
        )
        XCTAssertEqual(observer().observations(from: tree, at: at1).count, 2)
    }

    func testAMissingMeetingWindowIsObservedAsTheMeetingHavingEnded() {
        let tree = FakeTree.idleWithJoinSurface()
        XCTAssertEqual(observer().observations(from: tree, at: at2), [.meetingEnded(observedAt: at2)])
    }

    func testAnAbsentRosterPanelReportsNoMembershipRatherThanAnEmptyOne() {
        let tree = FakeTree.inMeeting(roster: nil, tiles: [("tile-1", false)])
        XCTAssertEqual(
            observer().observations(from: tree, at: at1),
            [.speakerHighlight(observedAt: at1, highlightedTileIds: [])],
            "a panel that is not on screen is unknown membership, not an empty meeting"
        )
    }

    func testARosterRowWhoseIdentityIsUnresolvableIsNotGivenAGuessedId() {
        let tree = FakeTree.inMeeting(
            roster: [("row-1", "Test Participant One"), ("row-unknown", "Test Participant Three")],
            tiles: []
        )
        guard case .rosterSnapshot(_, let participants) = observer().observations(
            from: tree, at: at1
        ).first else {
            return XCTFail("expected a roster snapshot")
        }
        XCTAssertEqual(participants.map(\.feishuUserId), ["ou_00000000000000000000000000000a"])
    }

    // MARK: - membership

    func testActualParticipantMembershipComesFromTheRosterPanel() {
        let reducer = reducer()
        let first = reducer.reduce(
            .rosterSnapshot(
                observedAt: at1,
                participants: [
                    RosterEntry(
                        feishuUserId: "ou_00000000000000000000000000000a",
                        displayName: "Test Participant One")
                ]))
        XCTAssertEqual(
            first.map(\.event),
            [
                .participantJoined(
                    feishuUserId: "ou_00000000000000000000000000000a",
                    displayName: "Test Participant One")
            ])

        let second = reducer.reduce(
            .rosterSnapshot(
                observedAt: at2,
                participants: [
                    RosterEntry(
                        feishuUserId: "ou_00000000000000000000000000000b",
                        displayName: "Test Participant Two")
                ]))
        XCTAssertEqual(
            second.map(\.event),
            [
                .participantLeft(feishuUserId: "ou_00000000000000000000000000000a"),
                .participantJoined(
                    feishuUserId: "ou_00000000000000000000000000000b",
                    displayName: "Test Participant Two"),
            ],
            "departures are emitted before arrivals, matching the reference reducer"
        )
        XCTAssertEqual(second.map(\.sequence), [2, 3])
    }

    func testAnUnchangedRosterEmitsNothing() {
        let reducer = reducer()
        let roster: [RosterEntry] = [
            RosterEntry(
                feishuUserId: "ou_00000000000000000000000000000a",
                displayName: "Test Participant One")
        ]
        XCTAssertEqual(reducer.reduce(.rosterSnapshot(observedAt: at1, participants: roster)).count, 1)
        XCTAssertEqual(reducer.reduce(.rosterSnapshot(observedAt: at2, participants: roster)), [])
    }

    // MARK: - active speaker

    func testASingleResolvedHighlightIsUiExact() {
        let events = reducer().reduce(.speakerHighlight(observedAt: at1, highlightedTileIds: ["tile-1"]))
        XCTAssertEqual(
            events.map(\.event),
            [.activeSpeaker(.uiExact(feishuUserId: "ou_00000000000000000000000000000a"))])
        XCTAssertEqual(events.first?.observedAt, at1, "the event carries the observation's own time")
    }

    func testASpeakerSwitchEmitsOncePerChangeAndNeverRepeatsTheSameSpeaker() {
        let reducer = reducer()
        XCTAssertEqual(
            reducer.reduce(.speakerHighlight(observedAt: at1, highlightedTileIds: ["tile-1"])).count, 1)
        XCTAssertEqual(
            reducer.reduce(.speakerHighlight(observedAt: at1, highlightedTileIds: ["tile-1"])), [],
            "a highlight that persists across frames is not a new speaker")
        XCTAssertEqual(
            reducer.reduce(.speakerHighlight(observedAt: at2, highlightedTileIds: ["tile-2"])).map(
                \.event),
            [.activeSpeaker(.uiExact(feishuUserId: "ou_00000000000000000000000000000b"))])
    }

    func testTwoHighlightedTilesAreAmbiguousEvenWhenBothResolve() {
        let events = reducer().reduce(
            .speakerHighlight(observedAt: at1, highlightedTileIds: ["tile-1", "tile-2"]))
        XCTAssertEqual(events.map(\.event), [.activeSpeaker(.ambiguous)])
        guard case .activeSpeaker(let speaker) = events.first?.event else {
            return XCTFail("expected an active_speaker event")
        }
        XCTAssertNil(speaker.feishuUserId, "overlap is never resolved to one of the known people")
    }

    func testAnUnresolvableSingleHighlightIsAmbiguousRatherThanDropped() {
        let events = reducer().reduce(
            .speakerHighlight(observedAt: at1, highlightedTileIds: ["tile-unknown"]))
        XCTAssertEqual(events.map(\.event), [.activeSpeaker(.ambiguous)])
    }

    func testNoHighlightAtAllChangesNothing() {
        XCTAssertEqual(reducer().reduce(.speakerHighlight(observedAt: at1, highlightedTileIds: [])), [])
    }

    func testTheSpeakerIsNeverInferredFromTheAttendeeListWhenNoTileIsLit() {
        let reducer = reducer()
        _ = reducer.reduce(
            .rosterSnapshot(
                observedAt: at1,
                participants: [
                    RosterEntry(
                        feishuUserId: "ou_00000000000000000000000000000a",
                        displayName: "Test Participant One")
                ]))
        let events = reducer.reduce(.speakerHighlight(observedAt: at2, highlightedTileIds: []))
        XCTAssertEqual(
            events, [],
            "a single attendee is still not evidence that that attendee is speaking")
    }

    // MARK: - join and leave

    func testJoiningEmitsAJoinedEventCarryingTheOccurrenceItWasAskedFor() {
        let events = reducer().reduce(
            .joined(observedAt: at1, meetingOccurrenceId: "900000001@2026-09-02T14:00:00Z"))
        XCTAssertEqual(
            events.map(\.event), [.joined(meetingOccurrenceId: "900000001@2026-09-02T14:00:00Z")])
        XCTAssertEqual(events.map(\.sequence), [1])
    }

    func testMeetingEndedBecomesALeftEvent() {
        XCTAssertEqual(
            reducer().reduce(.meetingEnded(observedAt: at2)).map(\.event), [.left(reason: .ended)])
    }

    // MARK: - disclosure

    func testAnUnreachableChatControlIsRecordedAsUnavailable() {
        let chat = FakeChatControl(outcome: .unavailable)
        let events = reducer(chat: chat).reduce(
            .disclosureAttempt(observedAt: at1, text: "A meeting agent is present."))
        XCTAssertEqual(events.map(\.event), [.chatDisclosure(outcome: .unavailable)])
        XCTAssertEqual(chat.attempts, ["A meeting agent is present."])
    }

    func testAFailedDisclosureDoesNotStopTheSessionFromCarryingOn() {
        let reducer = reducer(chat: FakeChatControl(outcome: .failed))
        XCTAssertEqual(
            reducer.reduce(.disclosureAttempt(observedAt: at1, text: "A meeting agent is present."))
                .map(\.event), [.chatDisclosure(outcome: .failed)])
        XCTAssertEqual(
            reducer.reduce(.speakerHighlight(observedAt: at2, highlightedTileIds: ["tile-1"])).map(
                \.event),
            [.activeSpeaker(.uiExact(feishuUserId: "ou_00000000000000000000000000000a"))],
            "failing to disclose never blocks the rest of the session")
    }

    // MARK: - sequencing

    func testSequenceNumbersAreMonotonicAcrossEveryObservationKind() {
        let reducer = reducer()
        var sequences: [Int] = []
        sequences += reducer.reduce(.joined(observedAt: at1, meetingOccurrenceId: "m@t")).map(\.sequence)
        sequences += reducer.reduce(
            .rosterSnapshot(
                observedAt: at1,
                participants: [
                    RosterEntry(
                        feishuUserId: "ou_00000000000000000000000000000a",
                        displayName: "Test Participant One")
                ])
        ).map(\.sequence)
        sequences += reducer.reduce(.speakerHighlight(observedAt: at1, highlightedTileIds: ["tile-1"]))
            .map(\.sequence)
        sequences += reducer.reduce(.meetingEnded(observedAt: at2)).map(\.sequence)
        XCTAssertEqual(sequences, [1, 2, 3, 4])
    }
}
