# Mac bridge language decision: Swift confirmation or Rust re-spike

**Nothing in this file has been decided yet.** This is a template: seven rows,
each naming what must be measured, how to measure it, and the threshold it is
judged against. Every result cell is empty on purpose. The Swift bridge
(`bridges/mac/`) has been built and unit-tested against synthetic
accessibility trees and a synthetic media loopback only — see
`bridges/mac/README.md` — and none of the seven criteria below can be scored
from that. Every one of them needs a real Feishu client and a real meeting.
Filling this file in is a human-gated step; the exact procedure lives in
`docs/HUMAN-CHECKLIST.md`, section **Plan 1 Task 5**.

## Decision rule (verbatim from the Task 5 brief)

> Swift is confirmed if every criterion passes. If one fails, record the
> failing criterion and open a separate, explicitly scoped Rust re-spike task
> against the same fixture/replay suite; do not switch language from taste.

That is the whole rule. There is no partial-credit reading of it: one failing
criterion is enough to stop and open the re-spike task, and a re-spike is
scoped against the same `spikes/feishu/` fixture/replay suite this package
already has, not started from a blank slate. Nothing below implies which way
this goes.

## Criteria

| # | Criterion | What is measured | How to measure it | Pass threshold | Result |
|---|---|---|---|---|---|
| 1 | Feishu UI access | Whether the accessibility tree exposes stable identifiers for every control `FeishuClientAdapter` looks for (join field, join button, meeting window, leave/leave-confirm, chat toggle/input/send, participants panel, speaker grid), per `docs/HUMAN-CHECKLIST.md` section 3.0a | Capture real `AXIdentifier`/`AXRole`/`AXTitle` values with Accessibility Inspector against a real client and a real joined meeting; replace the placeholders in `bridges/mac/Sources/FeishuBridgeSpike/LocalizedLabels.swift`; re-run `cd bridges/mac && swift test` | Every listed control is reachable by a stable `AXIdentifier`, or, failing that, a localized title that does not change release to release (brief states no numeric threshold; a control reachable only by a title that changes is a fragility to record, not by itself a fail — human judgment applies) | |
| 2 | System audio capture without an unsupported workaround | Whether a real `AudioDevicePort` can capture meeting audio and drive `AudioBridge.captureFrame` using only public macOS APIs (no kernel extension, no virtual audio driver requiring a reboot or an unsigned installer, no undocumented private framework) | Build the real `AudioDevicePort` per `docs/HUMAN-CHECKLIST.md` section 4.0 item 2, using the Microphone permission and public capture/render units only; confirm frames flow into `AudioBridge` in a real meeting | Capture works end to end with only public, App-Store-eligible or notarizable APIs — no unsupported workaround | |
| 3 | Crash recovery | What happens to the meeting session, the coordinator's lease, and the evidence stream when the bridge process crashes or is force-quit mid-meeting | Force-kill the bridge process during a real joined meeting (at least once during steady state, once mid-media); observe whether the coordinator detects the loss, whether `reconnect after force-closing the bridge` (matrix join path 5) recovers cleanly, and what the JSONL evidence shows at the crash boundary | Brief states no numeric threshold; judged against the same four-consecutive-clean-runs gate the reconnect path in `feishu-client-matrix.md` already uses | |
| 4 | Binary distribution | Whether the built bridge can be shipped and launched on a machine that is not the build machine (code signing, notarization, Gatekeeper, and any entitlement the Accessibility/Screen Recording/Microphone permissions require) | Build a release binary from `bridges/mac/Package.swift`, sign and notarize it, copy it to a second Mac, and confirm it launches and can be granted the three permissions without Xcode present | Runs and is grantable on a clean, non-development Mac | |
| 5 | Permission UX | What the user sees when granting Accessibility, Screen Recording, and Microphone to the bridge, and whether the flow is a one-time grant or re-prompts | Walk through a fresh permission grant on a clean user account for all three permissions; note prompt text, System Settings navigation depth, and whether a permission silently revokes on an OS update or app rename | Brief states no numeric threshold; record what a first-time operator experiences | |
| 6 | CPU use | Steady-state and peak CPU percentage of the bridge process during an active meeting with duplex media running | `top -pid $(pgrep -f FeishuBridgeSpike | head -1) -l 10 -stats pid,cpu -s 30` (or Activity Monitor) sampled during the one-hour two-participant run from Task 4 — same command as `docs/HUMAN-CHECKLIST.md` section 5.1's criterion 6, so results from the two documents are comparable | Brief states no numeric threshold; record steady-state and peak so a future comparison against a Rust re-spike has a number to compare against | |
| 7 | Testability | Whether the criteria above can be exercised by an automated or scripted check versus requiring a human to watch the screen each time | Review, for each of criteria 1-6, whether the check that was actually run could be re-run unattended (e.g. `swift test`, a scripted permission check) or needed a human present | Brief states no numeric threshold; record which criteria are scriptable and which are not, since that shapes how expensive a future re-run or a Rust comparison is | |

## Decision block — unfilled

**Decided by:** Chris (not yet decided).

**Decision:** _(empty — Swift confirmed / Rust re-spike triggered, to be filled
in only after all seven rows above carry a result)_

**Evidence required before this block may be filled:** a result for every row
above, each traceable to a run actually performed (client version, macOS
version, and either a redacted evidence hash or a note of what was observed,
matching the evidence conventions in `feishu-client-matrix.md`). A row left at
`not tested` blocks a `confirmed` decision the same way one failing criterion
does — the rule above is "every criterion passes", not "every criterion that
was checked passes".

**If Swift fails one or more criteria:** the failing criterion goes here, and
a separate, explicitly scoped Rust re-spike task is opened against the same
`spikes/feishu/` fixture/replay suite that already defines the platform-neutral
contract and ambiguity policy (`spikes/feishu/src/reducer.ts`,
`spikes/feishu/src/replay.ts`, `spikes/feishu/fixtures/observations/`). The
re-spike task is scoped to whichever criteria failed — it does not restart the
whole evaluation, and it is opened because of a measured failure, never
because of a language preference.

## What is already done, independent of this decision

`bridge-session/v1` — both commands and observations — is frozen already, and
that freeze does not depend on which language implementation this document
eventually confirms. The normative definitions are:

- `protocols/bridge-session-v1.schema.json` — the JSON Schema contract.
- `fixtures/contracts/bridge-session-v1.json` — the frozen fixture that
  round-trips against it (see `bridges/mac/Tests/FeishuBridgeSpikeTests/BridgeContractTests.swift`
  and `spikes/feishu/test/protocol.test.ts`, which both validate against the
  same bytes).

Whichever language wins the decision above implements this same frozen wire
contract; it does not redefine it.
