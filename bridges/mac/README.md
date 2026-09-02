# Feishu Mac bridge (spike)

The macOS half of the Feishu bridge: it reads the Feishu client's accessibility
tree, drives its controls, and emits the frozen `bridge-session/v1` event stream
that `protocols/bridge-session-v1.schema.json` defines.

**This package has never been run against a real Feishu client.** Every test
runs against synthetic accessibility trees. Nothing here has measured anything
about a real client, and the accessibility identifiers it looks for are
placeholders — see "Placeholders" below.

## Layout

```
Sources/FeishuBridgeSpike/
  BridgeProtocol.swift        bridge-session/v1 as Swift types + fail-closed coding
  AccessibilityObserver.swift tree -> raw observations -> events (ambiguity policy)
  FeishuClientAdapter.swift   join, leave, type one disclosure
  BridgeRecorder.swift        JSONL evidence, injected clock
  LocalizedLabels.swift       the ONLY file holding UI strings
Tests/FeishuBridgeSpikeTests/
  BridgeContractTests.swift        round-trips the frozen fixture from disk
  AccessibilityObserverTests.swift observation + ambiguity rules
  FeishuClientAdapterTests.swift   join/leave/disclosure against fake trees
  BridgeRecorderTests.swift        evidence bytes and stream rules
  FakeAccessibilityTrees.swift     the synthetic trees and fake ports
```

## The rules this package exists to hold

- **Speaker identity is never guessed.** Two or more highlighted tiles, or a
  single tile whose identity cannot be resolved, yields `active_speaker` with
  `confidence: "ambiguous"` and a null id — even when every highlighted tile is
  individually resolvable. `ActiveSpeaker` is an enum with two cases, so a
  speaker id beside an ambiguous confidence is not merely rejected but
  unrepresentable. The policy itself is defined by
  `spikes/feishu/src/reducer.ts`; this is its second implementation, not a
  second definition.
- **The disclosure is meeting-chat text.** There is no speech path in this
  package and none is to be added. An unreachable chat control is `unavailable`,
  and failing to disclose never blocks joining.
  `FeishuClientAdapter.postDisclosureOnce` marks the attempt *before* making it,
  so a failure part-way through can never become a second chat message.
- **A claim is only made once the UI shows it.** `join` returns `.joined` only
  after the meeting window is on screen *and* shows the meeting number that was
  asked for; a different number is `.rejected`, never relabelled. `leave`
  returns `.left` only after the meeting window is gone.
- **Membership comes from the roster panel.** A panel that is not on screen is
  unknown membership, not an empty meeting, so no `participant_left` is invented
  for a panel that merely closed. A roster row whose identity cannot be resolved
  is left out rather than given a guessed id.
- **Absence of evidence is not an ended meeting.** A tree with no locatable
  meeting window is `unobservable` — a backgrounded client and a partial read
  both look like that. An end is claimed on the client's positive "meeting
  ended" notice, or failing that only after three consecutive absent frames, and
  `left` is emitted at most once per session.
- **The UI is re-read after every action.** `snapshot(waitingUpTo:)` carries a
  timing contract: keep re-reading until the tree changes or the deadline
  elapses. The adapter waits 60s after pressing join (a waiting-room join takes
  as long as the host takes to admit) and 5s after a within-meeting press.
  Searching a pre-press tree for a control the press was meant to reveal is how
  a collapsed chat panel becomes a false `unavailable`.
- **Time is injected.** Nothing calls `Date()` inline; `BridgeClock` is the only
  source of "now", which is what makes recorded evidence reproducible.

## Placeholders

`LocalizedLabels.swift` holds every accessibility identifier and localized title
the adapter looks for, and **none of those values was captured from a real
client**. The tests prove the locating strategy — identifier first, localized
title as fallback — not the values. Capturing the real ones is the first
human-gated step in `docs/HUMAN-CHECKLIST.md`, section Plan 1 Task 3, and must
happen before `docs/feasibility/feishu-client-matrix.md` can hold a single
measurement.

## What is missing before this can drive a real client

The package declares a library and a test target, no executable, and ships
`AccessibilityDriver` and `UiIdentityResolver` as protocols with only fakes
behind them. A real run needs an `AXUIElement`-backed driver honouring the
timing contract above, a real identity resolver — *if* the client exposes
anything resolvable to a Feishu user id, which is itself an open feasibility
question — and an entry point wiring adapter, observer, reducer, and recorder
together. No task in the current plan owns any of the three; see
`docs/HUMAN-CHECKLIST.md` section 3.0.

## Permissions

Running `swift test` needs nothing: no Feishu app, no Accessibility or Screen
Recording grant, no network, no API keys. That is the point of keeping the
driver behind a protocol.

Driving a real client will need the macOS **Accessibility** permission (to read
element state and perform actions). Screen Recording is only needed if an
observation turns out to be OCR-based rather than accessibility-based; nothing
in this package needs it today.

## Dependencies

None. No external Swift package is fetched, on purpose: this must build offline,
and a bridge that reads a live meeting UI is a poor place for third-party code.

## Tests

```
swift test
```
