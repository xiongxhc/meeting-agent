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
| Unexplained audio gaps in that run | Count of `audio_gap` events that could not be tied to something observed; the Gate needs zero | | | | | | | | |
| Provoked OS/client interruptions | Interruptions provoked versus `audio_gap` events emitted; the two counts must match | | | | | | | | |
| Gaps whose end was never observed | Count of `audio_gap` events carrying `"endedAt":null`, and what each one was | | | | | | | | |

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
  without it. Leave the cell empty rather than estimating, and never carry a
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
