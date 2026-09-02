# Feishu Mac bridge (spike)

The macOS half of the Feishu bridge: it reads the Feishu client's accessibility
tree, drives its controls, and emits the frozen `bridge-session/v1` event stream
that `protocols/bridge-session-v1.schema.json` defines.

**This package has never been run against a real Feishu client.** Every test
runs against synthetic accessibility trees and synthetic marker bytes. Nothing
here has measured anything about a real client, no audio sample has ever passed
through it, and the accessibility identifiers it looks for are placeholders —
see "Placeholders" below. No latency, echo, or barge-in figure exists anywhere
in this repository.

## Layout

```
Sources/FeishuBridgeSpike/
  BridgeProtocol.swift        bridge-session/v1 as Swift types + fail-closed coding
  AccessibilityObserver.swift tree -> raw observations -> events (ambiguity policy)
  FeishuClientAdapter.swift   join, leave, type one disclosure
  AudioBridge.swift           duplex media: negotiation, frame path, jitter, barge-in
  LoopbackMediaClient.swift   in-process stand-in for the Rust media endpoint
  BridgeRecorder.swift        JSONL evidence, injected clock
  LocalizedLabels.swift       the ONLY file holding UI strings
Tests/FeishuBridgeSpikeTests/
  BridgeContractTests.swift        round-trips the frozen fixture from disk
  AccessibilityObserverTests.swift observation + ambiguity rules
  FeishuClientAdapterTests.swift   join/leave/disclosure against fake trees
  AudioBridgeTests.swift           the media rules, and the no-Node assertions
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
- **Media frames never touch the control plane.** Frames travel directly between
  `AudioBridge` and the Rust Conversation Runtime endpoint that `connect_media`
  names; TypeScript/Node is the control plane only and never relays a frame.
  `BridgeControlPlane` is the single door to it and carries a `BridgeEvent`, an
  enum no case of which can hold audio bytes — so a frame is not expressible on
  that surface at all — that type-level argument is the load-bearing one. The
  tests add two more: a tripwire control plane counts every call and records
  none across a 960-frame duplex exchange, and the frames the endpoint received
  are compared value-for-value and in order against what the bridge produced, so
  nothing relayed, re-encoded, batched or reordered the stream. A fourth test
  checks only that the frame path spawns no subprocess; it is deliberately not
  described as a no-Node assertion, because a real Node relay would be a sibling
  service rather than a child of a test process and this could not detect one.
- **A silence the bridge caused is not an `audio_gap`.** A mute and a barge-in
  are explained silences and emit nothing. An `audio_gap` is claimed only from
  an observed discontinuity: capture reports one between the last capture the
  bridge actually saw and the next one, and playback reports one when the jitter
  buffer starts dropping.
- **A gap whose end was not observed keeps `endedAt: null`.** A playback gap
  opens when dropping begins and is closed only when the buffer takes a frame
  without dropping one. If the media session disconnects while a gap is open,
  the gap stays open — no end is invented for it, the same asymmetry the
  meeting-ended rule uses.
- **The jitter buffer is bounded and overflow is loud.** The bound is 200 ms of
  playback audio, converted to frames by the negotiated frame duration. It is
  deliberately shallow: barge-in must stop agent speech within 300 ms and
  cancellation discards whatever is queued, so a deeper buffer buys nothing and
  costs latency on every turn. On overflow the *oldest* frame is dropped — stale
  audio is the worthless one in a live conversation — and the drop is counted in
  `playbackFramesDroppedByOverflow` and opens an `audio_gap`. Nothing is dropped
  silently.
- **Cancellation is immediate and it does not drain.** `cancelPlayback()` empties
  the buffer at once and goes on discarding inbound frames until
  `resumePlayback()`, because the runtime keeps emitting the cancelled utterance
  for as long as the cancellation takes to reach it. Without that gate the
  buffer refills and the agent talks over the interruption.
- **A format that could not be negotiated is a refusal.** An unparseable format,
  one the device cannot carry, or an expired session token all return a rejection
  and leave the endpoint unopened. The nearest supported format is never
  substituted behind the coordinator's back.
- **Time is injected.** Nothing calls `Date()` inline; `BridgeClock` is the only
  source of "now", which is what makes recorded evidence reproducible. Frames
  are stamped from `MediaClock.monotonicMilliseconds()` instead, so a wall-clock
  correction mid-meeting cannot move a frame; a monotonic source that goes
  backwards fails the media session with `media_clock_regressed` rather than
  putting a backwards stamp in the timeline.

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
`AccessibilityDriver`, `UiIdentityResolver`, `MediaEndpointClient`,
`AudioDevicePort` and `MediaClock` as protocols with only fakes behind them. A
real run needs an `AXUIElement`-backed driver honouring the timing contract
above, a real identity resolver — *if* the client exposes anything resolvable to
a Feishu user id, which is itself an open feasibility question — a media client
that dials the Rust runtime endpoint, a device port over the real capture and
render units, a monotonic clock that is not the wall clock, and an entry point
wiring adapter, observer, reducer, audio bridge and recorder together. No task
in the current plan owns any of them; see `docs/HUMAN-CHECKLIST.md` sections 3.0
and 4.0.

## Permissions

Running `swift test` needs nothing: no Feishu app, no Accessibility, Screen
Recording or Microphone grant, no audio hardware, no network, no API keys. That
is the point of keeping the driver, the device and the media endpoint behind
protocols — and it is why neither AVFoundation nor CoreAudio is imported by the
testable core.

Driving a real client will need the macOS **Accessibility** permission (to read
element state and perform actions) and, once a real `AudioDevicePort` exists,
the **Microphone** permission. Nothing in this package has ever requested
Microphone. Screen Recording is only needed if an observation turns out to be
OCR-based rather than accessibility-based; nothing in this package needs it
today.

## Dependencies

None. No external Swift package is fetched, on purpose: this must build offline,
and a bridge that reads a live meeting UI is a poor place for third-party code.

## Tests

```
swift test
```
