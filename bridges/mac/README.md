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
  BridgeProcess.swift         one control owner, replay, sequence, cleanup
  BridgeProcessIO.swift       bounded stdio pump and serialized run loop
  AXAccessibilityDriver.swift public AX backend and snapshot-scoped actions
  BridgeProcessConfiguration.swift strict private operator configuration
  FileEvidenceSink.swift      create-new incremental private persistence
  SystemBridgeClock.swift     system observation clock and monotonic deadlines
Sources/FeishuBridgeExecutable/main.swift   executable composition/CLI
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
  both look like that. An end is claimed only on the client's positive "meeting
  ended" notice, which is `left(reason: "ended")`. Three consecutive absent
  frames instead give up and report `left(reason: "bridge_failure")`: what was
  observed is that the bridge could not read the client, not that the meeting is
  over.
- **A session is terminal after any `left`.** The observer recovers from
  absence — a meeting window that comes back resets its absence count — but the
  reducer never un-leaves. After a `left` it emits nothing: no
  `participant_joined`, no `active_speaker`, no second `left`. A bridge that
  reported a departure and then reported activity in the same meeting would be
  claiming both.
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

## Runnable control bridge (Task 11a)

`FeishuBridgeSpike` is now an executable; the importable module keeps that name
and its library product is `FeishuBridgeLibrary`. It composes the existing
adapter/observer/reducer/recorder with a public AX backend and serialized JSONL
stdio. `connect_media` deliberately returns `media_adapter_unavailable`; no
loopback client, capture device, renderer or provider is wired into production.
The real Feishu matrix and language decision remain **unconfirmed**.

Safe local checks, requiring no app access:

```sh
swift test --package-path bridges/mac
swift build --package-path bridges/mac --product FeishuBridgeSpike
bridges/mac/.build/debug/FeishuBridgeSpike --help
PATH="/opt/homebrew/opt/node@24/bin:$PATH" node --test spikes/feishu/test/protocol.test.ts
```

### Private operator configuration and inspection (human-gated)

Do not run live modes until the operator grants Accessibility and selects a
throwaway meeting. The bridge checks trust without prompting, never launches
or activates an app, and binds an explicit PID plus bundle path/ID/build and
process launch time. A PID/build/locale change requires a refreshed config.
No app display name implies Feishu versus Lark API region.

Create a private directory **outside every repository**, using its canonical
absolute path (for example `/Users/OPERATOR/meeting-agent-evidence`), mode 0700.
Save a mode 0600 JSON config there using a local editor. The evidence directory
and every parent must be real directories, not symlinks; `/tmp` and `/var` are
symlinks on macOS (use `/private/tmp` for disposable tests). The root can be
created by the bridge only when its parent already exists.

Inspection config shape (replace PID/path/metadata with the selected process):

```json
{
  "schema": "feishu-bridge-config/v1",
  "pid": 12345,
  "bundlePath": "/Applications/Lark.app",
  "bundleIdentifier": "com.electron.lark",
  "bundleVersion": "7499.203",
  "locale": "en-US",
  "evidenceRoot": "/Users/OPERATOR/meeting-agent-evidence",
  "observationIntervalMs": 200,
  "joinDeadlineMs": 60000,
  "actionDeadlineMs": 5000,
  "axCallTimeoutMs": 50
}
```

The path/ID/build above are literal controller bundle inventory, not measured
selectors or a marketing-version claim; verify them for each run. Obtain the
exact PID from Activity Monitor, not the first similarly named process.

```sh
bridges/mac/.build/debug/FeishuBridgeSpike --config /Users/OPERATOR/meeting-agent-evidence/config.json --inspect-ax
```

Inspection writes a create-new private `inspection-*.jsonl`, never stdout. It
contains raw UI text and must not be committed/shared; this explicit mode alone
allows that content. Capture bounded snapshots in idle/in-meeting/ended/chat
states and each supported locale. It neither presses controls nor resolves
people. A tree exceeding128nodes/depth16/1024bytes per string is unavailable;
normal control allows512nodes/4096bytes. No selected/focused attribute becomes
an active-speaker highlight. Production identity remains unknown.

For control mode, add `selectors` with exactly `build`, `locale`, `measured:true`,
`identifiers`, `titles`. Build/locale must equal the outer config. `identifiers`
has exactly the fifteen field names in `LocalizedLabels.swift`; use measured
AX identifiers (or unique logical keys for explicitly measured title fallbacks).
`titles` maps those keys to at most four measured titles each. Unavailable optional
controls use empty identifiers; join field/button, meeting window/number and
leave button are mandatory. Nonempty identifiers are unique, at most512UTF8bytes;
bundled placeholder values are refused. Unknown keys, credentials, mismatched
metadata, malformed types and config over 64 KiB are refused before AX access.
Do not replace the bundled fixture labels with private measurements.

```sh
bridges/mac/.build/debug/FeishuBridgeSpike --config /Users/OPERATOR/meeting-agent-evidence/config.json
```

Control stdin/stdout use only frozen `bridge-session/v1` JSONL. Keep stdin open
until command results; EOF cancels waits and discards unissued commands (while
validating buffered framing). There is no interactive prompt or speech fallback.
Only static diagnostic codes use stderr. Input lines cap at 64 KiB; input queue
caps at 16 × 4 KiB; replay state caps at 256 command IDs without eviction. Identical
replay emits a new sequenced result without repeating a UI action. Conflicting
IDs, foreign sessions and exhausted bounds fail the generation visibly.

One process generation owns one session/occurrence/lease. A successful leave
requires a readable tree positively lacking any matching meeting window;
duplicates and unreadable trees never prove absence. Release is terminal for
new commands; exact cached replays remain answerable until the controller closes
stdin. No unrelated session can reuse that process. EOF/SIGTERM/SIGINT
reap the input worker, stop polling and attempt one bounded **recorded** leave
if joining may have occurred. Cleanup has two at-most 1-second transition waits,
plus bounded native reads/call timeouts; stdout stalls fail after 1 second.
Normal AX reads cap at 2 seconds plus the last bounded native attribute batch;
each native call is capped by `axCallTimeoutMs` (10–250ms).

Evidence uses create-new 0600 files under 0700 roots, fsyncs each token-free command
and event before output, and retains no in-memory record list. A sink failure
blocks a new unrecorded UI action. `operator_cleanup_required_departure_unconfirmed`
means the operator must inspect/leave the client; process exit is not proof of
departure. Abrupt kill/power loss cannot guarantee cleanup; a partial last JSONL
record is not a completed record. Stdout failure also cannot establish delivery.
Internal cleanup commands/results exist only in evidence: the peer must never
receive a result for a command it did not issue. After an existing terminal
`left(bridge_failure)`, later physical-departure evidence stays private too;
the control stream never emits a second `left` or resumes observation activity.

The application process factory must close/cancel and await this generation,
then forbid reuse of the physical client until departure is confirmed or the
operator resolves it. Current TypeScript `meeting-session.ts` releases its
durable lease on `bridge_failure`; that is not physical-client cleanup. Its
application-level shutdown/recovery integration is a subsequent scope. Never
silently recycle a still-joined desktop client just because a new lease exists.

Real capture/render, authenticated Runtime media and a measured identity/highlight
mapping remain separate work; see `docs/HUMAN-CHECKLIST.md` sections 3.0 and 4.0.

## Permissions

Running `swift test` needs nothing: no Feishu app, no Accessibility, Screen
Recording or Microphone grant, no audio hardware, no network, no API keys. That
is the point of keeping the driver, the device and the media endpoint behind
protocols — and it is why neither AVFoundation nor CoreAudio is imported by the
testable core.

Driving a real client will need the macOS **Accessibility** permission (to read
element state and perform actions) and, once a real `AudioDevicePort` exists,
the appropriate audio permissions. ScreenCaptureKit audio capture additionally
requires **Screen Recording** permission; Accessibility alone does not grant
audio capture. Nothing in this control-only executable requests those grants
or changes audio routes. OCR is not implemented or authorized here.

## Dependencies

None. No external Swift package is fetched, on purpose: this must build offline,
and a bridge that reads a live meeting UI is a poor place for third-party code.

## Tests

```
swift test
```
