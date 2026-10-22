# Feishu Mac bridge (spike)

The macOS half of the Feishu bridge: it reads the Feishu client's accessibility
tree, drives its controls, and emits frozen `bridge-session/v1` (config1/2) or
opt-in `bridge-session/v2` timed media/UI evidence (config3).

**This package has never been run against a real Feishu client.** Every test
runs against synthetic accessibility trees, memory-only synthetic audio, or
owned loopback TCP peers.
Native CPU conversion is tested, but no real captured audio has passed through
the bridge and no real client has been measured. Bundled accessibility identifiers are placeholders —
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
  CapturedAudio.swift         bounded native sample copy and source-clock evidence
  PcmCaptureConverter.swift   persistent CPU converter and piecewise sample maps
  SystemAudioCapture.swift    bounded capture owner and lazy public SCK backend
  AudioOutputRenderer.swift  explicit-device owner and lazy native playback
Sources/FeishuBridgeExecutable/main.swift   executable composition/CLI
Tests/FeishuBridgeSpikeTests/
  BridgeContractTests.swift        round-trips the frozen fixture from disk
  AccessibilityObserverTests.swift observation + ambiguity rules
  FeishuClientAdapterTests.swift   join/leave/disclosure against fake trees
  AudioBridgeTests.swift           the media rules, and the no-Node assertions
  BridgeRecorderTests.swift        evidence bytes and stream rules
  FakeAccessibilityTrees.swift     the synthetic trees and fake ports
```

## Original spike rules (legacy AudioBridge and bridge-session/v1)

The receipt clock/jitter behavior below belongs to the original synthetic
`AudioBridge`, not the config3 timed path. Task11d below specifies that path.

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
stdio. Config1/2 `connect_media` returns `media_adapter_unavailable`;
config3 separately composes the timed path described below.
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
an active-speaker highlight. Production identity remains unknown unless the
measured `selectors.identity` below is configured.

For control mode, add `selectors` with exactly `build`, `locale`, `measured:true`,
`identifiers`, `titles`. Build/locale must equal the outer config. `identifiers`
has exactly the fifteen field names in `LocalizedLabels.swift`; use measured
AX identifiers (or unique logical keys for explicitly measured title fallbacks).
`titles` maps those keys to at most four measured titles each. Unavailable optional
controls use empty identifiers; join field/button, meeting window/number and
leave button are mandatory. Nonempty identifiers are unique, at most512UTF8bytes;
bundled placeholder values are refused. Unknown keys, credentials, mismatched
metadata, malformed types and config over 64 KiB are refused before AX access.
Configuration reads continue through short reads/EINTR to EOF, reject a 65,537th
byte even if the file grew after its size check, and bound retries to one second
(this does not preempt a filesystem syscall).
Do not replace the bundled fixture labels with private measurements.

`selectors` may also carry two optional measured channels (HUMAN-CHECKLIST 3.0b).
`identity` is exactly `{"attribute", "pattern"}`. The attribute must be an
identifier-type attribute, `AXIdentifier` (the suffix after the row/tile prefix)
or `AXDOMIdentifier`; text-bearing attributes such as `AXValue`, `AXHelp` and
`AXTitle` are refused. The pattern must match the whole handle and is limited to
`^` + literals, `\.`, `\-`, `\d` and simple `[...]` classes + `$`, with any number
of `{m}` and at most one `?`, `*`, `+` or `{m,n}`, so matching stays linear. Rows
and tiles share it, so attendance and speaker ids are one namespace. `highlight`
is exactly `{"attribute", "speakingValue"}`, read only on speaker tiles.
Placeholders and focus/selection attributes (`AXSelected`, `AXFocused`, ...) are
refused. A
handle that is missing, malformed, unmatched or equal to the row title is
unresolved; an unreadable highlight stays unknown. Without `identity` the bridge
emits no `participant_joined`; without both, no `ui_exact`. These reads run on the UI
observation path only; capture and recording do not wait on them.

```sh
bridges/mac/.build/debug/FeishuBridgeSpike --config /Users/OPERATOR/meeting-agent-evidence/config.json
```

Config1/2 stdin/stdout use frozen `bridge-session/v1` JSONL. Keep stdin open
until command results; EOF cancels waits and discards unissued commands (while
validating buffered framing). There is no interactive prompt or speech fallback.
Only static diagnostic codes use stderr. Input lines cap at 64 KiB; input queue
caps at 16 × 4 KiB; replay state caps at 256 command IDs without eviction. Identical
replay emits a new sequenced result without repeating a UI action. Conflicting
IDs, foreign sessions and exhausted bounds fail the generation visibly.

One process generation owns one session/occurrence/lease. A successful leave
requires a readable tree positively lacking any matching meeting window;
duplicates and unreadable trees never prove absence. Possible containers
(`AXWindow`, `AXSheet`, `AXDialog`, and pre-leave matched container roles,
including ambiguous matches) must expose readable nonempty identifiers;
when meeting-window title fallbacks are configured, their titles must also be
readable. Missing/malformed locator attributes leave departure unconfirmed.
Unrelated leaf attributes and unused title/value channels are not requirements.
Release is terminal for new commands; exact cached replays remain answerable until the controller closes
stdin. No unrelated session can reuse that process. EOF/SIGTERM/SIGINT
reap the input worker, stop polling and attempt one bounded **recorded** leave
if joining may have occurred. Cleanup has two at-most 1-second transition waits,
plus bounded native reads/call timeouts; stdout stalls fail after 1 second.
Normal AX reads cap at 2 seconds plus the last bounded native attribute batch;
each native call is capped by `axCallTimeoutMs` (10–250ms).
If the input worker cannot be reaped within one second, no new UI cleanup may
overlap it: the owner/evidence close, the original failure is retained, and the
operator-cleanup-required diagnostic reports departure as unconfirmed.

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
application-level custody integration is described below. Never
silently recycle a still-joined desktop client just because a new lease exists.

### Owned child and durable custody (Task 11c)

The TypeScript application now accepts explicit `bridgeSlots` and a pure
`bridgeIdFor` selector; `createSession` is async. It mints generation/session IDs,
claims migration019 custody durably, then invokes `slot.launch(binding)`.
`createChildBridgeSlot` supplies the actual local process adapter: absolute
executable/static-config paths, optional bounded argv (no shell), a private0700
temporary directory and create-new0600 config/v2. The operator's config/v1 is
never modified. Only HOME/USER/LOGNAME/PATH/TMPDIR/LANG/LC_ALL/LC_CTYPE are copied
to the child; no provider keys, credential references, NODE_OPTIONS or DYLD_*
variables are inherited. Temporary configuration is removed only after reap.

Config/v2 requires the exact claimed `custody` binding and inherited descriptor3.
It rejects inspection mode and validates the dedicated writer before native
backend construction. That pipe emits one bounded private outcome, independently
of cancelled stdout, then EOF. See [the normative contract](../../docs/bridge-process-outcome-v1.md).
Config/v1 remains manual control-only and cannot satisfy application custody.
Before any join value write/press, a readable complete tree must exclude a
possible active meeting; unknown/malformed candidate-window locators fail closed.

Shutdown closes stdin, waits10s cooperatively (configurable1–30s), then allows
SIGTERM1s and SIGKILL/reap2s, using monotonic deadlines. It never kills Feishu or
a process it did not spawn. Output is bounded; queued sends are settled on close.
Application close starts child cleanup alongside session disposal, including
pending launch/construction failures, and waits for custody persistence before
closing its owned store. Only one exact valid outcome plus EOF and successful
cooperative owned reap may clear custody. An ordinary nonsignal nonzero exit is
retained separately as `exitDiagnostic: "nonzero_exit"`: it neither proves nor
vetoes departure. Signal/forced/protocol/cleanup/reap failures still quarantine.
Public left/lease expiry/exit never suffice.

After a parent crash loses confirmation, the slot remains quarantined. A human
must first stop the old controller/owned bridge generation so it cannot issue
future actions, then inspect that exact client; these commands never perform inspection:

```sh
node dist/src/operator.js physical-client-status --db /absolute/orchestration.db
node dist/src/operator.js physical-client-clear --db /absolute/orchestration.db --slot CONFIGURED_SLOT --generation EXACT_32_LOWERHEX --operator OPERATOR_LABEL --assert-inspected-idle
```

Clear is an audited exact-generation CAS; no wildcard/TTL/startup clear exists.
Stable slot labels identify provisioned clients/accounts, not PID or build.
Renaming one is an audited provisioning action, never a recovery shortcut.
Other configured slots continue independently. All automated proof uses temporary
SQLite DBs and synthetic children/native backends, not the desktop. That
application factory still selects config2: media remains unavailable through
it. Config3 executable composition is separate; this is not full-meeting acceptance.

## Independent native audio primitives (Task 11b)

`SystemAudioCapture` is lazy. An authorized caller must supply exact display ID,
PID, bundle path/ID/build and launch date. Start checks existing Screen Recording
access without prompting and uses the app-including ScreenCaptureKit filter,
audio-only output and exclusion of this process. No default/all-system fallback.
Do not invoke native start for a dry run. Config1/2 remain control-only.

Accepted source PCM is Float32 or signed16LE, mono/stereo, planar/interleaved,
at 24/44.1/48 kHz. Stereo is averaged, nonfinite floats rejected, and persistent
`AVAudioConverter` normal priming produces saturating mono s16LE/24 kHz.
Packets contain 480 actual samples; final 1–479-sample tails are not padded.
Native inputs are bounded to 8192 frames/65536 bytes; input queue to 8 buffers
and 250 ms; output to 10 packets/200 ms plus one reserved loss marker. Ledger
and packet source maps are bounded to 64 entries. An unrepresentable second gap
fails explicitly instead of silently asserting complete coverage.

Capture PTS and represented end are converted through the same stream clock to
CoreMedia host time before queueing. Callback arrival is not the origin. Exact
rational source positions and source-buffer endpoints remain available. Packet
host spans, when justified, are **piecewise nominal estimates**, not physical
precision claims; source/filter support envelopes are different types and must
not become packet endpoints. Physical uncertainty is always nil, never zero.
Invalid clock/duration, filter edges or implausible native primeInfo preserve
valid PCM but leave packet host timing absent. Same-rate 24 kHz primeInfo has
returned out-of-bounds values in CPU tests; no zero-priming guess is made.
Source discontinuity, drop and logical suspend/resume close the epoch.
`suspendCapture` discards incoming samples and emits an unknown-duration gap;
`resumeCapture` requires that boundary to be queued. It does not stop the stream.
After sink backpressure, the consumer explicitly calls `resumeDelivery`.

`AudioOutputRenderer` resolves only the configured output UID, rejects unknown
devices and sets/read-backs the engine output unit's device before starting.
It never changes global defaults, Feishu input or a virtual-driver route. The
source remains mono24k even if the hardware mixer converts it. Ten pending
packets plus two scheduled packets (at most40 ms natively) are retained. Only
`dataPlayedBack` returns credit; duplicate/out-of-order/old callbacks cannot
refill a generation. `cancel` advances generation and calls player.stop to
unschedule buffers; explicit `resume(generation:)` follows confirmed flush.
`stop` also stops/resets the engine. A failure/timeout cannot authorize resume.

Start/stop budgets default to5 seconds and must be positive, finite and <=30.
One instance owns one native lifecycle. Timeout returns `failedUnconfirmed`,
not proof of stopped hardware; late ownership is fenced and cleanup retained.
Keep the owner alive until cleanup is resolved and quarantine unconfirmed native
ownership. A blocked OS call cannot be forcibly terminated safely by this port.
Stop drains bounded accepted capture output; a blocked consumer must resume it
or receive an unconfirmed outcome. Failure also remains in `failure` if a sink
cannot accept the terminal marker. No payload/evidence/audio file is written.

The older `AudioBridge` still has receipt-clock timing and void device-cancel
limitations. New isolated primitive proofs do not fix that old integration.
The separate config3 media2 path consumes the accepted Runtime timing
contract and awaits confirmed native flush before acknowledging cancellation.
No local playback result proves remote audibility, duplex/echo quality or the
300 ms acoustic stop target. No output UID or BlackHole route was selected here.

## Timed media and periodic UI evidence (Task 11d)

Config3 uses [bridge-session/v2](../../protocols/bridge-session-v2.schema.json),
not a reinterpretation of frozen v1. Keep every config2 field (including exact
custody binding/descriptor3) and change/add only:

```json
{
  "schema": "feishu-bridge-config/v3",
  "audio": { "captureDisplayId": 42, "outputDeviceUid": "OPERATOR_SELECTED_UID" }
}
```

This fragment is not a complete config. Display ID must be1..UInt32max; UID is
1..512UTF8 bytes without NUL. Both must name deliberately provisioned resources;
there is no automatic route/BlackHole choice, device enumeration command, prompt
or fallback. Config3 rejects inspection mode. Use explicit config1 inspection
only after human permission. Config3 polls actual AX snapshots every250ms;
legacy observationIntervalMs remains required but does not change that cadence.

The byte-identical [Runtime fixture mirror](../../fixtures/runtime-4c97c47/SOURCE.md)
pins accepted `4c97c47c9cb044728413516c48aa86534e58523b`. `connect_media` carries
the exact timed lease with separate Runtime source session and bridge session.
Decimal u64 strings never pass through JavaScript Number. Every initial/retry
socket must consume matching MED2 kind9 confirmation within the shared2s
open/auth-write/ACK deadline BEFORE renderer, clock pairs or capture starts.
Local write success is not authentication. TLS uses normal system trust;
plaintext is limited to literal127.0.0.1/::1 endpoints with explicit ports.
Credentials are structurally removed before command evidence; no PCM goes to
JSONL/stdout/stderr. The media socket goes directly to Runtime, never through Node.

Capture retains native source PTS→stream synchronization clock→CMhost mapping,
480-sample packets and real short tails. Authenticated epoch precedes frames;
one process-random clock domain is shared with AX brackets. Clock pairs bracket
actual CLOCK_REALTIME reads with CMhost, include clock_getres resolution, and
retain unknown external UTC accuracy. Steps, missing mapping, drops and epochs
close coverage; no receipt origin, global interpolation or invented zero error.
Every retained nominal source piece is checked before endpoint-only wire
evidence; support envelopes are never serialized as packet timing.

One capture write is outstanding. One writer serializes it with bounded control
work (at most16 queued writes/69,632 queued bytes, plus active write). Read chunks
cap4096; one playback frame may contain65,536 PCM bytes and is sliced into<=960
byte native packets. Native bounds remain2 scheduled+10 pending; at most12 live
network receipts. Accepted means the LAST slice was admitted; Rendered follows
all ordered actual dataPlayedBack callbacks. Flush fences the expected native
generation, really unschedules, and ACKs only confirmed stop. Old callbacks cannot
acknowledge new work. A directly following flush interrupts partial admission;
another playback header ahead of flush can create TCP/FIFO head-of-line delay.
No acoustic/interrupt-latency bound is claimed. No-played-progress2s checked1s
means up to3s detection PLUS owned cleanup, not instant EOF detection.

Automatic media recovery allows at most3 attempts per outage,100ms apart,
only after positively confirmed native AND socket cleanup. A successful
reconnect resets that count; across outages at most6 attempts fit in any
rolling60s, after which a flapping link ends with `reconnect_exhausted`. Each
outage has one deadline from its first disconnect, capped by reconnectWindowMs
and the credential cutoff; failed startup/cleanup consume it. Only complete new
media readiness ends that outage. Media that stops trying for any of these
reasons, including a deadline that passes during the 100ms backoff, ends with
`reconnect_exhausted`, never silently.

A connected `connect_media` answers `ok` with detail `media_lease_renewal`,
the bridge's advertisement that it understands `renew_media_lease`; an older
bridge answers null and would treat the command as malformed input, so it must
never be sent one. `renew_media_lease` (`leaseRenewal: {sessionId,
expiresAtMs}`, decimal u64 strings) tells the bridge the Runtime extended the SAME credential. The bridge
re-anchors its credential cutoff on the monotonic clock and moves it forward
only; an outage in progress uses the new cutoff from its next attempt. The
running cycle, capture and the encrypted recording it feeds are never touched.
Answers, in this order of checks: `ok` (later, or equal and still live, expiry); `rejected` with `media_not_connected`
(no running lease, including after media gave up), `media_session_mismatch`,
`lease_expiry_regressed` or `lease_expired`; `failed` with
`media_renewal_unavailable`. A malformed renewal is a protocol error, like any
malformed command; a wrong bridge session is an ownership conflict. Reconnect authenticates again, emits reason3 barrier/new capture
epoch, and preserves process clock/pair sequence and128metadata-records/s budget.
Unconfirmed cleanup is terminal. Static media_disconnected reasons preserve
`capture_delivery_interrupted`/`final_clock_pair_undelivered`; positively confirmed
resource cleanup is not a delivery claim or meeting departure.

EOF/stop owns one TOTAL20s media-close budget: maintenance write2s + capture
stop/tail5s + remaining delivery2s + final pair2s + renderer stop5s + socket
close1s =17s, with3s owner margin. Native phase budgets>5s are refused before
start. Socket/task reap is awaited; expired/unconfirmed cleanup cannot succeed.
Later application config3 composition must explicitly select/test cooperative
grace within the existing30s maximum that ALSO covers bounded UI/evidence/private
outcome cleanup. Current config2 default10s is not sufficient for this worst case
and is unchanged; the config3 application factory is not implemented here.

Every actual UI snapshot, including unchanged state, emits ordered ui_snapshot
with one same-domain host bracket (or explicit timing_unavailable), identity
state, and barriers for missing/overlong/regressed/>2s-gap observations. Consumers
may claim UI-OBSERVED coverage only through the latest valid watermark, never
physical continuity or indefinite held identity. Startup/repeated highlight is
not a new activation. Native identity/highlight capabilities remain unknown until
measured; AX selected/focused is not substituted. Future evidence composition
must require stable unique UI coverage over the WHOLE touched audio frame if no
exact interior source map exists. No live attribution/store ingestion is added here.

Human acceptance still requires measured build/locale/identity/highlight selectors,
explicit client account and permissions, selected output route and actual duplex,
echo/leakage/latency testing. Synthetic CPU/socket proof does not establish any
of those or a runnable end-to-end Meeting application.

## Permissions

Running `swift test` needs nothing: no Feishu app, no Accessibility, Screen
Recording or Microphone grant, no audio hardware, no external network, no API keys.
Tests create bounded owned localhost TCP peers. That
is the point of keeping the driver, the device and the media endpoint behind
protocols. Native framework implementations are compiled but never started by
tests; AVAudioConverter alone executes CPU-only synthetic conversion.

Driving a real client will need the macOS **Accessibility** permission (to read
element state and perform actions) and appropriate audio permissions.
ScreenCaptureKit audio capture additionally
requires **Screen Recording** permission; Accessibility alone does not grant
audio capture. Nothing in this executable requests those grants
or changes audio routes. OCR is not implemented or authorized here.

## Dependencies

None. No external Swift package is fetched, on purpose: this must build offline,
and a bridge that reads a live meeting UI is a poor place for third-party code.

## Tests

```
swift test
```
