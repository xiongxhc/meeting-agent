# Human checklist

Steps that need a human (real accounts, live services, or repo hosting
decisions) and were deliberately not attempted by the agent. Grouped by plan
task.

## Plan 1 Task 0: Bootstrap the public package

- [ ] Create the GitHub repository `xiongxhc/meeting-agent`. The local `origin`
  remote is already configured to `git@github.com:xiongxhc/meeting-agent.git`,
  but the repository itself does not exist on GitHub yet. Run:

  ```
  gh repo create xiongxhc/meeting-agent --public --description "Meeting Agent: reusable meeting engine"
  ```

  Do not pass `--source`/`--remote` to that command since `origin` is already
  set locally. Then push the branch:

  ```
  git push -u origin feat/meeting-agent-core
  ```

## Plan 1 Task 3: Prove Mac join, participant, and chat control

The task's six bullets split in two. Bullets 1-3 (write unit tests against fake
accessibility trees; implement the smallest adapter with localized labels in one
mapping file; run `swift test` and the protocol replay tests) are done in code —
see `bridges/mac/` and the Task 3 report. Bullets 4-6 need a real Feishu test
tenant, five real meeting joins, a real typed disclosure, and real client and OS
versions. They were not attempted and not simulated, and nothing has been
written into `docs/feasibility/feishu-client-matrix.md` that claims a
measurement. They are below.

**Pass condition for every item in this section** (the task's Gate, verbatim):

> Mac control passes at least four consecutive runs of each supported join path
> without a wrong meeting, wrong participant, duplicate disclosure, or guessed
> speaker.

### 3.0 Prerequisites — bullets 4-6 cannot start until all three are done

The Mac package as committed cannot drive a real client. Three things are
missing, and **no task in this plan creates them**: Task 4 adds audio, Task 5
scores the language choice, Task 6 is the Linux probe, Task 7 publishes the
verdict. They are unowned work that has to be scheduled before 3.1 can be
attempted.

1. **Real labels.** Every identifier and localized title in
   `bridges/mac/Sources/FeishuBridgeSpike/LocalizedLabels.swift` is a
   placeholder; none was captured from a real client. See 3.0a below.
2. **An `AXUIElement`-backed `AccessibilityDriver`.** The package ships the
   protocol only, and it carries a timing contract that a real implementation
   must honour: `snapshot(waitingUpTo:)` must keep re-reading until the tree
   changes or the deadline elapses, and must not return a stale tree
   immediately. `FeishuClientAdapter` waits 60s after pressing join (the
   waiting-room path takes as long as the host takes to admit) and 5s after a
   within-meeting press; both are constructor parameters. A driver that ignores
   the deadline will report `meeting_window_not_observed` on nearly every real
   join.
3. **A real `UiIdentityResolver`, and the finding of whether one is even
   possible.** The package ships the protocol only; the sole implementation is
   a fake in the test target. See 3.0b — this is a feasibility question, not
   just an implementation gap.
4. **A runnable entry point.** `bridges/mac/Package.swift` declares a library
   and a test target, no executable, so there is nothing to launch. Whoever
   builds items 2 and 3 must also add the executable target that wires an
   adapter, an observer, a reducer, and a `BridgeRecorder` together and writes
   the JSONL evidence file that 3.1 and 3.2 ask for.

#### 3.0a Capture the real accessibility identifiers

Grant the Accessibility permission to whatever process will drive the client
(System Settings > Privacy & Security > Accessibility), open Feishu, join a
throwaway meeting in the test tenant, then dump the tree with Xcode's
Accessibility Inspector:

```
open -a "Accessibility Inspector"
```

Record, for each control the adapter looks for (`joinMeetingNumberField`,
`joinButton`, `meetingWindow`, `meetingNumberLabel`, `leaveButton`,
`leaveConfirmButton`, `chatToggle`, `chatInput`, `chatSendButton`,
`participantsPanel`, `participantRowPrefix`, `speakerGrid`,
`speakerTilePrefix`): its `AXIdentifier`, its `AXRole`, and its `AXTitle` in
both display languages the tenant uses. Then replace the placeholders in
`LocalizedLabels.swift` — that one file, no other — and re-run:

```
cd bridges/mac && swift test
```

**Evidence to record:** the client build string, the macOS version, and which
controls exposed a stable `AXIdentifier` versus which are reachable only by
localized title. A control reachable only by title is a standing fragility;
note it. Also note whether the client shows a positive "meeting has ended"
notice: the observer claims an end from that notice if it exists, and otherwise
only after three consecutive frames in which no meeting window could be located
at all. Do not paste a full tree dump into the repository — it will contain
real participant names.

#### 3.0b Establish whether a participant identity is resolvable at all

Open the same throwaway meeting and inspect one roster row and one speaker tile.
The question: **does either expose anything that can be resolved to a Feishu
user id without OCR and without a directory lookup?** An `AXIdentifier` carrying
an opaque per-participant handle, an `AXValue`, a help tag — anything stable and
per-person.

This is a feasibility result, not an implementation detail, and it gates both
halves of this task. If the answer is no, `active_speaker` can never reach
`ui_exact` and every speaker observation stays `ambiguous`, and
`participant_joined` cannot be emitted at all because the contract requires a
non-empty `feishuUserId`. Two participants with the same display name would also
be indistinguishable.

**Evidence to record:** what the roster row and the speaker tile expose, whether
it is stable across a rejoin, and the resulting one-word verdict in the
**Participant and speaker identity** row of
`docs/feasibility/feishu-client-matrix.md`. Record the attribute names only —
never a real handle, since a per-participant handle identifies a real person.

### 3.1 Brief bullet 4 — five real joins in a test tenant

Verbatim from the brief:

> In a test tenant, execute five real joins: direct invite, calendar invite,
> waiting-room admission, host transfer, and reconnect after force-closing the
> bridge.

Run each of the five paths four consecutive times (the Gate is four consecutive
clean runs per path). For each run, from the repo root:

```
sw_vers -productVersion && sw_vers -buildVersion
cd bridges/mac && swift test          # confirm the bridge is green before the run
```

Then drive the join for that path, using the entry point built in 3.0, and
record the bridge's JSONL evidence to a file **outside this repository** (it
will contain real meeting and participant ids). Note the deadlines the adapter
was constructed with — the default 60s join deadline is what makes the
waiting-room path viable, and a run that failed because the deadline was too
short is a configuration result, not a `not tested`:

```
mkdir -p ~/meeting-agent-evidence
# write the run's recorder output to, e.g.:
#   ~/meeting-agent-evidence/task3-<path>-<run>.jsonl
shasum -a 256 ~/meeting-agent-evidence/task3-<path>-<run>.jsonl
```

**Evidence to record**, per path, in `docs/feasibility/feishu-client-matrix.md`:
Feishu client version, macOS version and build, which permissions were granted,
how many consecutive runs were clean, the one-word result, the `shasum -a 256`
of the redacted evidence file, and the UTC date. A run counts as clean only if
it had no wrong meeting, no wrong participant, no duplicate disclosure, and no
guessed speaker. A failure resets that path's consecutive count to zero.

### 3.2 Brief bullet 5 — the typed disclosure, once per occurrence

Verbatim from the brief:

> Attempt the typed disclosure exactly once per occurrence. Record `unavailable`
> rather than speaking if the chat control is not reliably reachable.

The disclosure is meeting-chat text only. There is no speech path in
`bridges/mac/` and none is to be added: if the chat control cannot be reached,
the correct outcome is `unavailable`, and failing to disclose never blocks
joining. `FeishuClientAdapter.postDisclosureOnce` refuses a second attempt for
the life of the adapter, so confirm that a fresh adapter is used per occurrence
and never per retry.

During each of the runs in 3.1, confirm in the meeting chat that exactly one
disclosure message appears, and confirm the evidence carries exactly one
`chat_disclosure` event:

```
grep -c '"type":"chat_disclosure"' ~/meeting-agent-evidence/task3-<path>-<run>.jsonl
```

**Evidence to record:** that count (it must be `1`), the `outcome` value the
event carried (`sent`, `unavailable`, or `failed`), and whether the chat control
was reachable on that client build. Put the result in the disclosure row of
`docs/feasibility/feishu-client-matrix.md`. Do not paste the chat text or any
screenshot of the meeting.

### 3.3 Brief bullet 6 — fill the client matrix

Verbatim from the brief:

> Record client version, macOS version, permissions, result, and redacted
> evidence hash in `docs/feasibility/feishu-client-matrix.md`.

The file exists with an empty grid and a legend; fill it only from runs actually
performed in 3.1 and 3.2.

```
# client version: Feishu > About (copy the exact build string)
sw_vers -productVersion && sw_vers -buildVersion
shasum -a 256 ~/meeting-agent-evidence/task3-<path>-<run>.jsonl
```

**Evidence to record:** one row per join path plus the disclosure and reconnect
rows, each with client version, macOS version and build, permissions granted,
consecutive clean runs, a one-word result from the legend (`proven`,
`unreliable`, `unavailable`, `not tested`), the redacted evidence hash, and the
UTC date. No real meeting numbers, occurrence ids, user ids, display names,
tenant names, screenshots, audio, or transcripts go in that file — it is
committed to a public repository.

## Plan 1 Task 4: Prove direct duplex media and timing

The task's five bullets split in two. Bullets 1-3 (unit-test format
negotiation, monotonic frame timestamps, a bounded jitter buffer, capture and
playback gap events, mute state and immediate playback cancellation; prove with
a fake media endpoint that frames travel directly between the bridge and the
Rust endpoint with no Node.js process in the frame path; run `swift test`) are
done in code — see `bridges/mac/Sources/FeishuBridgeSpike/AudioBridge.swift`,
`LoopbackMediaClient.swift`, and the Task 4 report. Bullets 4-5 need a real
Feishu test meeting, a real calibration phrase, a returned tone, real latency
and interruption measurements, and a one-hour two-participant run. They were
not attempted and not simulated. **No latency, echo, or stop-time number exists
anywhere in this repository**, and no row of
`docs/feasibility/feishu-client-matrix.md` claims one. They are below.

**Pass condition for every item in this section** (the task's Gate, verbatim):

> Reliable full duplex, no feedback loop, interruption stop at or below 300 ms,
> and a complete timestamped hour-long capture evidence file.

### 4.0 Prerequisites — bullets 4-5 cannot start until all four are done

Everything in section 3.0 still applies (real labels, a real
`AccessibilityDriver`, a real `UiIdentityResolver`, a runnable entry point):
without a real join there is no meeting to carry audio. Media adds four more,
and **no task in this plan creates them**:

1. **A real `MediaEndpointClient`.** The package ships the protocol and
   `LoopbackMediaClient`, an in-process stand-in that echoes frames back. A real
   run needs the client that dials the endpoint `connect_media` carries and
   speaks the Rust Conversation Runtime's data-plane transport. The whole point
   of the task is that this connection is made by the bridge itself: if a run
   ever routes a frame through the TypeScript coordinator, the run is void and
   the architecture claim has been broken, not measured.
2. **A real `AudioDevicePort`.** The package ships the protocol and a fake. A
   real one wraps the macOS capture and render units, publishes the formats the
   machine can actually carry in `supportedFormats`, drives `captureFrame` from
   the capture callback and `renderTick` from the render callback. It needs the
   **Microphone** permission, which nothing in this package has ever requested.
3. **A real `MediaClock`.** `monotonicMilliseconds()` must come from a source
   that cannot go backwards (`mach_absolute_time`, not `Date`). The bridge fails
   the session with `media_clock_regressed` if it ever does, so a clock wired to
   the wall clock will drop the media session on the first NTP correction.
4. **A capture evidence writer.** The Gate asks for "a complete timestamped
   hour-long capture evidence file". `BridgeRecorder` already writes the
   `bridge-session/v1` event stream as timestamped JSONL and is what should
   produce it. **It must record events only.** Plaintext audio never touches
   disk and the bridge never writes audio at all — the encrypted recording is
   the Conversation Runtime's job, from its own media path, and the Meeting
   Agent never holds the recording key.

5. **A capture gap tolerance chosen for the run.**
   `AudioBridge(captureGapToleranceMilliseconds:)` decides how long capture may
   go quiet before the bridge calls it an `audio_gap`. It defaults to two frame
   durations — 40 ms at a 20 ms format — which is tight enough that ordinary
   scheduling on a real machine will trip it, and 4.2 fails the run on a gap
   nobody can explain. Pick a value deliberately before the hour-long run,
   record it, and read the resulting gap count against it. Changing it
   mid-programme invalidates comparison between runs; if you change it, say so
   and re-run.

Confirm the bridge is green before any run below:

```
cd bridges/mac && swift test
```

### 4.1 Brief bullet 4 — calibration phrase, returned tone, and the four measurements

Verbatim from the brief:

> In the real test meeting, inject a timestamped calibration phrase and return a
> timestamped tone. Measure capture latency, playback latency, echo/feedback
> behavior, and interruption stop time.

Run this in the test tenant, with two machines, and with the second participant
wearing headphones for the first pass and using open speakers for the echo pass.
Use a synthetic calibration phrase and a synthetic tone — no real meeting
content, and nothing that identifies a person.

**Step 1 — one shared time base.** Every timestamp compared below must come from
one monotonic source or from two sources whose offset was measured. Record the
offset before the meeting and again after it:

```
sntp time.apple.com   # queries only: note the reported offset, never step the clock mid-run
python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat())'
```

Run the second command on both machines back to back. (`date` on macOS is BSD
`date` and has no sub-second format, which is why this reads the clock through
`python3` instead.)

**Step 2 — capture latency.** Play a calibration phrase into the meeting from
the second participant's machine at a recorded instant `t_spoken`. Record the
instant `t_captured` at which the frame carrying its onset reached the media
endpoint (the endpoint side, not the bridge side — the measurement is of the
whole path the frame actually travels). Capture latency is
`t_captured - t_spoken`. Repeat ten times and record min, median, and max.

**Evidence to record:** the ten deltas, the frame's
`timestampMilliseconds` on the bridge side, the negotiated format string, and
the clock offset from step 1.

**Step 3 — playback latency.** Have the endpoint return a timestamped tone at a
recorded instant `t_sent`. Record the instant `t_heard` at which the tone was
observed in the meeting on the second participant's machine. Playback latency is
`t_heard - t_sent`. Repeat ten times; record min, median, max.

**Evidence to record:** the ten deltas, plus the buffer depth in force — the
bridge's jitter buffer bound defaults to 200 ms, which is a constructor
parameter (`AudioBridge(jitterBufferMilliseconds:)`) and is part of the
measurement, not a constant of nature. If a run needed a different bound, that
is a result; record the value used.

**Step 4 — echo and feedback.** Repeat steps 2 and 3 twice: once with the
second participant on headphones, once on open speakers with the agent machine's
own output audible to its own input. Record whether the agent's returned tone
re-entered capture, and whether any feedback loop built up. A feedback loop on
open speakers is a real finding, not a test error — the Gate says "no feedback
loop", so record which configurations satisfy it and which do not.

**Evidence to record:** for each configuration, whether the tone re-entered
capture, whether a loop built, and what stopped it if one did.

**Step 5 — interruption stop time.** With the agent speaking, interrupt it, and
record `t_interrupt` (the instant the interruption was raised) and `t_silent`
(the instant the last frame was rendered to the device). Interruption stop time
is `t_silent - t_interrupt`. `AudioBridge.cancelPlayback()` discards the whole
buffer at once and goes on discarding inbound frames until `resumePlayback()`,
so what this measures is the path from the interruption signal to that call plus
one render tick — not buffer drain. Repeat ten times.

**Evidence to record:** the ten stop times, min, median and max, and the count
of frames the bridge reported in `playbackFramesDroppedByCancellation`. The Gate
is **interruption stop at or below 300 ms**; a median under it with a maximum
over it does not pass — record every one of the ten.

### 4.2 Brief bullet 5 — the one-hour two-participant run

Verbatim from the brief:

> Run a one-hour two-participant test. A normal run has no unexplained audio
> gap; every OS/client interruption produces an explicit `audio_gap` event.

One meeting, two participants, sixty unbroken minutes, with the bridge recording
its `bridge-session/v1` event stream to a JSONL file **outside this repository**
(it carries real meeting and participant ids). During the hour, deliberately
provoke at least three OS/client interruptions and note the wall time of each:
switch the input device, put the machine's display to sleep and wake it, and
change the network the media endpoint is reached over.

```
mkdir -p ~/meeting-agent-evidence
# write the run's recorder output to:
#   ~/meeting-agent-evidence/task4-duplex-1h.jsonl
```

**One gap is not one event.** Before counting anything, know how the bridge
writes a gap down, because counting raw `audio_gap` lines will make a correct
run look broken:

- A **playback** gap is written as **two** events: an opening one carrying
  `"endedAt":null` at the moment dropping began, and — only if the end was
  actually observed — a closing one carrying the **same `startedAt`** and a real
  `endedAt`. A playback gap that resolved therefore appears twice.
- A **capture** gap is written as **one** event, already closed. Both of its
  ends were observed by the time it could be reported at all.
- So the ratio of events to gaps is not constant, and three provoked playback
  interruptions that all resolve produce six events. Count **distinct gaps**,
  keyed by `direction` plus `startedAt` — never lines.
- For the same reason, `grep -c '"endedAt":null'` is **not** the count of gaps
  whose end was never observed: every playback gap contributes one such line,
  including the ones that later closed. A gap's end was never observed only if
  **no** event anywhere in the file carries its `startedAt` with a real
  `endedAt`.

Reconcile the file against your notes with this, which does the keying for you:

```
python3 - ~/meeting-agent-evidence/task4-duplex-1h.jsonl <<'GAPS'
import json, sys
gaps = {}
for line in open(sys.argv[1]):
    m = json.loads(line).get("message", {})
    if m.get("type") != "audio_gap":
        continue
    gaps.setdefault((m["direction"], m["startedAt"]), []).append(m["endedAt"])
never_closed = [k for k, e in gaps.items() if all(x is None for x in e)]
print("distinct gaps:", len(gaps))
print("gaps whose end was never observed:", len(never_closed))
for (d, start), ends in sorted(gaps.items()):
    end = next((x for x in ends if x is not None), None)
    print(f"  {d:9} {start} -> {end or 'never observed'}")
GAPS
```

```
head -1 ~/meeting-agent-evidence/task4-duplex-1h.jsonl
tail -1 ~/meeting-agent-evidence/task4-duplex-1h.jsonl
shasum -a 256 ~/meeting-agent-evidence/task4-duplex-1h.jsonl
```

Read the results this way, and do not soften any of them:

- A **distinct gap** you cannot tie to something you observed is an
  **unexplained gap** and fails the run. It is not "probably the network".
- An interruption you provoked that produced **no** gap also fails the run: the
  bridge missed it, which is the worse of the two failures because the evidence
  file then looks clean.
- A gap printed as `never observed` is one the bridge never saw the end of. That
  is a legitimate, deliberate state, not a bug and not a formatting slip. Say
  what each one was.
- A mute and a barge-in produce **no** gap by design — those silences are
  explained, and the bridge drops an open gap at a barge-in rather than closing
  it across the silence. Confirm the file agrees; a gap opening or closing at
  either moment means the bridge is reporting a silence it caused itself.
- "Complete" in the Gate means the first and last record bracket the full hour
  with no missing stretch. Check the first and last `recordedAt` and confirm the
  `sequence` values only ever increase.

**Evidence to record:** the run's duration from the file's own first and last
`recordedAt`, the **distinct gap** count, the count whose end was never
observed, the capture gap tolerance the bridge ran with (see 4.0 item 5 — a gap
count means nothing without it), the three provoked interruptions matched to
their gaps, any unexplained gap, the `shasum -a 256` of the redacted file, and
the UTC date. Put the one-word result
in the media rows of `docs/feasibility/feishu-client-matrix.md`. Do not commit
the evidence file, and never commit audio: plaintext audio never touches disk,
and this repository is public.
