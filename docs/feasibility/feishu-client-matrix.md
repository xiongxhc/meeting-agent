# Feishu Mac client — control feasibility matrix

**Nothing in this file has been measured yet.** Every measurement cell below is
empty on purpose. The Mac bridge (`bridges/mac/`) has been built and unit-tested
against synthetic accessibility trees only; it has never been run against a real
Feishu client, a real tenant, or a real meeting. This page records what a human
will measure, and claims nothing until they do.

Filling it in is a human-gated step. The exact procedure, the commands, and the
evidence to capture are in `docs/HUMAN-CHECKLIST.md`, section
**Plan 1 Task 3** for the control rows and section **Plan 1 Task 4** for the
duplex media rows. Fill a row only from a run you actually performed.

The rows below feed the Swift-versus-Rust decision for the Mac bridge, whose
seven criteria, measurement procedure, and unfilled decision block live in
`docs/feasibility/mac-bridge-decision.md` (Task 5; procedure in
`docs/HUMAN-CHECKLIST.md` section **Plan 1 Task 5**). That file makes no
decision either — it is a template, same as this one.

## Result vocabulary

| Result | Means |
|---|---|
| `proven` | Four consecutive runs of this path completed with no wrong meeting, no wrong participant, no duplicate disclosure, and no guessed speaker. |
| `unreliable` | The path worked at least once but failed, needed a retry, or produced a wrong or ambiguous outcome within four consecutive runs. |
| `unavailable` | The control the path depends on could not be reached at all on this client build — for the disclosure row this is the expected, acceptable outcome, and it never blocks joining. |
| `not tested` | No run has been performed. Every row starts here. |

## Join paths

| # | Path | Feishu client version | macOS version | Permissions granted | Consecutive clean runs (of 4) | Result | Redacted evidence hash | Measured on |
|---|---|---|---|---|---|---|---|---|
| 1 | Direct invite | | | | | | | |
| 2 | Calendar invite | | | | | | | |
| 3 | Waiting-room admission | | | | | | | |
| 4 | Host transfer | | | | | | | |
| 5 | Reconnect after force-closing the bridge | | | | | | | |

## Meeting-chat disclosure

| Path | Feishu client version | macOS version | Permissions granted | Attempts (must be 1 per occurrence) | Result | Redacted evidence hash | Measured on |
|---|---|---|---|---|---|---|---|
| Typed disclosure into meeting chat | | | | | | | |

## Duplex media and timing

The media bridge connects to the Conversation Runtime's data plane itself, so
every figure below is a property of that direct path. If a run ever routes a
frame through the TypeScript coordinator it is void, not slow: the architecture
under test is the one where Node.js is never in the frame path.

**Count gaps, not events.** A playback gap is written as two `audio_gap`
records — an opening one with a null `endedAt`, and a closing one carrying the
same `startedAt` once the end was observed — while a capture gap is written as
one, already closed. Grepping for `audio_gap` lines therefore overcounts, and
grepping for `"endedAt":null` overcounts the gaps that were never closed. Every
gap figure below is a count of **distinct gaps keyed by `direction` plus
`startedAt`**; section 4.2 of the checklist carries a command that does the
keying.

Procedure and commands: `docs/HUMAN-CHECKLIST.md` section **Plan 1 Task 4**.
The pass condition for this whole block is that task's Gate — reliable full
duplex, no feedback loop, interruption stop at or below 300 ms, and a complete
timestamped hour-long capture evidence file. The result vocabulary above reads
the same way here, against that Gate rather than against the four-join one:
`proven` means the row met the Gate on a run actually performed, `unreliable`
means it worked but missed the Gate or needed a retry, `unavailable` means the
capability could not be reached on this client build at all, and `not tested` is
where every row starts. Every measurement cell below is empty because no
measurement exists.

| Capability | What is measured | Feishu client version | macOS version | Permissions granted | Negotiated format | Measured value | Result | Redacted evidence hash | Measured on |
|---|---|---|---|---|---|---|---|---|---|
| Capture — meeting audio reaches the media endpoint | Capture latency, ten runs: min / median / max | | | | | | | | |
| Playback — synthesized audio is injected as the agent microphone | Playback latency, ten runs: min / median / max | | | | | | | | |
| Full duplex — capture and playback at once | Whether both held together for the hour-long run | | | | | | | | |
| Echo and feedback, second participant on headphones | Whether the returned tone re-entered capture, and whether a loop built | | | | | | | | |
| Echo and feedback, second participant on open speakers | Whether the returned tone re-entered capture, and whether a loop built | | | | | | | | |
| Interruption (barge-in) stop time | Interrupt to last rendered frame, ten runs: min / median / max, against the 300 ms Gate | | | | | | | | |
| One-hour two-participant run | Duration from the evidence file's own first and last record | | | | | | | | |
| Unexplained audio gaps in that run | Count of distinct gaps (keyed by `direction` + `startedAt`) that could not be tied to something observed; the Gate needs zero | | | | | | | | |
| Provoked OS/client interruptions | Interruptions provoked versus distinct gaps observed; the two counts must match | | | | | | | | |
| Gaps whose end was never observed | Count of distinct gaps for which no closing event exists, and what each one was | | | | | | | | |

## Reconnect

| Path | Feishu client version | macOS version | Permissions granted | Consecutive clean runs (of 4) | Result | Redacted evidence hash | Measured on |
|---|---|---|---|---|---|---|---|
| Media reconnect after a network drop (bridge stays up) | | | | | | | |

## Participant and speaker identity

Whether a roster row or a speaker tile exposes anything resolvable to a Feishu
user id without OCR or a directory lookup. If it does not, `active_speaker`
never reaches `ui_exact` and `participant_joined` cannot be emitted at all — so
this row gates both halves of the task. Procedure: `docs/HUMAN-CHECKLIST.md`
section 3.0b. Record attribute names only, never a real handle.

| What was inspected | Attribute that carries an identity | Stable across a rejoin | Feishu client version | macOS version | Result | Measured on |
|---|---|---|---|---|---|---|
| Roster row | | | | | | |
| Speaker tile | | | | | | |

## agent-box standalone (Task 6)

Whether the Feishu web client, driven standalone on agent-box with no Mac
bridge involved, can support the eight capabilities below. **Every result
cell in this section is `not tested`, and that is the truthful current
state, not a placeholder awaiting a better answer.** Task 6's own unit tests
(`bridges/linux-browser/src/probe.ts`, `bridges/linux-browser/test/probe.test.ts`)
exercise the meeting-discovery and failure-classification *logic* against
recorded, synthetic DOM fixtures only — no real browser, no real Feishu web
client, no network, and no agent-box access. That logic has never been run
against a real page, so nothing here claims a measurement of the real thing.

Running it for real needs an isolated agent-box test session and a real
Feishu web client login; the exact procedure is
`docs/HUMAN-CHECKLIST.md`, section **Plan 1 Task 6**. Fill a row only from a
run actually performed.

Each result is one of the same four words used throughout this file
(`proven`, `unreliable`, `unavailable`, `not tested` — see Result vocabulary
above), reached the same way `bridges/linux-browser/src/probe.ts` reaches
it: `not tested` for a capability never attempted, `unavailable` only for one
the human genuinely could not reach (never merely never looked at),
`unreliable` for one that worked at least once but not consistently, and
`proven` for one that worked every time it was attempted.

| Capability | What a human would check | Feishu web client version | Browser + version | Evidence hash | Result | Measured on |
|---|---|---|---|---|---|---|
| Authentication persistence | Whether a logged-in session survives a page reload / process restart without re-prompting | | | | not tested | |
| Meeting join | Whether the web client can join a real meeting and the join is observable in the DOM | | | | not tested | |
| Actual participants | Whether the roster reflects who is actually in the meeting | | | | not tested | |
| Active speaker | Whether an active-speaker indicator is present and resolvable to a participant | | | | not tested | |
| Microphone input | Whether the browser can capture real microphone audio into the meeting | | | | not tested | |
| Speaker output | Whether the browser can play received meeting audio out | | | | not tested | |
| Chat | Whether the meeting-chat control can be found and used for the disclosure text | | | | not tested | |
| Reconnect | Whether the web client recovers after a network drop without a full manual rejoin | | | | not tested | |

**Standalone verdict:** _(unset — see the rule below)_

If a human run finds that raw media (microphone input or speaker output) or
UI observation (any of the other six rows) is unavailable on agent-box, the
verdict for **agent-box standalone** is `deferred` — a fifth, profile-level
word that is not part of the per-capability vocabulary above and is never
written into a capability's own Result cell. `deferred` must not block the
recommended coordinator-plus-Mac profile: agent-box standalone is one
candidate profile among others, and this matrix's Mac bridge sections above
are what that recommended profile depends on, not this section.

## Column rules

- **Feishu client version** — the exact build string from the client's About
  panel, not "latest".
- **macOS version** — `sw_vers -productVersion` plus the build, e.g. `26.0 (25A000)`.
- **Permissions granted** — which of Accessibility / Screen Recording /
  Microphone were on for the bridge process during the run. Note any that were
  granted but unused. The media rows need Microphone; nothing in this package
  has ever requested it.
- **What is measured** — fixed per row; it is there so a filled cell cannot be
  read as the wrong quantity. Do not reword it to fit a number you have.
- **Negotiated format** — the exact string the bridge and the endpoint agreed
  on, in the `connect_media` wire form, e.g. `pcm_s16le/48000/1/20ms`. A run at
  a format the coordinator did not offer is a defect, not a measurement.
- **Measured value** — the figure the row's "What is measured" column names,
  with its unit, from a run actually performed. A latency row also needs the
  jitter buffer bound in force during the run (the bridge's default is 200 ms
  and it is a constructor parameter), because the figure is not comparable
  without it. A gap row likewise needs the capture gap tolerance in force
  (default two frame durations, also a constructor parameter): a tighter
  tolerance manufactures gaps, so a gap count without it says nothing. Leave the cell empty rather than estimating, and never carry a
  number over from a different configuration.
- **Consecutive clean runs** — how many consecutive runs of this path completed
  with no wrong meeting, no wrong participant, no duplicate disclosure, and no
  guessed speaker. The gate is four; a run that fails resets the count to zero.
- **Result** — one word from the vocabulary above.
- **Redacted evidence hash** — `shasum -a 256` of the recorded JSONL evidence
  file *after* redaction. The evidence file itself is not committed: it holds
  real meeting ids and real participant ids. Only the hash goes in this table.
- **Measured on** — the UTC date of the run.

## What must never appear in this file

Real meeting numbers, real occurrence ids, real Feishu user ids, real display
names, tenant names, screenshots, audio, or transcripts. This file is committed
to a public repository. If a cell would need one of those to be meaningful,
record the hash of the redacted evidence instead and keep the evidence out of
the repository.

## Prerequisite: the accessibility identifiers are placeholders

`bridges/mac/Sources/FeishuBridgeSpike/LocalizedLabels.swift` is the one file
holding every accessibility identifier and localized title the adapter looks
for. None of those values was captured from a real client — they are
placeholders, and the unit tests exercise the *locating strategy*, not the
values. Capturing the real ones is the first human-gated step of Plan 1 Task 3
and must happen before any row below can be filled.
