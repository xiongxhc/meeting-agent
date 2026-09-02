# Feishu Mac client — control feasibility matrix

**Nothing in this file has been measured yet.** Every measurement cell below is
empty on purpose. The Mac bridge (`bridges/mac/`) has been built and unit-tested
against synthetic accessibility trees only; it has never been run against a real
Feishu client, a real tenant, or a real meeting. This page records what a human
will measure, and claims nothing until they do.

Filling it in is a human-gated step. The exact procedure, the commands, and the
evidence to capture are in `docs/HUMAN-CHECKLIST.md`, section
**Plan 1 Task 3**. Fill a row only from a run you actually performed.

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

## Reconnect

| Path | Feishu client version | macOS version | Permissions granted | Consecutive clean runs (of 4) | Result | Redacted evidence hash | Measured on |
|---|---|---|---|---|---|---|---|
| Media reconnect after a network drop (bridge stays up) | | | | | | | |

## Column rules

- **Feishu client version** — the exact build string from the client's About
  panel, not "latest".
- **macOS version** — `sw_vers -productVersion` plus the build, e.g. `26.0 (25A000)`.
- **Permissions granted** — which of Accessibility / Screen Recording /
  Microphone were on for the bridge process during the run. Note any that were
  granted but unused.
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
