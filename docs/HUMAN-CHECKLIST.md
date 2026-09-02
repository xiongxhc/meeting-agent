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
